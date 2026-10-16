import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { writeFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { readModelCapacityCallerControl } from "@/lib/llm/capacity-repository";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { TRANSLATE_MODEL, translateToKorean } from "@/lib/crawl/translate";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { requestJob } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// This is admission/readback, not a positive serving contract or terminal proof.
// Only the legacy HTTP transport is stubbed; the selectors, control, job and TXs are real.
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
beforeEach(async () => { await cleanup(); request.mockReset(); vi.stubEnv("ABCLLM_API_KEY", "test-key"); vi.stubGlobal("fetch", request); });
afterEach(async () => { try { await cleanup(); } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); } });
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

it("disabled actual SHARE read settles before the unchanged legacy transport", () => exercise(async () => {
  await setMode("disabled");
  const before = await whole();
  const control = await readModelCapacityCallerControl();
  expect(control.mode).toBe("disabled");
  let activeTransactions: number | undefined;
  request.mockImplementation(async () => {
    const [row] = await observer`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='idle in transaction'`;
    activeTransactions = Number(row.count);
    return new Response(JSON.stringify({ choices: [{ message: { content: '["문서 관리 도구"]' } }] }));
  });
  expect(await translateToKorean(["A document management tool"], 1_000)).toEqual({ ok: true, translations: ["문서 관리 도구"] });
  expect(activeTransactions).toBe(0);
  expect(request).toHaveBeenCalledTimes(1);
  expect(isDeepStrictEqual(await whole(), before)).toBe(true);
}));

it("a real reason job defers without consuming attempts or a concurrent producer, cursor, pause or history", () => exercise(async () => {
  await setMode("open");
  await prepareReason();
  const before = await whole();
  const finish = latch(), started = latch();
  let blocker = 0;
  const holding = tracked(holder.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    blocker = Number(row.pid); started.resolve(); await finish.promise;
  }));
  const errors: unknown[] = [];
  let execution: Promise<Awaited<ReturnType<typeof runJob>>> | undefined;
  try {
    await Promise.race([started.promise, holding]);
    execution = tracked(runJob("reason-translate", translateReasons, { requestedOnly: true }));
    const until = Date.now() + 2_500;
    let waiter: { pid: number; wait_event_type: string } | undefined;
    do {
      const [row] = await observer`SELECT pid,wait_event_type FROM pg_stat_activity
        WHERE datname=current_database() AND ${blocker}::int=ANY(pg_blocking_pids(pid))
          AND position('model_capacity_control' IN query)>0`;
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
    managedJob!.expected = { ...updated, locked_at: null, lease_token: null };
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
  await expect(translateToKorean(["A document management tool"], 1_000)).rejects.toThrow("model_capacity_policy_hash_mismatch");
  expect(request).not.toHaveBeenCalled();
  expect(isDeepStrictEqual(await whole(), before)).toBe(true);
}));
