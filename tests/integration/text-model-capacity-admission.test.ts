import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { textHash } from "@/lib/crawl/translate";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { translateReasonsWithModelCapacity } from "@/lib/crawl/reason-translation-model-capacity";
import { requestJob } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { inTextRank, pinTextRanks, textContract } from "../text-task-ranks-fixture";

// This is admission/readback, not a positive serving contract or terminal proof.
// Only global HTTP is stubbed (and must stay unused); the selectors, control, job and TXs are real.
// The abcLLM gateway was removed on 2026-10-30: the route reaches its capacity coordinator only with a direct admin contract
// for its model, and the original leaf the coordinator takes while disabled no longer sends anything (no_key).
// 2026-11-02(PR B): 모델·주소는 「작업 ↔ 모델」 순위가 고른다 — 잡은 고정한 순위로, 깊은 함수는 그 순위의 범위(inTextRank) 안에서 부른다.
const TRANSLATE_MODEL = "mlx-community--gemma-4-26b-a4b-it-4bit";
type Raw = Record<string, unknown>;
type Snapshot = Record<string, Raw[]>;
type Sql = postgres.Sql | postgres.TransactionSql;
const prefix = `pr05b4-text-${randomUUID().slice(0, 8)}`;
const client = (label: string) => postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: `${prefix}-${label}` } });
const admin = client("admin"), observer = client("observer"), holder = client("holder");
const work = new Set<Promise<unknown>>();
const request = vi.fn<typeof fetch>();
let baseline: Snapshot | undefined, controlExpected: Raw | undefined;
let managedJob: { original: Raw | undefined; expected: Raw } | undefined;
const sources: Array<{ candidateId: number; attemptId: number; candidate: Raw; attempt: Raw }> = [];
let cleanupFlight: Promise<void> | undefined;
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "reason-translate", provider: "abcllm", model: TRANSLATE_MODEL, providerBudgetId: "account", groupId: "engine" }] };

function tracked<T>(promise: Promise<T>): Promise<T> { work.add(promise); void promise.catch(() => {}); return promise; }
function exercise(load: () => Promise<void>) { return tracked(Promise.resolve().then(load)); }
async function drain() {
  while (work.size) {
    const pending = [...work];
    await Promise.allSettled(pending);
    for (const promise of pending) work.delete(promise);
  }
}
async function steps(loads: Array<() => Promise<unknown>>, prior: unknown[] = []) {
  const errors = [...prior];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "text capacity fixture cleanup failed");
}
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const rawRows = async (name: string, tx: Sql = admin): Promise<Raw[]> =>
  [...await tx.unsafe(`SELECT to_jsonb(t) AS value FROM public."${name.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text`)].map(row => row.value as Raw);
async function whole(tx: Sql = admin): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const row of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
    result[String(row.tablename)] = await rawRows(String(row.tablename), tx);
  return result;
}
async function jobRaw(tx: Sql = admin): Promise<Raw | undefined> {
  return (await tx`SELECT to_jsonb(j) AS value FROM jobs j WHERE name='reason-translate'`)[0]?.value as Raw | undefined;
}
async function setMode(mode: "disabled" | "open", hash = modelCapacityPolicyHash(policy)) {
  const [row] = await admin`UPDATE model_capacity_control c SET mode=${mode},policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${hash} WHERE id=1 RETURNING to_jsonb(c) AS value`;
  controlExpected = row.value as Raw;
}

