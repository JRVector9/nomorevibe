/**
 * og_images(DB 바이트) → 버킷(og/<slug>) 옮기기 — 2026-11-15 운영자 결정(공유 DB 볼륨이 가득 차 3시간 멈춤, 약 9GB).
 *
 * DB 주소는 stdin 으로만 받는다(인자·환경변수·출력에 남기지 않는다). 버킷 자격은 OG_STORE_* 환경변수(lib/storage/og-store.ts).
 * DB 세션은 늘 읽기 전용이다(default_transaction_read_only) — DB 행을 지우지 않는다. 비우고 공간을 돌려받는 일은 따로 승인받는다.
 *
 *   <url> | node --import tsx scripts/ops/og-images-to-object-store.ts --dry-run          # 행 수·바이트만(버킷 자격 없어도 된다)
 *   <url> | node --import tsx scripts/ops/og-images-to-object-store.ts [--limit N] [--from-slug S] [--batch 200] [--concurrency 4] [--sleep-ms 500]
 *   <url> | node --import tsx scripts/ops/og-images-to-object-store.ts --verify [--sample 100 | --from-slug S --limit N]
 *
 * 복사: slug 순서 keyset(--from-slug 는 그 slug 다음부터 — 줄마다 찍는 lastSlug 를 그대로 넣어 이어 간다). 한 묶음씩 읽어 버킷에 HEAD 를 보고,
 * 같은 것(크기·ETag=MD5)은 건너뛰고, 다른 것은 덮지 않는다(앱이 버킷에 새로 쓴 그림이다 — different 로 센다). 없으면 If-None-Match:* 로만 쓴다
 * (HEAD 와 PUT 사이에 앱이 쓴 것도 덮지 않는다). 묶음 뒤에는 방금 쓴 slug 가 아직 DB 에 있는지 다시 보고, 그 사이 내리거나 지워져 사라졌으면
 * 우리가 쓴 그대로(ETag 같음)일 때만 버킷에서 지운다(내린 그림을 되살리지 않게).
 * 출력은 수·바이트·slug 커서뿐이다. 실패가 이어지면(연속 20건) 멈추고 커서를 찍는다.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { createOgObjectStore, ogStoreConfig, ogStoreMissingKeys, OgStoreError, OG_STORE_MAX_BYTES, type OgObjectStore } from "@/lib/storage/og-store";

type Mode = "dry-run" | "copy" | "verify";
type Options = { mode: Mode; limit: number | null; fromSlug: string; batch: number; concurrency: number; sleepMs: number; sample: number };
type Row = { slug: string; content_type: string; data: Buffer };

const SLUG = /^[a-z0-9-]{1,80}$/;
const MAX_CONSECUTIVE_FAILURES = 20;

function usage(message: string): never {
  console.error(JSON.stringify({ error: "usage", message }));
  process.exit(2);
}

function parseOptions(argv: string[]): Options {
  const options: Options = { mode: "copy", limit: null, fromSlug: "", batch: 200, concurrency: 4, sleepMs: 500, sample: 100 };
  const integer = (value: string | undefined, name: string, min: number, max: number) => {
    const number = Number(value);
    if (!value || !Number.isInteger(number) || number < min || number > max) usage(`${name} must be an integer in [${min}, ${max}]`);
    return number;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") options.mode = options.mode === "verify" ? usage("--dry-run and --verify are exclusive") : "dry-run";
    else if (arg === "--verify") options.mode = options.mode === "dry-run" ? usage("--dry-run and --verify are exclusive") : "verify";
    else if (arg === "--limit") options.limit = integer(argv[++i], "--limit", 1, 10_000_000);
    else if (arg === "--from-slug") {
      const slug = argv[++i];
      if (!slug || slug.length > 80) usage("--from-slug needs a slug");
      options.fromSlug = slug;
    } else if (arg === "--batch") options.batch = integer(argv[++i], "--batch", 1, 1000);
    else if (arg === "--concurrency") options.concurrency = integer(argv[++i], "--concurrency", 1, 4);
    else if (arg === "--sleep-ms") options.sleepMs = integer(argv[++i], "--sleep-ms", 0, 60_000);
    else if (arg === "--sample") options.sample = integer(argv[++i], "--sample", 1, 10_000);
    else usage(`unknown argument ${arg}`);
  }
  return options;
}

async function readDatabaseUrl(): Promise<string> {
  if (process.stdin.isTTY) usage("pipe the database URL on stdin");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 4096) usage("database URL too long");
  }
  const url = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^postgres(ql)?:\/\//.test(url)) usage("stdin is not a postgres URL");
  return url;
}

const print = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));
const md5 = (data: Buffer) => createHash("md5").update(data).digest("hex");
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 오류는 이름·코드만 — DB 주소·자격이 섞인 메시지를 찍지 않는다 */
function safeError(error: unknown): string {
  if (error instanceof OgStoreError) return error.message;
  const { code, name } = (error ?? {}) as { code?: string; name?: string };
  return code ? `db_${code}` : name ?? "unknown";
}

