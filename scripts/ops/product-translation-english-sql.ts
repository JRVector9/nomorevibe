/**
 * Operator SQL for the en result rules of PR #1019 (english_uncertain re-queue, source_native rollback). Production writes:
 * run only with owner approval, in batches until a run returns no row. Prints SQL; executes nothing.
 *
 *   node --import tsx scripts/ops/product-translation-english-sql.ts requeue --before '<D>' --actor <login> [--limit 2000]
 *   node --import tsx scripts/ops/product-translation-english-sql.ts rollback --since '<D>' [--until '<T>'] --actor <login> [--limit 2000]
 *
 * <D> is the deploy cut-off read from the DATABASE once every product-translate worker runs the new release:
 *   SELECT now()::timestamp;   -- product_translations.updated_at is timestamp WITHOUT time zone; never a local/KST string
 */
import { pathToFileURL } from "node:url";

export type EnglishOpsSqlOptions = { actor: string; limit?: number; audit?: boolean };
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/;
const ACTOR = /^[A-Za-z0-9_.@-]{1,120}$/;

function checked(value: string, name: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`invalid_${name}`);
  return value;
}
function limitOf(limit = 2000): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) throw new Error("invalid_limit");
  return limit;
}
// The live maxAttempts (runtime_settings translation.product, default 4) and the dispatch contract bound of 4 attempts.
const SETTINGS = `settings AS MATERIALIZED (
  SELECT LEAST(GREATEST(COALESCE((SELECT ("values" #>> '{translation,product,maxAttempts}')::int FROM runtime_settings WHERE id = 1), 4), 1), 20) AS max_attempts
)`;
function audited(options: EnglishOpsSqlOptions, action: string, target: string, detail: string): string {
  if (options.audit === false) return "SELECT count(*)::int AS rows FROM updated;";
  return `INSERT INTO operations_audit (actor, action, target, detail, actor_kind)
SELECT '${checked(options.actor, "actor", ACTOR)}', '${action}', '${target}', jsonb_build_object('rows', count(*), ${detail}), 'local'
FROM updated HAVING count(*) > 0
RETURNING (detail->>'rows')::int AS rows;`;
}

/**
 * en rows that failed rejected:english_uncertain under the OLD rule and used up their attempts before the cut-off get one more
 * call: attempts = min(maxAttempts, 4) - 1, the last attempt the selector still dispatches. Rows that fail again after the
 * cut-off (new rule) are out of scope, so repeated runs end. Members held by a live or unknown ledger request are skipped.
 */
export function englishUncertainRequeueSql(options: EnglishOpsSqlOptions & { before: string }): string {
  const before = checked(options.before, "before", TIMESTAMP), limit = limitOf(options.limit);
  return `WITH ${SETTINGS},
busy AS MATERIALIZED (
  SELECT DISTINCT member FROM model_capacity_requests r CROSS JOIN LATERAL unnest(r.logical_member_keys) member
  WHERE r.route_id = 'product-translate' AND r.state IN ('waiting','reserved','dispatched','indeterminate') AND member IS NOT NULL
), target AS (
  SELECT t.product_id, t.locale, t.field FROM product_translations t, settings
  WHERE t.locale = 'en' AND t.status = 'failed' AND t.error_code = 'rejected:english_uncertain'
    AND t.attempts >= LEAST(settings.max_attempts, 4) AND t.updated_at < '${before}'::timestamp
    AND ('product-translate:' || t.product_id || ':' || t.locale || ':' || t.field) NOT IN (SELECT member FROM busy)
  ORDER BY t.product_id, t.field LIMIT ${limit}
  FOR UPDATE OF t SKIP LOCKED
), updated AS (
  UPDATE product_translations t
  SET status = 'pending', attempts = LEAST(settings.max_attempts, 4) - 1, error_code = NULL, retry_at = NULL, updated_at = now()
  FROM target, settings
  WHERE (t.product_id, t.locale, t.field) = (target.product_id, target.locale, target.field)
    AND t.status = 'failed' AND t.error_code = 'rejected:english_uncertain'
  RETURNING t.product_id, t.field, t.attempts
)
${audited(options, "product-translation-english-requeue", "product_translations:en:rejected:english_uncertain",
    `'before', '${before}', 'attempts', max(attempts), 'limit', ${limit}, 'pr', 1019`)}`;
}

/**
 * Undo source_native rows written since the cut-off: back to failed with no text, provenance kind machine, source_locale
 * NULL (Latin sources without shared English evidence detect as NULL) and attempts at the live maxAttempts, so neither
 * the worker nor the admin retry re-requests the same source. error_code source_native_reverted keeps them apart from
 * the english_uncertain re-queue. Public pages fall back to the source with the pending label, as before the deploy.
 */
export function sourceNativeRollbackSql(options: EnglishOpsSqlOptions & { since: string; until?: string }): string {
  const since = checked(options.since, "since", TIMESTAMP), limit = limitOf(options.limit);
  const until = options.until === undefined ? null : checked(options.until, "until", TIMESTAMP);
  return `WITH ${SETTINGS},
target AS (
  SELECT t.product_id, t.locale, t.field FROM product_translations t
  WHERE t.locale = 'en' AND t.status = 'ready' AND t.provenance->>'kind' = 'source_native'
    AND t.updated_at >= '${since}'::timestamp${until ? ` AND t.updated_at < '${until}'::timestamp` : ""}
  ORDER BY t.product_id, t.field LIMIT ${limit}
  FOR UPDATE OF t SKIP LOCKED
), updated AS (
  UPDATE product_translations t
  SET status = 'failed', text = NULL, error_code = 'source_native_reverted', attempts = GREATEST(t.attempts, settings.max_attempts),
    retry_at = NULL, source_locale = NULL, provenance = jsonb_set(t.provenance, '{kind}', '"machine"'), updated_at = now()
  FROM target, settings
  WHERE (t.product_id, t.locale, t.field) = (target.product_id, target.locale, target.field)
    AND t.status = 'ready' AND t.provenance->>'kind' = 'source_native'
  RETURNING t.product_id, t.field
)
${audited(options, "product-translation-source-native-rollback", "product_translations:en:source_native",
    `'since', '${since}', 'until', ${until ? `'${until}'` : "NULL"}, 'limit', ${limit}, 'pr', 1019`)}`;
}

function main(argv: readonly string[]): string {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) throw new Error("usage: requeue|rollback --flag value …");
    flags.set(rest[index].slice(2), rest[index + 1]);
  }
  const actor = flags.get("actor") ?? "", limit = flags.has("limit") ? Number(flags.get("limit")) : undefined;
  if (command === "requeue") return englishUncertainRequeueSql({ before: flags.get("before") ?? "", actor, limit });
  if (command === "rollback") return sourceNativeRollbackSql({ since: flags.get("since") ?? "", until: flags.get("until"), actor, limit });
  throw new Error("usage: requeue|rollback --flag value …");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(main(process.argv.slice(2)));