async function prepareReason() {
  // Register ownership only after this genuine transaction commits. The reason
  // is fixture corpus, not a verified AI verdict, dispatch or provider evidence.
  const made = await admin.begin(async tx => {
    const before = await jobRaw(tx);
    if (before?.lease_token != null || before?.locked_at != null) throw new Error("text_fixture_foreign_job_owner");
    const [row] = await tx`SELECT to_jsonb(j) AS value FROM jobs j WHERE name='reason-translate' FOR UPDATE`;
    if (!isDeepStrictEqual(row?.value, before)) throw new Error("text_fixture_job_changed");
    if (!before) {
      const inserted = await tx`INSERT INTO jobs(name) VALUES('reason-translate') ON CONFLICT DO NOTHING RETURNING name`;
      if (inserted.length !== 1) throw new Error("text_fixture_job_race");
    }
    const [job] = await tx`UPDATE jobs j SET requested_version=10,processed_version=8,cursor=${JSON.stringify({ fixture: prefix })}::text::jsonb,
      not_before=NULL,last_error='preserved history',last_success_at='2026-01-02 03:04:05.123456'::timestamp
      WHERE name='reason-translate' AND lease_token IS NULL AND locked_at IS NULL RETURNING to_jsonb(j) AS value`;
    if (!job) throw new Error("text_fixture_job_owner_changed");
    const repo = `${prefix}/source`;
    if ((await tx`SELECT 1 FROM crawl_candidates WHERE repo=${repo}`).length) throw new Error("text_fixture_repo_not_vacant");
    const [candidate] = await tx`INSERT INTO crawl_candidates(repo,state) VALUES(${repo},'new') RETURNING id`;
    const [attempt] = await tx`INSERT INTO crawl_review_attempts(candidate_id,state,input_hash,policy_hash,source_revision_hash,
      snapshot,source,prompt_version,rules_version,attempt_number,reason,valid_until)
      VALUES(${candidate.id},'failed',${"a".repeat(64)},${"b".repeat(64)},${"c".repeat(64)},'{}'::jsonb,'{}'::jsonb,
      'fixture','fixture',1,${`A document management tool ${prefix}`},clock_timestamp()+interval '1 day') RETURNING id`;
    const [candidateRow] = await tx`SELECT to_jsonb(c) AS value FROM crawl_candidates c WHERE id=${candidate.id}`;
    const [attemptRow] = await tx`SELECT to_jsonb(a) AS value FROM crawl_review_attempts a WHERE id=${attempt.id}`;
    return { job: { original: before, expected: job.value as Raw }, source: { candidateId: Number(candidate.id),
      attemptId: Number(attempt.id), candidate: candidateRow.value as Raw, attempt: attemptRow.value as Raw } };
  });
  managedJob = made.job;
  sources.push(made.source);
}

async function cleanup() {
  if (cleanupFlight) return cleanupFlight;
  const task = (async () => {
    await drain();
    if (!baseline) return;
    const originalBaseline = baseline;
    await admin.begin(async tx => {
      if (managedJob) {
        await tx`SELECT name FROM jobs WHERE name='reason-translate' FOR UPDATE`;
        const current = await jobRaw(tx);
        if (!isDeepStrictEqual(current, managedJob.expected) || current?.lease_token != null || current?.locked_at != null)
          throw new Error("text_fixture_cleanup_job_changed");
        if (!managedJob.original) await tx`DELETE FROM jobs WHERE name='reason-translate' AND to_jsonb(jobs)=${JSON.stringify(managedJob.expected)}::text::jsonb`;
        else {
          const columns = "requested_version,processed_version,next_scheduled_at,not_before,lease_token,worker_seen_at,cursor,locked_at,last_run_at,last_success_at,last_error,runs,updated_at";
          await tx.unsafe(`UPDATE jobs j SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::jobs,$1::text::jsonb)) WHERE name='reason-translate' AND to_jsonb(j)=$2::text::jsonb`,
            [JSON.stringify(managedJob.original), JSON.stringify(managedJob.expected)]);
        }
      }
      for (const source of sources) {
        const [candidate] = await tx`SELECT to_jsonb(c) AS value FROM crawl_candidates c WHERE id=${source.candidateId} FOR UPDATE`;
        const attempts = await tx`SELECT to_jsonb(a) AS value FROM crawl_review_attempts a WHERE candidate_id=${source.candidateId} ORDER BY id FOR UPDATE`;
        if (!isDeepStrictEqual(candidate?.value, source.candidate) || attempts.length !== 1
          || !isDeepStrictEqual(attempts[0].value, source.attempt)) throw new Error("text_fixture_cleanup_source_changed");
        await tx`DELETE FROM crawl_review_attempts WHERE id=${source.attemptId} AND candidate_id=${source.candidateId}`;
        await tx`DELETE FROM crawl_candidates WHERE id=${source.candidateId} AND repo=${`${prefix}/source`}`;
      }
      if (controlExpected) {
        const original = originalBaseline.model_capacity_control[0];
        const [row] = await tx`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1 FOR UPDATE`;
        if (!isDeepStrictEqual(row?.value, controlExpected)) throw new Error("text_fixture_cleanup_control_changed");
        await tx`UPDATE model_capacity_control SET (mode,epoch,revision,policy_hash,policy,cursor,updated_at)=
          (SELECT mode,epoch,revision,policy_hash,policy,cursor,updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(original)}::text::jsonb)) WHERE id=1`;
      }
      expect(isDeepStrictEqual(await whole(tx), originalBaseline)).toBe(true);
    });
    // A rollback must retain the exact ownership set for a later cleanup attempt.
    managedJob = undefined; controlExpected = undefined; sources.length = 0;
  })();
  cleanupFlight = task;
  void task.finally(() => { if (cleanupFlight === task) cleanupFlight = undefined; }).catch(() => {});
  return task;
}