/** 한 묶음을 concurrency 개 일꾼으로 */
async function pool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

let stopping = false;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

async function dryRun(sql: postgres.Sql, options: Options) {
  const started = Date.now();
  let cursor = options.fromSlug;
  let rows = 0, bytes = 0, maxBytes = 0, invalidSlug = 0, tooLarge = 0;
  const byType: Record<string, { rows: number; bytes: number }> = {};
  const metaBatch = Math.max(options.batch, 1000);
  for (;;) {
    const remaining = options.limit === null ? metaBatch : Math.min(metaBatch, options.limit - rows);
    if (remaining <= 0 || stopping) break;
    // octet_length 는 TOAST 를 풀지 않는다(바이트를 읽지 않는다)
    const page = await sql<{ slug: string; content_type: string; size: string }[]>`
      select slug, content_type, octet_length(data)::bigint as size from og_images
      where slug > ${cursor} order by slug limit ${remaining}`;
    if (page.length === 0) break;
    for (const row of page) {
      const size = Number(row.size);
      rows += 1;
      bytes += size;
      maxBytes = Math.max(maxBytes, size);
      if (!SLUG.test(row.slug)) invalidSlug += 1;
      if (size > OG_STORE_MAX_BYTES || size === 0) tooLarge += 1;
      const type = byType[row.content_type] ??= { rows: 0, bytes: 0 };
      type.rows += 1;
      type.bytes += size;
    }
    cursor = page[page.length - 1].slug;
  }
  const [table] = await sql<{ total: string; relation: string }[]>`
    select pg_total_relation_size('og_images')::bigint as total, pg_relation_size('og_images')::bigint as relation`;
  print("dry_run", { rows, bytes, maxBytes, avgBytes: rows ? Math.round(bytes / rows) : 0, invalidSlug, tooLargeOrEmpty: tooLarge, byType,
    tableTotalBytes: Number(table.total), tableHeapBytes: Number(table.relation), lastSlug: cursor, elapsedMs: Date.now() - started,
    batches: Math.ceil(rows / options.batch) });
}

async function copy(sql: postgres.Sql, store: OgObjectStore, options: Options): Promise<number> {
  const started = Date.now();
  let cursor = options.fromSlug;
  const total = { rows: 0, copied: 0, same: 0, different: 0, raced: 0, failed: 0, invalid: 0, vanishedDeleted: 0, vanishedKept: 0, bytes: 0 };
  let consecutiveFailures = 0;
  for (let batch = 1; !stopping; batch++) {
    const remaining = options.limit === null ? options.batch : Math.min(options.batch, options.limit - total.rows);
    if (remaining <= 0) break;
    const batchStarted = Date.now();
    const rows = await sql<Row[]>`select slug, content_type, data from og_images where slug > ${cursor} order by slug limit ${remaining}`;
    if (rows.length === 0) break;
    const count = { copied: 0, same: 0, different: 0, raced: 0, failed: 0, invalid: 0, vanishedDeleted: 0, vanishedKept: 0, bytes: 0 };
    const written = new Map<string, string>();
    let lastError: string | null = null;
    await pool(rows, options.concurrency, async (row) => {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
      const data = Buffer.from(row.data);
      if (!SLUG.test(row.slug) || data.length === 0 || data.length > OG_STORE_MAX_BYTES) {
        count.invalid += 1;
        return;
      }
      try {
        const head = await store.head(row.slug);
        const hash = md5(data);
        if (head) {
          if (head.size === data.length && head.etag === hash) count.same += 1;
          else count.different += 1;
        } else if (await store.put(row.slug, { data, contentType: row.content_type }, { ifAbsent: true }) === "stored") {
          count.copied += 1;
          count.bytes += data.length;
          written.set(row.slug, hash);
        } else {
          count.raced += 1;
        }
        consecutiveFailures = 0;
      } catch (error) {
        count.failed += 1;
        consecutiveFailures += 1;
        lastError = safeError(error);
      }
    });
    // 그 사이 내리거나 지워진 것(DB 행이 사라짐)을 되살리지 않는다 — 우리가 쓴 그대로일 때만 지운다(앱이 새로 쓴 것은 ETag 가 다르다)
    if (written.size) {
      const present = new Set((await sql<{ slug: string }[]>`select slug from og_images where slug = any(${[...written.keys()]})`).map((row) => row.slug));
      for (const [slug, hash] of written) {
        if (present.has(slug)) continue;
        try {
          const head = await store.head(slug);
          if (head?.etag === hash) {
            await store.delete(slug);
            count.vanishedDeleted += 1;
          } else count.vanishedKept += 1;
        } catch (error) {
          count.failed += 1;
          lastError = safeError(error);
        }
      }
    }
    total.rows += rows.length;
    for (const key of Object.keys(count) as (keyof typeof count)[]) total[key] += count[key];
    const aborted = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    // 멈출 때는 이 묶음을 처음부터 다시 하도록 앞 커서를 남긴다(같은 것은 HEAD 로 건너뛴다)
    if (!aborted) cursor = rows[rows.length - 1].slug;
    print("batch", { batch, rows: rows.length, ...count, lastError, lastSlug: cursor, elapsedMs: Date.now() - batchStarted });
    if (aborted) {
      print("aborted", { reason: "consecutive_failures", consecutiveFailures, resumeFromSlug: cursor });
      break;
    }
    if (rows.length < remaining) break;
    if (options.sleepMs) await sleep(options.sleepMs);
  }
  const elapsedMs = Date.now() - started;
  print("copy_done", { ...total, lastSlug: cursor, elapsedMs, bytesPerSecond: elapsedMs ? Math.round(total.bytes / (elapsedMs / 1000)) : null,
    stopped: stopping });
  return total.failed;
}

