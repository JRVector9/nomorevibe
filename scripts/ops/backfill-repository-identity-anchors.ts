/**
 * 저장소 id 근거 백필(0191, 2026-11-21 전수 점검 W0-1) — 지금 세 출처에 남아 있는 저장소 id 를 근거 표(repository_identity_anchors)로 옮긴다.
 * 0191 의 트리거는 그 뒤에 생기거나 바뀌는 값만 남긴다. 그 전에 있던 값은 이 스크립트가 한 번 옮긴다(운영 실행은 소유자 승인 뒤).
 *
 * DB 주소는 stdin 으로만 받는다(인자·환경변수·출력에 남기지 않는다). 출력은 수·커서·걸린 시간뿐이다.
 *
 *   <url> | node --import tsx scripts/ops/backfill-repository-identity-anchors.ts            # 세기만(읽기 전용) — 옮길 근거 수(missing)
 *   <url> | node --import tsx scripts/ops/backfill-repository-identity-anchors.ts --execute  # 옮긴다
 *   공통: [--only crawl|evidence|stars] [--from N] [--span 5000] [--max-batches N] [--sleep-ms 100] [--no-crawl-node-id]
 *
 * 출처마다 id 범위 묶음으로 읽는다 — crawl(crawl_documents.id), evidence(product_evidence_sources.id, kind = 'repository'), stars(관측 run_id 하나씩).
 * 묶음 하나가 짧은 트랜잭션 하나다(statement_timeout 60초 · lock_timeout 5초). 값 검증·넣는 차례·겹침 처리는 트리거와 같은 DB 함수
 * (nmv_record_repository_identity_anchors)가 한다 — 이미 있는 근거는 건너뛰므로 몇 번을 돌려도, 트리거가 도는 중에 돌려도 같다.
 * 끊기면 줄마다 찍는 cursor 를 --only <출처> --from <cursor> 로 넣어 이어 한다(처음부터 다시 돌려도 된다).
 * 세기 모드는 옮길 때와 같은 행을 읽으므로 --max-batches 로 몇 묶음만 세어 보면 묶음당 시간으로 전체 시간을 어림할 수 있다.
 * 다 옮긴 뒤 세기 모드를 다시 돌려 missing 이 0 인지 본다.
 * --no-crawl-node-id: 수집 원본에서는 숫자 id 만 옮긴다(근거 행이 절반). 원본의 node_id 는 같은 저장소의 숫자 id 와 한 쌍이고 원본 행에 그대로 있다 —
 * 그 값이 덮이거나 지워질 때는 트리거가 남긴다. 디스크가 빠듯할 때만 쓴다.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const SOURCES = ["crawl", "evidence", "stars"] as const;
type Source = (typeof SOURCES)[number];
type Options = { execute: boolean; only: Source | null; from: number; span: number; maxBatches: number | null; sleepMs: number; crawlNodeIds: boolean };
type Tx = postgres.TransactionSql;
type Batch = { observed: number; anchors: number; missing: number; added: number };

const RETRYABLE = new Set(["40P01", "40001", "55P03"]);

function usage(message: string): never {
  console.error(JSON.stringify({ error: "usage", message }));
  process.exit(2);
}

export function parseBackfillOptions(argv: readonly string[]): Options {
  const options: Options = { execute: false, only: null, from: 0, span: 5000, maxBatches: null, sleepMs: 100, crawlNodeIds: true };
  let fromGiven = false;
  const integer = (value: string | undefined, name: string, min: number, max: number) => {
    const number = Number(value);
    if (!value || !Number.isInteger(number) || number < min || number > max) usage(`${name} must be an integer in [${min}, ${max}]`);
    return number;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--plan") options.execute = false;
    else if (arg === "--only") {
      const source = argv[++i] as Source;
      if (!SOURCES.includes(source)) usage(`--only must be one of ${SOURCES.join("|")}`);
      options.only = source;
    } else if (arg === "--from") { options.from = integer(argv[++i], "--from", 0, 2_147_483_647); fromGiven = true; }
    else if (arg === "--span") options.span = integer(argv[++i], "--span", 1, 100_000);
    else if (arg === "--max-batches") options.maxBatches = integer(argv[++i], "--max-batches", 1, 10_000_000);
    else if (arg === "--sleep-ms") options.sleepMs = integer(argv[++i], "--sleep-ms", 0, 60_000);
    else if (arg === "--no-crawl-node-id") options.crawlNodeIds = false;
    else usage(`unknown argument ${arg}`);
  }
  if (fromGiven && !options.only) usage("--from needs --only (the cursor belongs to one source)");
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
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** 오류는 코드·이름만 — DB 주소가 섞인 메시지를 찍지 않는다 */
function safeError(error: unknown): string {
  const { code, name } = (error ?? {}) as { code?: string; name?: string };
  return code ? `db_${code}` : name ?? "unknown";
}

