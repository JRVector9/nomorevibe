/**
 * 온라인 인덱스 도구(2026-11-21 전수 점검 W0-3) — 마이그레이션 파일의 `CREATE INDEX IF NOT EXISTS …` 문을 **트랜잭션 밖에서**
 * `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` 로 하나씩 만든다. 마이그레이터는 밀린 마이그레이션을 한 트랜잭션으로 돌려 CONCURRENTLY 를 쓸 수 없고,
 * 보통 CREATE INDEX 는 빌드 내내 그 표의 쓰기를 막는다. 인덱스 정의의 원천은 마이그레이션 SQL 한 곳이다 — 이 도구는 그 문장에 CONCURRENTLY 만 끼운다.
 * 운영 순서: ① 이 도구(plan → execute) ② 그 뒤 migrate(이미 있는 인덱스는 건드리지 않고 기록만). DROP INDEX 는 다루지 않는다.
 *
 * DB 주소는 stdin 으로만 받는다(인자·환경변수·출력에 남기지 않는다). PgBouncer(transaction 모드)가 아닌 **직접 연결** 주소여야 한다 —
 * 세션 설정과 세션 잠금이 빌드 내내 같은 연결에 있어야 한다. 출력은 JSON 한 줄씩이다(주소·SQL 값 없음).
 *
 *   <url> | node --import tsx scripts/ops/online-index.ts drizzle/0192_online_missing_indexes.sql            # plan: 있음·유효·정의·표 크기·어림 크기
 *   <url> | node --import tsx scripts/ops/online-index.ts drizzle/0192_online_missing_indexes.sql --execute  # 없는 것만 만든다(몇 번을 돌려도 같다)
 *   공통: [--only <인덱스 이름>] [--lock-timeout-ms 3000] [--lock-retries 5] [--wait-timeout-ms 1800000] [--progress-ms 5000]
 *
 * 안전 장치
 * - 세션 statement_timeout = 0(연결 시작 값으로 건다 — 이 값을 거절하는 풀러 뒤에서는 연결부터 실패한다). 같은 도구 둘이 함께 돌지 않게 세션 잠금 하나를 쥔다.
 * - 만들기 전에 표 잠금(SHARE UPDATE EXCLUSIVE)이 비어 있는지 짧은 lock_timeout 으로 찔러 본다. 다른 DDL·VACUUM 이 쥐고 있으면 물러났다가 몇 번 다시 본다.
 *   자동 vacuum 은 1초(deadlock_timeout) 뒤 스스로 물러나므로 --lock-timeout-ms 는 1초보다 길게 둔다.
 * - 빌드 문장의 lock_timeout 은 따로 길게 둔다(--wait-timeout-ms, 0 = 한없이). CONCURRENTLY 는 빌드 앞뒤로 「그 표를 쓰던 트랜잭션」과 「옛 스냅숏」이
 *   끝나기를 기다리는데, 그 기다림에도 lock_timeout 이 걸린다(실측). 짧게 두면 표를 다 읽은 뒤에 INVALID 인덱스만 남기고 실패한다.
 *   기다리는 동안 이 세션이 막는 것은 그 표의 다른 DDL·VACUUM 뿐이다(읽기·쓰기는 그대로). 누구를 기다리는지는 progress 줄의 lockerPid 로 본다.
 * - 만들기 전후로 pg_index.indisvalid·indisready 를 본다. 실패로 남은 INVALID 인덱스는 DROP INDEX CONCURRENTLY 로 치우고 한 번만 다시 만든다.
 *   다른 세션이 지금 만들고 있는 인덱스는 건드리지 않는다. 치우기도 열린 트랜잭션을 기다리므로, 기다림 한도를 넘긴 바로 그 트랜잭션이 아직 열려 있으면
 *   치우지 못하고 invalid_index_left 로 보고한다 — 그 트랜잭션이 끝난 뒤 다시 돌리면 치우고 만든다(INVALID 인덱스는 읽기에 쓰이지 않는다).
 * - SIGINT·SIGTERM: 도는 빌드를 취소하고 남은 INVALID 인덱스를 치운 뒤 끝난다(다음 인덱스로 넘어가지 않는다).
 * - 이름이 같은 유효한 인덱스가 이미 있으면 정의를 마이그레이션 문과 대조한다(빈 임시 표에 같은 문을 만들어 pg_get_indexdef 를 비교). 다르면 멈추고 보고한다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export type IndexStatement = {
  index: string;
  table: string;
  unique: boolean;
  /** 마이그레이션에 적힌 문장 그대로(끝의 ; 제외) */
  statement: string;
  /** 표 이름 뒤 — USING·열 목록·WHERE */
  definition: string;
  /** 부분 인덱스의 술어(없으면 null) */
  predicate: string | null;
  /** 열 목록의 항목(식 포함, 정렬 방향 제외) */
  keys: string[];
};
export type OnlineIndexOptions = {
  file: string; execute: boolean; only: string | null; lockTimeoutMs: number; lockRetries: number; waitTimeoutMs: number; progressMs: number;
};
export type OnlineIndexStatus = "present" | "would_create" | "would_rebuild_invalid" | "built" | "skipped"
  | "definition_differs" | "name_taken" | "table_missing" | "build_in_progress" | "lock_unavailable" | "failed" | "interrupted";