async function verify(sql: postgres.Sql, store: OgObjectStore, options: Options): Promise<number> {
  const started = Date.now();
  const ranged = options.fromSlug !== "" || options.limit !== null;
  const slugs = ranged
    ? (await sql<{ slug: string }[]>`select slug from og_images where slug > ${options.fromSlug} order by slug limit ${options.limit ?? options.sample}`)
    : (await sql<{ slug: string }[]>`select slug from og_images order by random() limit ${options.sample}`);
  const count = { checked: 0, match: 0, mismatch: 0, missingInStore: 0, goneFromDb: 0, failed: 0 };
  let lastError: string | null = null;
  await pool(slugs.map((row) => row.slug), Math.min(options.concurrency, 4), async (slug) => {
    try {
      const [row] = await sql<Row[]>`select slug, content_type, data from og_images where slug = ${slug}`;
      if (!row) {
        count.goneFromDb += 1;
        return;
      }
      count.checked += 1;
      const object = await store.get(slug);
      if (!object) count.missingInStore += 1;
      else if (sha256(object.data) === sha256(Buffer.from(row.data)) && object.contentType === row.content_type) count.match += 1;
      else count.mismatch += 1;
    } catch (error) {
      count.failed += 1;
      lastError = safeError(error);
    }
  });
  print("verify", { mode: ranged ? "range" : "random", sampled: slugs.length, ...count, lastError,
    lastSlug: ranged ? slugs.at(-1)?.slug ?? null : null, elapsedMs: Date.now() - started });
  return count.mismatch + count.failed;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  let store: OgObjectStore | null = null;
  if (options.mode !== "dry-run") {
    const config = ogStoreConfig();
    if (!config) usage(`OG_STORE_* missing or invalid (missing: ${ogStoreMissingKeys().join(",") || "none"})`);
    store = createOgObjectStore(config);
  }
  const url = await readDatabaseUrl();
  // 읽기 전용 세션 — 이 스크립트는 DB 에 쓰지 않는다. 바이트를 읽는 묶음 하나가 60초를 넘지 않게
  const sql = postgres(url, {
    max: 1, prepare: false, idle_timeout: 10, connect_timeout: 15, onnotice: () => {},
    connection: { application_name: "nmv-og-to-object-store", default_transaction_read_only: true, statement_timeout: 60_000 },
  });
  let failures = 0;
  try {
    print("start", { mode: options.mode, limit: options.limit, fromSlug: options.fromSlug || null, batch: options.batch,
      concurrency: options.concurrency, sleepMs: options.sleepMs });
    if (options.mode === "dry-run") await dryRun(sql, options);
    else if (options.mode === "copy") failures = await copy(sql, store!, options);
    else failures = await verify(sql, store!, options);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  if (failures) process.exitCode = 3;
}

main().catch((error) => {
  console.error(JSON.stringify({ error: "failed", reason: safeError(error) }));
  process.exit(1);
});