/**
 * 출처의 한 묶음(after < id <= to)에서 본 (저장소 이름, 근거 종류, 값, 본 시각). 값 검증은 하지 않는다 — DB 함수가 한다.
 * timestamp(시간대 없음) 칸은 UTC 벽시계다
 */
const observed: Record<Source, (tx: Tx, after: number, to: number, options: Options) => postgres.PendingQuery<postgres.Row[]>> = {
  crawl: (tx, after, to, options) => tx`
    select d.repo::text as repo, x.kind, x.value, d.fetched_at at time zone 'UTC' as seen
    from crawl_documents d cross join lateral (values
      ('repo_id', d.repo_meta->>'id'),
      ('node_id', case when ${options.crawlNodeIds}::boolean and jsonb_typeof(d.repo_meta->'node_id') = 'string' then d.repo_meta->>'node_id' end)) as x(kind, value)
    where d.id > ${after} and d.id <= ${to} and x.value is not null`,
  evidence: (tx, after, to) => tx`
    select e.source_key::text as repo, 'repo_id' as kind, e.normalized_facts->>'repositoryId' as value,
      coalesce(e.last_success_at, e.observed_at, e.updated_at) at time zone 'UTC' as seen
    from product_evidence_sources e
    where e.id > ${after} and e.id <= ${to} and e.kind = 'repository' and e.normalized_facts->>'repositoryId' is not null`,
  stars: (tx, after, to) => tx`
    select o.repository_key::text as repo, 'node_id' as kind, o.repository_id::text as value, o.observed_at as seen
    from product_star_observations o
    where o.run_id > ${after} and o.run_id <= ${to} and o.repository_id is not null`,
};
const RECORD_SOURCE: Record<Source, string> = { crawl: "crawl_document", evidence: "evidence_source", stars: "star_observation" };

/** 이 출처의 커서 끝(시작할 때의 최댓값 — 그 뒤에 생기는 행은 트리거가 남긴다) */
async function lastCursor(sql: postgres.Sql, source: Source): Promise<number> {
  const [row] = source === "crawl" ? await sql<{ last: number }[]>`select coalesce(max(id), 0)::int as last from crawl_documents`
    : source === "evidence" ? await sql<{ last: number }[]>`select coalesce(max(id), 0)::int as last from product_evidence_sources`
      : await sql<{ last: number }[]>`select coalesce(max(run_id), 0)::int as last from product_star_observations`;
  return row.last;
}