export type OnlineIndexResult = { index: string; table: string; status: OnlineIndexStatus; reason?: string; attempts?: number; ms?: number };
export type OnlineIndexReport = (event: string, fields: Record<string, unknown>) => void;
export type OnlineIndexConnection = { session: postgres.Sql; monitor: postgres.Sql; close: () => Promise<void> };

const IDENT = /^[a-z_][a-z0-9_]*$/;
const SESSION_LOCK = "nmv-online-index";
const PROBE = "nmv_online_index_probe";
const OK: ReadonlySet<OnlineIndexStatus> = new Set(["present", "would_create", "would_rebuild_invalid", "built", "skipped"]);

function usage(message: string): never {
  console.error(JSON.stringify({ error: "usage", message }));
  process.exit(2);
}

/** `--` 주석을 뗀다(작은따옴표 글자 안의 -- 는 둔다). drizzle 의 문장 구분 표식도 주석이라 함께 빠진다 */
function stripComments(text: string): string {
  let out = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "'") quoted = !quoted;
    if (!quoted && char === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

/** 괄호·따옴표 밖(깊이 0)의 글자 위치에서만 찾는다 */
function topLevel(text: string, visit: (index: number, depth: number) => boolean | void): void {
  let depth = 0, quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (visit(i, depth)) return;
  }
}

function definitionParts(definition: string): { predicate: string | null; keys: string[] } {
  let open = -1, close = -1, where = -1;
  topLevel(definition, (i, depth) => {
    if (open < 0 && definition[i] === "(" && depth === 1) open = i;
    else if (open >= 0 && close < 0 && definition[i] === ")" && depth === 0) close = i;
    else if (close >= 0 && depth === 0 && /^where\s/i.test(definition.slice(i, i + 6)) && /\s/.test(definition[i - 1] ?? " ")) { where = i; return true; }
  });
  if (open < 0 || close < 0) throw new Error("online_index_definition_unreadable");
  const list = definition.slice(open + 1, close), keys: string[] = [];
  let start = 0;
  topLevel(list, (i, depth) => { if (list[i] === "," && depth === 0) { keys.push(list.slice(start, i)); start = i + 1; } });
  keys.push(list.slice(start));
  return {
    predicate: where < 0 ? null : definition.slice(where + 5).trim(),
    keys: keys.map((key) => key.trim().replace(/\s+(asc|desc)\b/i, "").replace(/\s+nulls\s+(first|last)\b/i, "").trim()),
  };
}

/**
 * 마이그레이션 SQL 에서 `CREATE [UNIQUE] INDEX IF NOT EXISTS 이름 ON 표 …;` 를 뽑는다(DO 블록 안에 있어도 된다).
 * 이 모양이 아닌 CREATE INDEX(CONCURRENTLY 가 이미 붙었거나 IF NOT EXISTS 가 없거나 스키마 이름을 붙인 것)가 하나라도 있으면 거절한다 —
 * 조용히 건너뛰면 그 인덱스는 migrate 가 쓰기를 막으며 만든다.
 */