beforeAll(() => tracked((async () => {
  ensureSchema();
  baseline = await whole();
  expect(baseline.model_capacity_control).toHaveLength(1);
  await writeFile(`/tmp/${prefix}-baseline.json`, JSON.stringify(baseline), { mode: 0o600 });
})()));
beforeEach(async () => { await cleanup(); request.mockReset(); vi.stubGlobal("fetch", request);
  setServingContractSnapshotForTest([textContract("reason-translate", TRANSLATE_MODEL)]); pinTextRanks({ "reason-translate": TRANSLATE_MODEL }); });
afterEach(async () => { try { await cleanup(); } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); setServingContractSnapshotForTest(null); pinTextRanks(null); } });
const batch = () => [{ hash: textHash("A document management tool"), body: "A document management tool", attempts: 0 }];
const lease = { name: "reason-translate", token: `${prefix}-lease`, requestedVersion: 1 };
afterAll(async () => {
  await steps([drain, cleanup, async () => {
    if (baseline) {
      const final = await whole();
      await writeFile(`/tmp/${prefix}-final.json`, JSON.stringify(final), { mode: 0o600 });
      expect(isDeepStrictEqual(final, baseline)).toBe(true);
    }
  }, () => admin.end(), () => observer.end(), () => holder.end(),
  async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end(); }]);
});

it("disabled actual SHARE read settles before the original leaf, which no longer sends", () => exercise(async () => {
  await setMode("disabled");
  const before = await whole();
  const control = await readModelCapacityCallerControl();
  expect(control.mode).toBe("disabled");
  request.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: '["문서 관리 도구"]' } }] })));
  expect(await inTextRank("reason-translate", TRANSLATE_MODEL, () => translateReasonsWithModelCapacity(batch(), lease, { timeoutMs: 1_000 })))
    .toEqual({ kind: "disabled", result: { ok: false, error: "no_key" } });
  const [row] = await observer`SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'`;
  expect(Number(row.count)).toBe(0);
  expect(request).not.toHaveBeenCalled();
  expect(isDeepStrictEqual(await whole(), before)).toBe(true);
}));