async function runBatch(sql: postgres.Sql, source: Source, after: number, to: number, options: Options): Promise<Batch> {
  const { execute } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await sql.begin(async (tx) => {
        await tx`set local statement_timeout = '60s'`;
        await tx`set local lock_timeout = '5s'`;
        if (!execute) await tx`set transaction read only`;
        const rows = observed[source](tx, after, to, options);
        if (execute) {
          const [row] = await tx<{ observed: number; added: number }[]>`
            select count(*)::int as observed,
              coalesce(nmv_record_repository_identity_anchors(array_agg(s.repo), array_agg(s.kind), array_agg(s.value), array_agg(s.seen),
                ${RECORD_SOURCE[source]}), 0)::int as added
            from (${rows}) s`;
          return { observed: row.observed, anchors: 0, missing: 0, added: row.added };
        }
        const [row] = await tx<{ observed: number; anchors: number; missing: number }[]>`
          select g.observed, count(r.repo_key)::int as anchors,
            (count(r.repo_key) filter (where not exists (select 1 from repository_identity_anchors a
              where a.repo_key = r.repo_key and a.kind = r.kind and a.value = r.value)))::int as missing
          from (select count(*)::int as observed, array_agg(s.repo) as repos, array_agg(s.kind) as kinds, array_agg(s.value) as vals,
                  array_agg(s.seen) as seen from (${rows}) s) g
            left join lateral nmv_repository_identity_anchor_rows(g.repos, g.kinds, g.vals, g.seen) r on true
          group by g.observed`;
        return { observed: row.observed, anchors: row.anchors, missing: row.missing, added: 0 };
      }) as Batch;
    } catch (error) {
      // 교착·잠금 대기는 다른 쓰기와 잠깐 겹친 것이다 — 묶음은 멱등이라 그대로 다시 한다
      if (attempt >= 4 || !RETRYABLE.has((error as { code?: string }).code ?? "")) throw error;
      await sleep(250 * attempt);
    }
  }
}

let stopping = false;

export async function backfillRepositoryIdentityAnchors(sql: postgres.Sql, options: Options): Promise<void> {
  const started = Date.now();
  let batches = 0;
  for (const source of SOURCES) {
    if (options.only && options.only !== source) continue;
    const last = await lastCursor(sql, source);
    // 스타 관측은 run 하나가 한 묶음이다(run 마다 대상 제품 전부)
    const span = source === "stars" ? 1 : options.span;
    const total: Batch = { observed: 0, anchors: 0, missing: 0, added: 0 };
    let cursor = options.only === source ? options.from : 0;
    let complete = true;
    while (cursor < last) {
      if (stopping || (options.maxBatches !== null && batches >= options.maxBatches)) { complete = false; break; }
      const to = Math.min(cursor + span, last);
      const batchStarted = Date.now();
      const batch = await runBatch(sql, source, cursor, to, options);
      for (const key of ["observed", "anchors", "missing", "added"] as const) total[key] += batch[key];
      batches += 1;
      cursor = to;
      print("batch", { source, cursor, last, observed: batch.observed,
        ...(options.execute ? { added: batch.added } : { anchors: batch.anchors, missing: batch.missing }), ms: Date.now() - batchStarted });
      if (options.sleepMs && cursor < last) await sleep(options.sleepMs);
    }
    print("source", { source, complete, cursor, last, observed: total.observed,
      ...(options.execute ? { added: total.added } : { anchors: total.anchors, missing: total.missing }) });
    if (!complete) break;
  }
  const [table] = await sql<{ rows: number; repos: number; bytes: number }[]>`
    select count(*)::int as rows, count(distinct repo_key)::int as repos, pg_total_relation_size('repository_identity_anchors')::float8 as bytes
    from repository_identity_anchors`;
  print("done", { mode: options.execute ? "execute" : "plan", stopped: stopping, batches, elapsedMs: Date.now() - started,
    anchorRows: table.rows, anchorRepos: table.repos, anchorBytes: table.bytes });
}

async function main() {
  const options = parseBackfillOptions(process.argv.slice(2));
  const url = await readDatabaseUrl();
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  // prepare: false — PgBouncer(transaction 모드) 뒤에서도 돈다. 세션 설정은 묶음 트랜잭션 안에서만 건다(SET LOCAL)
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 10, connect_timeout: 15, onnotice: () => {},
    connection: { application_name: "nmv-repository-identity-anchors-backfill" } });
  try {
    print("start", { mode: options.execute ? "execute" : "plan", only: options.only, from: options.from, span: options.span,
      maxBatches: options.maxBatches, sleepMs: options.sleepMs, crawlNodeIds: options.crawlNodeIds });
    await backfillRepositoryIdentityAnchors(sql, options);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: "failed", reason: safeError(error) }));
    process.exit(1);
  });
}
