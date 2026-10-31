// 장부 control 행(model_capacity_control id=1) 경합 표본 — 운영 DB 를 읽기 전용으로 1분간 샘플링한다.
//   echo "$DATABASE_URL" | node scripts/ops/ledger-lock-sample.mjs [--seconds 60] [--interval-ms 250] [--lines]
// DB 주소는 stdin 으로만 받는다(argv·환경·출력에 쓰지 않는다). 쿼리 본문은 앞 80자만, 값(파라미터)은 읽지 않는다 — drizzle 문장은 $1 자리표시자다.
// 출력(stdout, JSON 한 줄): 표본 수, control 관련 Lock 대기가 있던 표본 비율, 대기 세션 수 분포, 대기 시간(pg_locks.waitstart 기준) p50·p95·max,
// 대기 모드(tuple/transactionid 등)·앱별 횟수, 차단 문장 머리 상위 목록. --lines 는 표본마다 한 줄(stderr)을 더 쓴다.
// 필요한 권한: pg_stat_activity 의 다른 세션 query 는 같은 역할(또는 pg_read_all_stats)만 보인다 — 운영 앱 역할로 실행한다.
import { createInterface } from "node:readline";
import postgres from "postgres";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name}`);
  return value;
}
const seconds = argument("--seconds", 60), intervalMs = argument("--interval-ms", 250), lines = process.argv.includes("--lines");
if (seconds > 3600 || intervalMs < 50) throw new Error("bounds: --seconds <= 3600, --interval-ms >= 50");

async function readDatabaseUrl() {
  if (process.stdin.isTTY) throw new Error("pipe DATABASE_URL on stdin");
  for await (const line of createInterface({ input: process.stdin })) {
    const value = line.trim();
    if (value) return value;
  }
  throw new Error("empty stdin");
}

// 한 문장: Lock 을 기다리는 세션마다 기다리는 lock 종류·모드·대기 시작, 차단 pid 들과 그중 control 표 잠금(RowShare/RowExclusive = 행 FOR SHARE/
// FOR UPDATE 또는 UPDATE)을 쥔 pid 가 있는지, 차단자 문장 머리(80자)·앱 이름을 돌려준다. waiter 자신의 문장 머리도 80자.
const SAMPLE = `
WITH waiting AS (
  SELECT a.pid, a.application_name AS app, l.locktype, l.mode,
    floor(extract(epoch FROM clock_timestamp() - l.waitstart) * 1000)::int AS wait_ms,
    left(regexp_replace(a.query, '\\s+', ' ', 'g'), 80) AS query_head,
    pg_blocking_pids(a.pid) AS blockers
  FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
  WHERE a.wait_event_type = 'Lock' AND a.pid <> pg_backend_pid() AND a.datname = current_database()
), control_holders AS (
  SELECT DISTINCT l.pid FROM pg_locks l
  WHERE l.locktype = 'relation' AND l.relation = 'model_capacity_control'::regclass AND l.granted
    AND l.mode IN ('RowShareLock', 'RowExclusiveLock')
)
SELECT w.pid, w.app, w.locktype, w.mode, w.wait_ms, w.query_head,
  (w.locktype = 'tuple' AND EXISTS (SELECT 1 FROM pg_locks t WHERE t.pid = w.pid AND NOT t.granted AND t.locktype = 'tuple'
     AND t.relation = 'model_capacity_control'::regclass)) AS waits_on_control_tuple,
  EXISTS (SELECT 1 FROM unnest(w.blockers) b JOIN control_holders h ON h.pid = b) AS blocked_by_control_holder,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('app', b.application_name, 'state', b.state,
      'xact_ms', floor(extract(epoch FROM clock_timestamp() - b.xact_start) * 1000)::int,
      'query_head', left(regexp_replace(b.query, '\\s+', ' ', 'g'), 80)) ORDER BY b.xact_start), '[]'::jsonb)
   FROM pg_stat_activity b WHERE b.pid = ANY (w.blockers)) AS blocking