it("a real reason job defers without consuming attempts or a concurrent producer, cursor, pause or history", () => exercise(async () => {
  await setMode("open");
  await prepareReason();
  const before = await whole();
  const history = (row: Raw | undefined) => row && { requested_version: row.requested_version, processed_version: row.processed_version,
    cursor: row.cursor, not_before: row.not_before, last_error: row.last_error, last_success_at: row.last_success_at };
  // 1) 2026-10-31 장부 control 경합: 전송 경로를 고르는 control 읽기는 행을 잠그지 않는다 — 다른 세션이 control 을 FOR UPDATE 로 쥐고 있어도
  //    미루는 틱은 그 세션 뒤에 줄 서지 않고 끝난다(예전에는 여기서 FOR SHARE 가 Lock 대기였다).
  const rowHold = latch(), rowHeld = latch();
  let rowBlocker = 0;
  const rowHolding = tracked(holder.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    rowBlocker = Number(row.pid); rowHeld.resolve(); await rowHold.promise;
  }));
  const errors: unknown[] = [];
  let execution: Promise<Awaited<ReturnType<typeof runJob>>> | undefined;
  try {
    await Promise.race([rowHeld.promise, rowHolding]);
    const first = await tracked(runJob("reason-translate", translateReasons, { requestedOnly: true }));
    expect(first).toMatchObject({ status: "deferred", reason: "model_capacity" });
    expect(await observer`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${rowBlocker}::int=ANY(pg_blocking_pids(pid))`).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    const settled = await jobRaw();
    expect(settled?.lease_token).toBeNull(); expect(settled?.locked_at).toBeNull();
    // 던지지 않고 끝난 미룸 틱은 사유를 가리지 않고 lastError 를 지운다(lib/jobs/runner.ts, 2026-10-31) — 요청·커서·멈춤·성공 시각은 그대로다
    expect(history(settled)).toEqual({ ...history(managedJob!.expected), last_error: null });
  } catch (error) { errors.push(error); }
  finally { rowHold.resolve(); await steps([() => rowHolding], errors); }
  // 2) 틱 중간의 동시 생산자·멈춤 보존은 틱을 세울 자리가 필요하다 — control 행 잠금은 더는 세우지 못하므로 표 AccessExclusiveLock 으로
  //    틱의 첫 control 읽기(대기열 선택기의 EXISTS)를 세운다. 그 뒤는 예전 계약 그대로다.
  const finish = latch(), started = latch();
  let blocker = 0;
  const holding = tracked(holder.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`LOCK TABLE model_capacity_control IN ACCESS EXCLUSIVE MODE`;
    blocker = Number(row.pid); started.resolve(); await finish.promise;
  }));
  try {
    await Promise.race([started.promise, holding]);
    execution = tracked(runJob("reason-translate", translateReasons, { requestedOnly: true }));
    const until = Date.now() + 2_500;
    let waiter: { pid: number; wait_event_type: string } | undefined;
    do {
      // holder 는 control 표 잠금만 쥐므로 그 뒤에 선 세션은 control 을 읽는 문장이다(선택기의 긴 문장은 track_activity_query_size 에 잘려
      // 표 이름이 query 에 안 보일 수 있다 — 문장 본문으로 거르지 않는다).
      const [row] = await observer`SELECT pid,wait_event_type FROM pg_stat_activity
        WHERE datname=current_database() AND ${blocker}::int=ANY(pg_blocking_pids(pid))`;
      if (row) { waiter = { pid: Number(row.pid), wait_event_type: String(row.wait_event_type) }; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < until);
    expect(waiter?.wait_event_type).toBe("Lock");
    const current = await jobRaw();
    expect(typeof current?.lease_token).toBe("string");
    await requestJob("reason-translate");
    const [row] = await admin`UPDATE jobs j SET not_before=clock_timestamp()+interval '1 day'
      WHERE name='reason-translate' AND lease_token=${String(current!.lease_token)} RETURNING to_jsonb(j) AS value`;
    if (!row) throw new Error("text_fixture_job_lost");
    const updated = row.value as Raw;
    managedJob!.expected = { ...updated, locked_at: null, lease_token: null, last_error: null };
    finish.resolve(); await holding;
    expect(await execution).toMatchObject({ status: "deferred", reason: "model_capacity" });
    expect(request).not.toHaveBeenCalled();
    expect(isDeepStrictEqual(await jobRaw(), managedJob!.expected)).toBe(true);
    const after = await whole();
    delete before.jobs; delete after.jobs;
    expect(isDeepStrictEqual(after, before)).toBe(true);
  } catch (error) { errors.push(error); }
  finally {
    finish.resolve();
    await steps([() => holding, async () => { if (execution) await execution; }], errors);
  }
}));

it("malformed current policy is the original error, with no POST, slot or business write", () => exercise(async () => {
  await setMode("open", "d".repeat(64));
  const before = await whole();
  await expect(inTextRank("reason-translate", TRANSLATE_MODEL, () => translateReasonsWithModelCapacity(batch(), lease, { timeoutMs: 1_000 })))
    .rejects.toThrow("model_capacity_policy_hash_mismatch");
  expect(request).not.toHaveBeenCalled();
  expect(isDeepStrictEqual(await whole(), before)).toBe(true);
}));