export function parseIndexStatements(sqlText: string): IndexStatement[] {
  const text = stripComments(sqlText), found: IndexStatement[] = [];
  const pattern = /\bCREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s+ON\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*((?:USING\s|\()[^;]*);/gi;
  for (const match of text.matchAll(pattern)) {
    const [whole, unique, index, table, rest] = match;
    if (!IDENT.test(index) || !IDENT.test(table)) throw new Error("online_index_identifier_unsupported");
    if (/\$\$|\$[A-Za-z_]*\$/.test(rest)) throw new Error("online_index_definition_unreadable");
    const definition = rest.trim().replace(/\s+/g, " ");
    found.push({ index, table, unique: Boolean(unique), statement: whole.slice(0, -1).trim().replace(/\s+/g, " "), definition, ...definitionParts(definition) });
  }
  const all = text.match(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/gi)?.length ?? 0;
  if (all !== found.length) throw new Error("online_index_unsupported_create_index");
  if (new Set(found.map((item) => item.index)).size !== found.length) throw new Error("online_index_duplicate_name");
  return found;
}

/** 운영 문장: 마이그레이션 문장에 CONCURRENTLY 만 끼운다 */
export function concurrentStatement(statement: IndexStatement): string {
  return statement.statement.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_all, unique: string | undefined) => `CREATE ${unique ? "UNIQUE " : ""}INDEX CONCURRENTLY `);
}

export function parseOnlineIndexOptions(argv: readonly string[]): OnlineIndexOptions {
  const options: OnlineIndexOptions = { file: "", execute: false, only: null, lockTimeoutMs: 3000, lockRetries: 5, waitTimeoutMs: 1_800_000, progressMs: 5000 };
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
      const name = argv[++i];
      if (!name || !IDENT.test(name)) usage("--only needs an index name");
      options.only = name;
    } else if (arg === "--lock-timeout-ms") options.lockTimeoutMs = integer(argv[++i], "--lock-timeout-ms", 100, 60_000);
    else if (arg === "--lock-retries") options.lockRetries = integer(argv[++i], "--lock-retries", 1, 100);
    else if (arg === "--wait-timeout-ms") options.waitTimeoutMs = integer(argv[++i], "--wait-timeout-ms", 0, 86_400_000);
    else if (arg === "--progress-ms") options.progressMs = integer(argv[++i], "--progress-ms", 200, 600_000);
    else if (arg.startsWith("--")) usage(`unknown argument ${arg}`);
    else if (/^postgres(ql)?:/i.test(arg)) usage("pipe the database URL on stdin, not as an argument");
    else if (options.file) usage("give exactly one migration file");
    else options.file = arg;
  }
  if (!options.file) usage("give the migration file (drizzle/NNNN_name.sql)");
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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code ?? "";
/** 오류는 코드·이름만 — DB 주소나 SQL 값이 섞인 메시지를 찍지 않는다 */
function safeError(error: unknown): string {
  const { code, name, message } = (error ?? {}) as { code?: string; name?: string; message?: string };
  if (code) return /^[0-9A-Z]{5}$/.test(code) ? `db_${code}` : code;
  return message && /^online_index_[a-z_]+$/.test(message) ? message : name ?? "unknown";
}

/**
 * 세션 연결(빌드)과 관찰 연결(진행·취소)을 연다. 시간 제한은 연결 시작 값으로 건다 — transaction 모드 풀러는 모르는 시작 값을 거절하거나
 * 문장마다 다른 서버 연결로 보내므로, 그런 주소로는 연결이 실패하거나 아래 직접 연결 확인에서 멈춘다.
 */
/** 드라이버 타입은 number 지만 보내는 값은 글자여야 한다(아래 주석) */
const NO_LIMIT = "0" as unknown as number;
export function connectOnlineIndex(url: string): OnlineIndexConnection {
  // max_lifetime 0: 드라이버가 30~60분마다 연결을 갈지 않게 — 갈리면 세션 설정과 세션 잠금이 사라진다(갈렸는지는 빌드마다 pid 로 다시 본다)
  const open = (name: string) => postgres(url, { max: 1, prepare: false, idle_timeout: 0, max_lifetime: 0, connect_timeout: 15, onnotice: () => {},
    // 값은 글자 "0" 으로 보낸다 — 드라이버(postgres.js)는 시작 값에서 falsy 를 걸러 내 숫자 0 을 보내지 않는다. 그러면 계정·DB 기본값
    // (운영 앱 계정은 statement_timeout 120초)이 세션에 남아 아래 직접 연결 확인이 plan 부터 online_index_session_changed 로 멈춘다
    connection: { application_name: name, statement_timeout: NO_LIMIT, idle_in_transaction_session_timeout: NO_LIMIT } });
  const session = open("nmv-online-index"), monitor = open("nmv-online-index-monitor");
  return { session, monitor, close: async () => { await Promise.all([session.end({ timeout: 5 }).catch(() => {}), monitor.end({ timeout: 5 }).catch(() => {})]); } };
}