FROM waiting w ORDER BY w.wait_ms DESC`;

const percentile = (values, p) => values.length ? values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)] : null;
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const top = (map, n = 8) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, hits]) => ({ key, hits }));

const sql = postgres(await readDatabaseUrl(), { max: 1, connect_timeout: 10, prepare: false, onnotice: () => {},
  connection: { application_name: "nomorevibe:ledger-lock-sample", statement_timeout: 5000, lock_timeout: 1000 } });
try {
  await sql`SELECT 1`;
  const summary = { samples: 0, failed: 0, samplesWithLockWaits: 0, samplesWithControlWaits: 0, controlWaiterSessions: 0, otherWaiterSessions: 0 };
  const waiterCountsPerSample = new Map(), waitModes = new Map(), waiterApps = new Map(), blockerApps = new Map(), blockerHeads = new Map(), waiterHeads = new Map();
  const controlWaitMs = [];
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const startedAt = Date.now();
    try {
      const rows = await sql.unsafe(SAMPLE);
      summary.samples++;
      const control = rows.filter(row => row.waits_on_control_tuple || row.blocked_by_control_holder);
      if (rows.length) summary.samplesWithLockWaits++;
      if (control.length) summary.samplesWithControlWaits++;
      summary.controlWaiterSessions += control.length;
      summary.otherWaiterSessions += rows.length - control.length;
      count(waiterCountsPerSample, String(control.length));
      for (const row of control) {
        controlWaitMs.push(Number(row.wait_ms));
        count(waitModes, `${row.locktype}:${row.mode}`);
        count(waiterApps, row.app ?? "");
        count(waiterHeads, row.query_head ?? "");
        for (const blocker of row.blocking ?? []) { count(blockerApps, blocker.app ?? ""); count(blockerHeads, blocker.query_head ?? ""); }
      }
      if (lines) process.stderr.write(`${new Date().toISOString()} lock_waiters=${rows.length} control_waiters=${control.length}` +
        (control.length ? ` max_wait_ms=${Math.max(...control.map(row => Number(row.wait_ms)))} modes=${[...new Set(control.map(row => `${row.locktype}:${row.mode}`))].join(",")}` : "") + "\n");
    } catch (error) {
      summary.failed++;
      if (lines) process.stderr.write(`${new Date().toISOString()} sample_failed ${error?.code ?? error?.name ?? "error"}\n`);
    }
    const sleep = intervalMs - (Date.now() - startedAt);
    if (sleep > 0) await new Promise(resolve => setTimeout(resolve, sleep));
  }
  controlWaitMs.sort((a, b) => a - b);
  // 대기 시간 분포는 "표본 순간에 보인 대기 나이"다 — 같은 세션이 여러 표본에 보이면 그만큼 자주 셈한다(긴 대기가 더 무겁게 잡힌다).
  // p95 가 연결 lock_timeout(기본 5,000ms)에 가까우면 55P03 틱 실패가 실제로 나고 있다는 뜻이다.
  process.stdout.write(JSON.stringify({
    seconds, intervalMs, ...summary,
    controlWaitSampleRatio: summary.samples ? Number((summary.samplesWithControlWaits / summary.samples).toFixed(3)) : null,
    controlWaitersPerSample: Object.fromEntries([...waiterCountsPerSample.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))),
    controlWaitMs: { p50: percentile(controlWaitMs, 0.5), p95: percentile(controlWaitMs, 0.95), max: controlWaitMs.at(-1) ?? null, observations: controlWaitMs.length },
    waitModes: top(waitModes), waiterApps: top(waiterApps), waiterQueryHeads: top(waiterHeads), blockerApps: top(blockerApps), blockerQueryHeads: top(blockerHeads),
  }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error?.code ?? error?.name ?? "error", message: String(error?.message ?? error).slice(0, 200) }) + "\n");
  process.exitCode = 1;
} finally { await sql.end({ timeout: 2 }); }