type TableState = { rows: number; heapBytes: number; totalBytes: number };
type IndexState = { isIndex: boolean; sameTable: boolean; valid: boolean; unique: boolean; bytes: number; definition: string; building: boolean };
const usingPart = (definition: string) => definition.slice(definition.indexOf(" USING "));

async function tableState(sql: postgres.Sql, table: string): Promise<TableState | null> {
  const [row] = await sql<{ rows: number; heap: number; total: number }[]>`
    select c.reltuples::float8 as rows, pg_relation_size(c.oid)::float8 as heap, pg_total_relation_size(c.oid)::float8 as total
    from pg_class c where c.oid = to_regclass(${table}) and c.relkind in ('r', 'p', 'm')`;
  return row ? { rows: row.rows, heapBytes: row.heap, totalBytes: row.total } : null;
}

/** 이 이름을 가진 것의 지금 모습. 없으면 null. building 은 다른 세션이 지금 그 인덱스를 만들거나 다시 만드는 중이라는 뜻이다 */
async function indexState(sql: postgres.Sql, target: IndexStatement): Promise<IndexState | null> {
  const [row] = await sql<{ is_index: boolean; same_table: boolean; valid: boolean; uniq: boolean; bytes: number; definition: string; building: boolean }[]>`
    select i.indexrelid is not null as is_index, coalesce(i.indrelid = to_regclass(${target.table}), false) as same_table,
      coalesce(i.indisvalid and i.indisready and i.indislive, false) as valid, coalesce(i.indisunique, false) as uniq,
      coalesce(pg_relation_size(i.indexrelid), 0)::float8 as bytes, coalesce(pg_get_indexdef(i.indexrelid), '') as definition,
      exists (select 1 from pg_stat_progress_create_index p where p.index_relid = n.oid and p.pid <> pg_backend_pid()) as building
    from (select to_regclass(${target.index}) as oid) n left join pg_index i on i.indexrelid = n.oid
    where n.oid is not null`;
  return row ? { isIndex: row.is_index, sameTable: row.same_table, valid: row.valid, unique: row.uniq, bytes: row.bytes,
    definition: row.definition, building: row.building } : null;
}

class ProbeDone extends Error {}

/**
 * 마이그레이션 문장이 이 표에 만들 인덱스의 정의(pg_get_indexdef 의 USING 뒤). 빈 임시 표(LIKE)에 같은 문을 만들어 읽고 되돌린다 —
 * 운영 표에는 ACCESS SHARE 만 잠깐 건다. 읽지 못하면 null(대조하지 않음으로 보고한다).
 */
async function expectedDefinition(sql: postgres.Sql, target: IndexStatement, lockTimeoutMs: number): Promise<string | null> {
  let definition: string | null = null;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = ${lockTimeoutMs}`);
      await tx.unsafe(`create temp table ${PROBE} (like "${target.table}" including generated) on commit drop`);
      await tx.unsafe(`create ${target.unique ? "unique " : ""}index ${PROBE}_idx on pg_temp.${PROBE} ${target.definition}`);
      const [row] = await tx<{ definition: string }[]>`select pg_get_indexdef(to_regclass(${`pg_temp.${PROBE}_idx`})) as definition`;
      definition = usingPart(row.definition);
      throw new ProbeDone();
    });
  } catch (error) {
    if (!(error instanceof ProbeDone)) return null;
  }
  return definition;
}

/** 어림: 인덱스에 들어갈 행 수(술어가 있으면 planner 의 추정)와 크기(키 너비는 통계, 식은 32바이트로 본다). 통계가 없으면 null */
async function estimate(sql: postgres.Sql, target: IndexStatement, table: TableState): Promise<{ rows: number | null; bytes: number | null }> {
  if (table.rows < 0) return { rows: null, bytes: null };
  let rows = table.rows;
  try {
    if (target.predicate) {
      const [plan] = await sql.unsafe(`explain (format json) select 1 from "${target.table}" where ${target.predicate}`);
      rows = Math.min(table.rows, Number((plan["QUERY PLAN"] as { Plan: { "Plan Rows": number } }[])[0].Plan["Plan Rows"]));
    }
    const columns = target.keys.map((key) => key.replace(/^"(.*)"$/, "$1")).filter((key) => IDENT.test(key));
    const widths = columns.length ? await sql<{ name: string; width: number }[]>`
      select attname::text as name, avg_width::int as width from pg_stats
      where schemaname = current_schema() and tablename = ${target.table} and attname::text = any(${columns}::text[])` : [];
    const keyBytes = target.keys.reduce((sum, key) => sum + (widths.find((row) => row.name === key.replace(/^"(.*)"$/, "$1"))?.width ?? 32), 0);
    // 항목 = 머리 8 + 키(8바이트 맞춤) + 줄 포인터 4, 잎 페이지 채움 90%
    return { rows: Math.round(rows), bytes: Math.round(rows * (8 + Math.ceil(keyBytes / 8) * 8 + 4) / 0.9) };
  } catch {
    return { rows: Math.round(rows), bytes: null };
  }
}

type Runtime = { connection: OnlineIndexConnection; options: OnlineIndexOptions; report: OnlineIndexReport; pid: number; stopping: () => boolean };

/** 세션 설정과 세션 잠금이 이 연결에 그대로 있는가 — 문장마다 서버 연결이 바뀌는 풀러 뒤이거나 연결이 끊겼다 다시 붙은 것은 아닌지 */
async function assertDirectSession(runtime: Runtime): Promise<void> {
  const [row] = await runtime.connection.session<{ ok: boolean }[]>`
    select pg_backend_pid() = ${runtime.pid} and current_setting('statement_timeout') = '0'
      and exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted) as ok`;
  if (!row?.ok) throw new Error("online_index_session_changed");
}

/** 표의 SHARE UPDATE EXCLUSIVE 가 지금 비어 있는가. 못 잡으면 물러났다가 다시 본다(잡은 잠금은 바로 놓는다) */
async function tableLockFree(runtime: Runtime, target: IndexStatement): Promise<boolean> {
  const { session } = runtime.connection, { lockTimeoutMs, lockRetries } = runtime.options;
  for (let attempt = 1; attempt <= lockRetries; attempt++) {
    try {
      await session.begin(async (tx) => {
        await tx.unsafe(`set local lock_timeout = ${lockTimeoutMs}`);
        await tx.unsafe(`lock table "${target.table}" in share update exclusive mode`);
      });
      return true;
    } catch (error) {
      if (codeOf(error) !== "55P03") throw error;
      runtime.report("lock_wait", { index: target.index, table: target.table, attempt, of: lockRetries });
      if (attempt < lockRetries && !runtime.stopping()) await sleep(Math.min(30_000, 1000 * attempt));
      if (runtime.stopping()) return false;
    }
  }
  return false;
}

/** 빌드 문장 하나를 돌리며 진행을 찍는다. 문장의 오류(있으면)를 돌려준다 */
async function runWithProgress(runtime: Runtime, target: IndexStatement, statement: string): Promise<unknown> {
  const { session, monitor } = runtime.connection;
  let done = false, cancelled = false, failure: unknown = null;
  const build = session.unsafe(statement).then(() => {}, (error: unknown) => { failure = error; }).finally(() => { done = true; });
  while (!done) {
    await Promise.race([build, sleep(runtime.options.progressMs)]);
    if (done) break;
    try {
      if (runtime.stopping() && !cancelled) {
        cancelled = true;
        await monitor`select pg_cancel_backend(${runtime.pid})`;
        continue;
      }
      const [row] = await monitor<{ phase: string; lockers_total: number; lockers_done: number; locker: number | null;
        blocks_total: number; blocks_done: number; tuples_total: number; tuples_done: number }[]>`
        select phase, lockers_total::float8 as lockers_total, lockers_done::float8 as lockers_done, nullif(current_locker_pid, 0)::int as locker,
          blocks_total::float8 as blocks_total, blocks_done::float8 as blocks_done, tuples_total::float8 as tuples_total, tuples_done::float8 as tuples_done
        from pg_stat_progress_create_index where pid = ${runtime.pid}`;
      if (row) runtime.report("progress", { index: target.index, phase: row.phase, lockersDone: row.lockers_done, lockersTotal: row.lockers_total,
        lockerPid: row.locker, blocksDone: row.blocks_done, blocksTotal: row.blocks_total, tuplesDone: row.tuples_done, tuplesTotal: row.tuples_total });
    } catch (error) {
      // 진행 읽기는 곁가지다 — 못 읽어도 빌드는 그대로 둔다
      runtime.report("progress_unavailable", { index: target.index, reason: safeError(error) });
    }
  }
  await build;
  return failure;
}

/** 실패로 남은 INVALID 인덱스를 치운다. 치웠으면 true. 다른 세션이 만드는 중이거나 그새 유효해졌으면 건드리지 않는다 */
async function dropInvalid(runtime: Runtime, target: IndexStatement): Promise<boolean> {
  const { session } = runtime.connection;
  const state = await indexState(session, target);
  if (!state) return true;
  if (!state.isIndex || !state.sameTable || state.valid || state.building) return false;
  await assertDirectSession(runtime);
  try {
    await session.unsafe(`drop index concurrently if exists "${target.index}"`);
  } catch (error) {
    runtime.report("drop_invalid_failed", { index: target.index, reason: safeError(error) });
    return false;
  }
  runtime.report("dropped_invalid", { index: target.index, table: target.table });
  return (await indexState(session, target)) === null;
}

async function build(runtime: Runtime, target: IndexStatement): Promise<OnlineIndexResult> {
  const { session } = runtime.connection, started = Date.now();
  const result = (status: OnlineIndexStatus, attempts: number, reason?: string): OnlineIndexResult =>
    ({ index: target.index, table: target.table, status, attempts, ms: Date.now() - started, ...(reason ? { reason } : {}) });
  // 자동 재시도는 한 번까지: 실패하면 남은 INVALID 를 치우고 한 번 더, 또 실패하면 치운 채로 멈춘다
  for (let attempt = 1; ; attempt++) {
    if (runtime.stopping()) return result("interrupted", attempt - 1);
    if (!(await tableLockFree(runtime, target))) return result(runtime.stopping() ? "interrupted" : "lock_unavailable", attempt - 1);
    await assertDirectSession(runtime);
    runtime.report("build_start", { index: target.index, table: target.table, attempt });
    const failure = await runWithProgress(runtime, target, concurrentStatement(target));
    const state = await indexState(session, target);
    const valid = Boolean(state?.isIndex && state.sameTable && state.valid);
    if (!failure && valid) {
      runtime.report("built", { index: target.index, table: target.table, attempt, indexBytes: state!.bytes, ms: Date.now() - started });
      return result("built", attempt);
    }
    const reason = failure ? safeError(failure) : "invalid_after_build";
    // 문장은 실패했는데 유효한 인덱스가 있다(다른 세션이 만들었다) — 지우지 않고 멈춘다. 다시 돌리면 정의를 대조해 present 로 본다
    if (valid) return result("failed", attempt, `${reason}:valid_index_present`);
    runtime.report("build_failed", { index: target.index, table: target.table, attempt, reason, left: state ? (state.valid ? "valid" : "invalid") : "nothing" });
    const clean = await dropInvalid(runtime, target);
    if (runtime.stopping()) return result("interrupted", attempt, reason);
    if (!clean) return result("failed", attempt, `${reason}:invalid_index_left`);
    if (attempt >= 2) return result("failed", attempt, reason);
  }
}

/**
 * plan 또는 execute. 결과는 인덱스마다 하나씩이며, 전부 멀쩡하면(있음·만듦·만들 예정·건너뜀) ok 다.
 * execute 는 멱등이다 — 이미 유효하게 있는 인덱스는 건드리지 않는다.
 */
export async function runOnlineIndex(connection: OnlineIndexConnection, statements: readonly IndexStatement[], options: OnlineIndexOptions,
  report: OnlineIndexReport, stopping: () => boolean = () => false): Promise<{ ok: boolean; results: OnlineIndexResult[] }> {
  const { session } = connection;
  if (options.only && !statements.some((item) => item.index === options.only)) throw new Error("online_index_only_not_in_file");
  const [{ pid, locked, bytes }] = await session<{ pid: number; locked: boolean; bytes: number }[]>`
    select pg_backend_pid() as pid, pg_try_advisory_lock(hashtextextended(${SESSION_LOCK}, 0)) as locked, pg_database_size(current_database())::float8 as bytes`;
  if (!locked) throw new Error("online_index_already_running");
  const runtime: Runtime = { connection, options, report, pid, stopping };
  const results: OnlineIndexResult[] = [];
  try {
    await session.unsafe(`set lock_timeout = ${options.waitTimeoutMs}`);
    await assertDirectSession(runtime);
    report("start", { mode: options.execute ? "execute" : "plan", indexes: statements.length, only: options.only, databaseBytes: bytes,
      lockTimeoutMs: options.lockTimeoutMs, lockRetries: options.lockRetries, waitTimeoutMs: options.waitTimeoutMs });
    for (const target of statements) {
      const push = (entry: OnlineIndexResult, fields: Record<string, unknown> = {}) => {
        results.push(entry);
        report("index", { ...entry, ...fields });
      };
      const base = { index: target.index, table: target.table };
      if (options.only && options.only !== target.index) { push({ ...base, status: "skipped" }); continue; }
      const table = await tableState(session, target.table);
      if (!table) { push({ ...base, status: "table_missing" }); continue; }
      const sizes = { tableRows: table.rows < 0 ? null : table.rows, tableHeapBytes: table.heapBytes, tableTotalBytes: table.totalBytes };
      const state = await indexState(session, target);
      if (state && (!state.isIndex || !state.sameTable)) { push({ ...base, status: "name_taken" }, sizes); continue; }
      if (state?.building) { push({ ...base, status: "build_in_progress" }, sizes); continue; }
      if (state?.valid) {
        const expected = await expectedDefinition(session, target, options.lockTimeoutMs);
        const same = expected === null ? null : expected === usingPart(state.definition) && state.unique === target.unique;
        push({ ...base, status: same === false ? "definition_differs" : "present" },
          { ...sizes, indexBytes: state.bytes, definition: same === null ? "unchecked" : same ? "same" : "differs" });
        continue;
      }
      const guess = await estimate(session, target, table);
      const planned = { ...sizes, estimatedRows: guess.rows, estimatedIndexBytes: guess.bytes,
        // 빌드 동안: 인덱스 자체 + 정렬 임시 파일 + WAL 이 각각 그만큼까지
        estimatedBuildDiskBytes: guess.bytes === null ? null : guess.bytes * 3 };
      if (!options.execute) { push({ ...base, status: state ? "would_rebuild_invalid" : "would_create" }, planned); continue; }
      report("planned", { ...base, ...planned, invalidRemnant: Boolean(state) });
      if (state && !(await dropInvalid(runtime, target))) { push({ ...base, status: "failed", reason: "invalid_index_left" }, sizes); continue; }
      push(await build(runtime, target), sizes);
      if (stopping()) break;
    }
  } finally {
    await session`select pg_advisory_unlock(hashtextextended(${SESSION_LOCK}, 0))`.catch(() => {});
  }
  const ok = results.every((entry) => OK.has(entry.status)) && !stopping();
  report("done", { mode: options.execute ? "execute" : "plan", ok, ...Object.fromEntries(
    [...new Set(results.map((entry) => entry.status))].map((status) => [status, results.filter((entry) => entry.status === status).length])) });
  return { ok, results };
}

async function main() {
  const options = parseOnlineIndexOptions(process.argv.slice(2));
  let statements: IndexStatement[];
  try {
    statements = parseIndexStatements(readFileSync(resolve(options.file), "utf8"));
  } catch (error) {
    usage(`cannot read index statements from the migration file (${safeError(error)})`);
  }
  if (!statements.length) usage("the migration file has no CREATE INDEX IF NOT EXISTS statement");
  const url = await readDatabaseUrl();
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  const connection = connectOnlineIndex(url);
  try {
    const { ok } = await runOnlineIndex(connection, statements, options, (event, fields) => console.log(JSON.stringify({ event, ...fields })), () => stopping);
    if (!ok) process.exitCode = 1;
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: "failed", reason: safeError(error) }));
    process.exit(1);
  });
}
