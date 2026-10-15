import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, jobs, operationsObservations } from "@/lib/db/schema";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { reopenOrphanedGateHolds } from "@/lib/crawl/second-review";
import { assertJobLeaseAtWallTime, JobLeaseLostError, requestJob } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { openVerifiedReplayHandlerDatabase, verifyReplayDatabaseSession } from "@/lib/operations/pipeline-replay-database";
import { ReplayLedger } from "@/lib/operations/pipeline-replay-ledger";
import { currentReplayTransactionHooks, deferReplayFinalWrite, registerReplayJobFinalAuthority, replayQuiescenceProof,
  withReplayExecutionScope, type ReplayTransactionTicket } from "@/lib/operations/pipeline-replay-execution";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

const prefix = "pr04c-wall-authority/";
const managedJobs = ["crawl-agent-review", "second-review"];
const observationKeys = managedJobs.map(name => `job:${name}`);
const sentinel = `pr04c-wall-authority-unrelated-${randomUUID().slice(0, 8)}`;
const reference = new Date("2001-11-01T00:00:00.000Z");
const settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS),
  firstReview: { provider: "abcllm" as const, model: "wall-first" } };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c-wall-authority-admin", statement_timeout: 8_000 } });
type RawRow = Record<string, unknown>;
let originalJobs: RawRow[] = [], originalSettings: RawRow[] = [], originalObservations: RawRow[] = [];
let baseline: unknown, withSentinel: unknown, serial = 0, initialized = false;
let release: (() => Promise<void>) | undefined;
let database: Awaited<ReturnType<typeof openVerifiedReplayHandlerDatabase>> | undefined;

async function snapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s),
    'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY key),'[]'::jsonb) FROM operations_observations o),
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM crawl_candidates c),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM crawl_documents d),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM crawl_review_attempts a),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM second_reviews s),
    'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM products p),
    'purges',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM cdn_purges p)) AS value`;
  return row.value;
}

async function restoreShared() {
  const absentJobs = managedJobs.filter(name => !originalJobs.some(row => row.name === name));
  if (absentJobs.length) await db.delete(jobs).where(inArray(jobs.name, absentJobs));
  if (originalJobs.length) await admin`UPDATE jobs j SET requested_version=r.requested_version,
    processed_version=r.processed_version,next_scheduled_at=r.next_scheduled_at,not_before=r.not_before,
    lease_token=r.lease_token,worker_seen_at=r.worker_seen_at,cursor=r.cursor,locked_at=r.locked_at,
    last_run_at=r.last_run_at,last_success_at=r.last_success_at,last_error=r.last_error,runs=r.runs,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb) r WHERE j.name=r.name`;
  const absentObservations = observationKeys.filter(key => !originalObservations.some(row => row.key === key));
  if (absentObservations.length) await db.delete(operationsObservations).where(inArray(operationsObservations.key, absentObservations));
  if (originalObservations.length) await admin`UPDATE operations_observations o SET value=r.value,observed_at=r.observed_at
    FROM jsonb_populate_recordset(NULL::operations_observations,${JSON.stringify(originalObservations)}::text::jsonb) r WHERE o.key=r.key`;
  if (originalSettings.length) await admin`UPDATE crawl_settings s SET values=r.values,updated_by=r.updated_by,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb) r WHERE s.id=r.id`;
  else await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
}

async function cleanup() {
  const errors: unknown[] = [];
  const step = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { errors.push(error); } };
  await step(async () => { await database?.close(); database = undefined; });
  await step(async () => { if (release) { await release(); release = undefined; } });
  await step(async () => { await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`)); });
  await step(async () => { await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`)); });
  await step(restoreShared);
  if (errors.length) throw new AggregateError(errors, "wall_authority_fixture_cleanup_failed");
}

beforeAll(async () => {
  ensureSchema();
  baseline = await snapshot();
  originalJobs = (await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name IN ('crawl-agent-review','second-review') ORDER BY name`).map(row => row.row);
  originalSettings = (await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`).map(row => row.row);
  originalObservations = (await admin`SELECT to_jsonb(o) AS row FROM operations_observations o
    WHERE key IN ('job:crawl-agent-review','job:second-review') ORDER BY key`).map(row => row.row);
  initialized = true;
  await admin`INSERT INTO jobs (name,requested_version,processed_version,cursor,not_before,last_error,updated_at)
    VALUES (${sentinel},17,9,'{"foreign":"preserve"}'::jsonb,'2099-01-02 03:04:05.123456','foreign history','2026-10-16 01:02:03.654321')`;
  withSentinel = await snapshot();
});

beforeEach(async () => {
  await cleanup();
  expect(await snapshot()).toEqual(withSentinel);
  // These two managed rows are borrowed in-place and restored byte-for-byte.
  await admin`UPDATE jobs SET locked_at=NULL,lease_token=NULL,not_before=NULL,
    requested_version=0,processed_version=0,cursor=NULL WHERE name IN ('crawl-agent-review','second-review')`;
});

afterEach(async () => {
  if (!initialized) return;
  await cleanup();
  expect(await snapshot()).toEqual(withSentinel);
});

afterAll(async () => {
  const errors: unknown[] = [];
  try { if (initialized) await cleanup(); } catch (error) { errors.push(error); }
  try { if (initialized) await admin`DELETE FROM jobs WHERE name=${sentinel}`; } catch (error) { errors.push(error); }
  try { if (initialized) expect(await snapshot()).toEqual(baseline); } catch (error) { errors.push(error); }
  try { await admin.end({ timeout: 3 }); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "wall_authority_final_cleanup_failed");
});

async function prepare(certified = true, beforeProvision?: (bootstrap: postgres.Sql) => Promise<void>) {
  const repo = `${prefix}app-${++serial}`;
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://wall-authority-${serial}.example`,
    state: "new", decidedBy: "auto" }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, fetchedAt: reference,
    pageStatus: 200, repoMeta: { description: "A deployed project management application" },
    pageMeta: { title: "Wall authority", readmeSample: "A deployed project management application",
      readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  await db.insert(crawlSettings).values({ id: 1, values: settings })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } });
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] }, reference);
  const manifest: CapacityManifest = { version: 1, runId: `pr04c-wall-authority-${randomUUID()}`, revision: "2fb960a",
    mode: "fixtures", cacheMode: "cold", referenceTime: reference.toISOString(), startedAt: reference.toISOString(),
    endedAt: new Date(+reference + 10_000).toISOString(), inputPolicyHash: input.policyHash,
    fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings),
    initialStateHash: reviewHash({ candidate, document }),
    models: { first: { provider: "abcllm", model: "wall-first", canonicalModel: "wall-first" }, second: [], fallbacks: [] },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 4, maxTokens: 400, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 2 } };
  const identity = await getReplayHandlerIdentityPath({ beforeProvision }); release = identity.release;
  database = await openVerifiedReplayHandlerDatabase(identity.identityPath, {});
  const ledger = new ReplayLedger(database), inputs = [{ candidateId: candidate.id, input }];
  if (certified) manifest.initialStateHash = (await ledger.previewInitialState(manifest, inputs)).initialStateHash;
  const run = certified ? await ledger.prepareCertified(manifest, inputs,
    { runner: { jobs: ["crawl-agent-review", "second-review"], budgetMs: 110_000 }, quality: null }) : await ledger.prepare(manifest, inputs);
  await ledger.start(run);
  return { candidate, input, manifest, ledger, run, identityPath: identity.identityPath };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;
const certified = <T>(value: Prepared, work: () => Promise<T>) =>
  withReplayExecutionScope(value.run, () => withReplayDatabaseScope(value.identityPath, work));
async function packets(runId: string) {
  return admin`SELECT t.tx_key::text, t.changes, c.tx_key IS NOT NULL AS confirmed
    FROM pipeline_replay.capacity_transactions t LEFT JOIN pipeline_replay.capacity_commit_confirmations c
      ON c.run_id=t.run_id AND c.tx_key=t.tx_key WHERE t.run_id=${runId} ORDER BY t.seq`;
}

function nativeExecutor(raw: postgres.TransactionSql): ProductTransaction {
  const dialect = new PgDialect();
  return { execute(query: Parameters<ProductTransaction["execute"]>[0]) {
    const rendered = dialect.sqlToQuery(query as ReturnType<typeof sql>);
    return raw.unsafe(rendered.sql, rendered.params as postgres.ParameterOrJSON<never>[]);
  } } as unknown as ProductTransaction;
}

async function rejectedSiblingTransaction(work: (tx: ProductTransaction) => Promise<void>): Promise<never> {
  // The scoped replay executor deliberately has max:1. Use the separately opened
  // verified ledger client, not a nested checkout from that same single pool.
  const authentic = database!;
  const hooks = currentReplayTransactionHooks(authentic);
  let ticket: ReplayTransactionTicket | undefined;
  try {
    await authentic.client.begin(async raw => {
      await verifyReplayDatabaseSession(raw, authentic);
      ticket = await hooks.before(raw);
      await work(nativeExecutor(raw));
      throw new Error("registration_attack_was_accepted");
    });
    throw new Error("registration_attack_unexpected_commit");
  } finally {
    hooks.rollback(ticket);
  }
}

it("commits an ordinary certified journal without inventing a job authority", async () => {
  const value = await prepare();
  await certified(value, () => db.transaction(async tx => {
    await tx.update(crawlCandidates).set({ signals: { wall: "pure-journal" } }).where(eq(crawlCandidates.id, value.candidate.id));
  }));
  const recorded = await packets(value.run.runId);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ confirmed: true, changes: [expect.objectContaining({ table_name: "crawl_candidates" })] });
  expect(await admin`SELECT name FROM jobs WHERE name IN ('crawl-agent-review','second-review') AND lease_token IS NOT NULL`).toHaveLength(0);
  expect(() => replayQuiescenceProof(value.run)).not.toThrow();
});

it("keeps genuine certified claim, cursor and completion transactions valid after their token is released", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async ctx => {
    expect(ctx.lease?.token).toEqual(expect.any(String));
    await ctx.save({ wall: "cursor" });
    return { done: true, cursor: { wall: "completed" } };
  }));
  expect(result.status).toBe("completed");
  const [job] = await admin`SELECT lease_token,locked_at,cursor,requested_version,processed_version FROM jobs WHERE name='second-review'`;
  expect(job).toMatchObject({ lease_token: null, locked_at: null, cursor: { wall: "completed" } });
  expect(job.processed_version).toBe(job.requested_version);
  const recorded = await packets(value.run.runId);
  expect(recorded.length).toBeGreaterThanOrEqual(3);
  expect(recorded.every(row => row.confirmed)).toBe(true);
});

it("journals an actual 15-second runner heartbeat without requiring a synthetic final proof", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async ctx => {
    const [before] = await admin`SELECT locked_at::text AS locked_at FROM jobs WHERE name='second-review'`;
    await expect.poll(async () => {
      const [row] = await admin`SELECT locked_at::text AS locked_at,lease_token,worker_seen_at IS NOT NULL AS seen
        FROM jobs WHERE name='second-review'`;
      return row.locked_at !== before.locked_at && row.lease_token === ctx.lease!.token && row.seen;
    }, { timeout: 17_000, interval: 25 }).toBe(true);
    return { done: true };
  }, { budgetMs: 25_000 }));
  expect(result.status).toBe("completed");
  const recorded = await packets(value.run.runId);
  expect(recorded.some(row => (row.changes as RawRow[]).some(change => change.table_name === "jobs"
    && change.operation === "UPDATE" && (change.new_row as RawRow).worker_seen_at !== (change.old_row as RawRow).worker_seen_at))).toBe(true);
  expect(recorded.every(row => row.confirmed)).toBe(true);
});

it("preserves a deferred runner request without rechecking its intentionally cleared token", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async ctx => {
    await ctx.save({ wall: "deferred" });
    return { done: false, deferred: "stage_blocked" };
  }));
  expect(result).toMatchObject({ status: "deferred", reason: "stage_blocked" });
  const [job] = await admin`SELECT lease_token,locked_at,cursor,requested_version,processed_version FROM jobs WHERE name='second-review'`;
  expect(job).toMatchObject({ lease_token: null, locked_at: null, cursor: { wall: "deferred" } });
  expect(Number(job.processed_version)).toBe(0);
  expect(Number(job.requested_version)).toBe(1);
  expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
});

it("preserves the actual runner failure transaction and its released-token history", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async () => { throw new Error("own_wall_control_failure"); }));
  expect(result).toMatchObject({ status: "failed", error: "own_wall_control_failure" });
  const [job] = await admin`SELECT lease_token,locked_at,last_error,requested_version,processed_version FROM jobs WHERE name='second-review'`;
  expect(job).toMatchObject({ lease_token: null, locked_at: null, last_error: "own_wall_control_failure" });
  expect(Number(job.processed_version)).toBe(0);
  expect(Number(job.requested_version)).toBe(1);
  expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
});

it("checks a zero-match actual controller under its genuine certified job", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async ctx => {
    expect(await reopenOrphanedGateHolds(settings, reference, ctx.lease!, 0)).toBe(0);
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
  expect(await admin`SELECT state,signals FROM crawl_candidates WHERE id=${value.candidate.id}`)
    .toEqual([{ state: "new", signals: value.candidate.signals }]);
});

it("retains ordinary noncertified replay job wall checks without creating a certified journal", async () => {
  const value = await prepare(false);
  const result = await withReplayDatabaseScope(value.identityPath, () => runJob("second-review", async ctx => {
    await db.transaction(async tx => {
      await tx.update(crawlCandidates).set({ signals: { wall: "ordinary" } }).where(eq(crawlCandidates.id, value.candidate.id));
      await assertJobLeaseAtWallTime(tx, ctx.lease!);
    });
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  expect(await packets(value.run.runId)).toHaveLength(0);
  expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`).toEqual([{ signals: { wall: "ordinary" } }]);
});

it("rechecks the same actual authority idempotently while preserving a producer request and pause", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async ctx => {
    await db.transaction(async tx => {
      await assertJobLeaseAtWallTime(tx, ctx.lease!, "update");
      await assertJobLeaseAtWallTime(tx, ctx.lease!, "update");
      await registerReplayJobFinalAuthority(tx, ctx.lease!, "update");
      await registerReplayJobFinalAuthority(tx, ctx.lease!, "share");
      expect((await requestJob("second-review", tx)).requestedVersion).toBe(ctx.lease!.requestedVersion + 1);
      await tx.execute(sql`UPDATE jobs SET not_before='2099-01-02 03:04:05.123456'::timestamp WHERE name='second-review'`);
      await tx.update(crawlCandidates).set({ signals: { wall: "producer-request" } }).where(eq(crawlCandidates.id, value.candidate.id));
      await assertJobLeaseAtWallTime(tx, ctx.lease!);
    });
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  const [job] = await admin`SELECT lease_token,requested_version::int,processed_version::int,not_before::text AS pause
    FROM jobs WHERE name='second-review'`;
  expect(job).toEqual({ lease_token: null, requested_version: 2, processed_version: 1, pause: "2099-01-02 03:04:05.123456" });
  const recorded = await packets(value.run.runId);
  expect(recorded.every(row => row.confirmed)).toBe(true);
  expect(recorded.filter(row => (row.changes as RawRow[]).some(change => change.table_name === "crawl_candidates"))).toHaveLength(1);
});

it("rolls a writer and its journal back when a changed token fails the actual job check", async () => {
  const value = await prepare();
  const [before] = await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${value.candidate.id}`;
  const result = await certified(value, () => runJob("second-review", async ctx => {
    await expect(db.transaction(async tx => {
      await tx.update(crawlCandidates).set({ signals: { wall: "forged-token" } }).where(eq(crawlCandidates.id, value.candidate.id));
      await assertJobLeaseAtWallTime(tx, { ...ctx.lease!, token: randomUUID() });
    })).rejects.toBeInstanceOf(JobLeaseLostError);
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  expect(await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${value.candidate.id}`).toEqual([before]);
  expect((await packets(value.run.runId)).filter(row => (row.changes as RawRow[])
    .some(change => change.table_name === "crawl_candidates"))).toHaveLength(0);
});

it("keeps a committed registered writer unconfirmed when the separate commit acknowledgment fails", async () => {
  const value = await prepare(true, async bootstrap => {
    await bootstrap.unsafe(`CREATE FUNCTION pipeline_replay.wall_authority_fail_ack() RETURNS trigger LANGUAGE plpgsql
      SECURITY INVOKER SET search_path=pg_catalog AS $$ BEGIN
      IF EXISTS (SELECT 1 FROM pipeline_replay.capacity_transactions t
        WHERE t.run_id=NEW.run_id AND t.tx_key=NEW.tx_key
        AND t.changes @> '[{"table_name":"crawl_candidates"}]'::jsonb)
      THEN RAISE EXCEPTION 'own_wall_authority_ack_failed'; END IF; RETURN NEW; END $$`);
    await bootstrap.unsafe(`CREATE TRIGGER wall_authority_fail_ack BEFORE INSERT ON pipeline_replay.capacity_commit_confirmations
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.wall_authority_fail_ack()`);
  });
  let outcome: Awaited<ReturnType<typeof runJob>> | undefined;
  await expect(certified(value, async () => {
    outcome = await runJob("second-review", async ctx => {
      await expect(db.transaction(async tx => {
        await tx.update(crawlCandidates).set({ signals: { wall: "committed-without-ack" } })
          .where(eq(crawlCandidates.id, value.candidate.id));
        await assertJobLeaseAtWallTime(tx, ctx.lease!);
      })).rejects.toThrow("own_wall_authority_ack_failed");
      return { done: true };
    });
  })).rejects.toThrow("replay_execution_not_quiescent");
  // runJob catches handler assertions; require a completed handler independently
  // of the execution scope's expected unresolved-ack rejection.
  expect(outcome?.status).toBe("completed");
  expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`)
    .toEqual([{ signals: { wall: "committed-without-ack" } }]);
  const writes = (await packets(value.run.runId)).filter(row => (row.changes as RawRow[])
    .some(change => change.table_name === "crawl_candidates"));
  expect(writes).toHaveLength(1);
  expect(writes[0].confirmed).toBe(false);
  expect(() => replayQuiescenceProof(value.run)).toThrow("replay_execution_not_quiescent");
  expect(await admin`SELECT lease_token,locked_at FROM jobs WHERE name='second-review'`)
    .toEqual([{ lease_token: null, locked_at: null }]);
});

for (const attack of ["json-only", "sibling-executor", "sibling-key"] as const) {
  it(`rejects ${attack} replay of a different executor's genuine ticket metadata`, async () => {
    const value = await prepare();
    const result = await certified(value, () => runJob("second-review", async ctx => {
      await db.transaction(async real => {
        const metadata = await real.execute<{ tx_key: string; xid: string }>(sql`SELECT
          current_setting('pipeline_replay.tx_key',true) AS tx_key,pg_current_xact_id()::text AS xid`);
        expect(metadata[0].tx_key).toEqual(expect.any(String));
        const [before] = await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='second-review'`;
        if (attack === "json-only") {
          // Negative façade returns genuine-looking metadata but executes no SQL.
          const fake = { execute: async () => metadata } as unknown as ProductTransaction;
          await expect(registerReplayJobFinalAuthority(fake, ctx.lease!, "share"))
            .rejects.toThrow("replay_transaction_ticket_mismatch");
        } else {
          await expect(rejectedSiblingTransaction(async sibling => {
            const [identity] = await sibling.execute<{ xid: string }>(sql`SELECT pg_current_xact_id()::text AS xid`);
            expect(identity.xid).not.toBe(metadata[0].xid);
            if (attack === "sibling-executor") {
              const fake = { execute: async (query: Parameters<ProductTransaction["execute"]>[0]) => {
                await sibling.execute(query);
                return metadata;
              } } as unknown as ProductTransaction;
              await registerReplayJobFinalAuthority(fake, ctx.lease!, "share");
            } else {
              await sibling.execute(sql`SELECT set_config('pipeline_replay.tx_key',${metadata[0].tx_key},true)`);
              await registerReplayJobFinalAuthority(sibling, ctx.lease!, "share");
            }
          })).rejects.toThrow("replay_transaction_ticket_mismatch");
        }
        expect(await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='second-review'`).toEqual([before]);
        const [challenge] = await real.execute<{ value: string }>(sql`SELECT
          coalesce(current_setting('pipeline_replay.final_authority_challenge',true),'') AS value`);
        expect(challenge.value).toBe("");
      });
      return { done: true };
    }));
    // The real runner catches callback assertions: require this independently.
    expect(result.status).toBe("completed");
    expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
    expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`)
      .toEqual([{ signals: value.candidate.signals }]);
  });
}

it("rejects a changed token through fixed registration itself and rolls back domain writes", async () => {
  const value = await prepare();
  const [before] = await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${value.candidate.id}`;
  const result = await certified(value, () => runJob("second-review", async ctx => {
    await expect(db.transaction(async tx => {
      await tx.update(crawlCandidates).set({ signals: { wall: "direct-forged-token" } }).where(eq(crawlCandidates.id, value.candidate.id));
      await registerReplayJobFinalAuthority(tx, { ...ctx.lease!, token: randomUUID() }, "share");
    })).rejects.toBeInstanceOf(JobLeaseLostError);
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  expect(await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${value.candidate.id}`).toEqual([before]);
  expect((await packets(value.run.runId)).filter(row => (row.changes as RawRow[])
    .some(change => change.table_name === "crawl_candidates"))).toHaveLength(0);
});

it("rejects unsupported job registration without expanding the certified job set", async () => {
  const value = await prepare();
  const before = await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='crawl-publish'`;
  const result = await certified(value, () => runJob("second-review", async ctx => {
    await expect(db.transaction(tx => registerReplayJobFinalAuthority(tx,
      { ...ctx.lease!, name: "crawl-publish" }, "share"))).rejects.toThrow("replay_job_final_authority_unsupported");
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  expect(await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name='crawl-publish'`).toEqual(before);
});

it("rejects registration through an ended genuine guarded transaction", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async ctx => {
    let ended: ProductTransaction | undefined;
    await db.transaction(async tx => {
      await assertJobLeaseAtWallTime(tx, ctx.lease!);
      ended = tx;
    });
    await expect(registerReplayJobFinalAuthority(ended!, ctx.lease!, "share"))
      .rejects.toMatchObject({ cause: { message: "replay_transaction_closed" } });
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
});

it("rejects a retained asynchronous registration after its authentic execution scope has closed", async () => {
  const value = await prepare();
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  let late: Promise<unknown> | undefined;
  try {
    const result = await certified(value, () => runJob("second-review", async ctx => {
      await db.transaction(async tx => {
        await assertJobLeaseAtWallTime(tx, ctx.lease!);
        late = gate.then(() => registerReplayJobFinalAuthority(tx, ctx.lease!, "share"))
          .then(() => ({ accepted: true }), error => ({ error }));
      });
      return { done: true };
    }));
    expect(result.status).toBe("completed");
    open();
    expect(await late).toMatchObject({ error: { message: "replay_execution_scope_closed" } });
    expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
  } finally {
    open();
    if (late) await late;
  }
});

it("preserves the original registered token after a conflicting token is rejected in the same transaction", async () => {
  const value = await prepare();
  const result = await certified(value, () => runJob("second-review", async ctx => {
    await db.transaction(async tx => {
      await registerReplayJobFinalAuthority(tx, ctx.lease!, "share");
      await expect(registerReplayJobFinalAuthority(tx, { ...ctx.lease!, token: randomUUID() }, "share"))
        .rejects.toThrow("replay_job_final_authority_conflict");
      // Do not re-register the original token: finalWall must use the proof that
      // survived the rejected conflict, rather than repairing it in this test.
      await tx.update(crawlCandidates).set({ signals: { wall: "original-proof-preserved" } })
        .where(eq(crawlCandidates.id, value.candidate.id));
    });
    return { done: true };
  }));
  expect(result.status).toBe("completed");
  expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`)
    .toEqual([{ signals: { wall: "original-proof-preserved" } }]);
  expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
});

it("enforces genuine ticket states through native commit and ack without any job authority", async () => {
  const value = await prepare();
  const authentic = database!, wrongDatabase = await openVerifiedReplayHandlerDatabase(value.identityPath, {});
  let ticket: ReplayTransactionTicket | undefined, committed = false;
  try {
    await withReplayExecutionScope(value.run, async () => {
      const hooks = currentReplayTransactionHooks(authentic);
      try {
        await authentic.client.begin(async raw => {
          await verifyReplayDatabaseSession(raw, authentic);
          ticket = await hooks.before(raw);
          expect(ticket).toBeDefined();
          await expect(hooks.finalWall(raw, ticket)).rejects.toThrow("replay_transaction_ticket_mismatch");
          await expect(hooks.commitAck(ticket)).rejects.toThrow("replay_transaction_ticket_mismatch");
          await hooks.after(raw, ticket);
          await expect(hooks.commitAck(ticket)).rejects.toThrow("replay_transaction_ticket_mismatch");
          await verifyReplayDatabaseSession(raw, authentic);
          await wrongDatabase.client.begin(async wrongRaw => {
            await verifyReplayDatabaseSession(wrongRaw, wrongDatabase);
            await expect(hooks.finalWall(wrongRaw, ticket)).rejects.toThrow("replay_transaction_ticket_mismatch");
            await hooks.finalWall(raw, ticket);
            await expect(hooks.finalWall(wrongRaw, ticket)).rejects.toThrow("replay_transaction_ticket_mismatch");
            await expect(hooks.finalWall(raw, ticket)).rejects.toThrow("replay_transaction_ticket_mismatch");
          });
        });
        committed = true;
        await hooks.commitAck(ticket);
        await expect(hooks.commitAck(ticket)).rejects.toThrow("replay_transaction_ticket_mismatch");
      } catch (error) {
        if (!committed) hooks.rollback(ticket);
        throw error;
      }
    });
    const recorded = await packets(value.run.runId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ confirmed: true, changes: [] });
    expect(() => replayQuiescenceProof(value.run)).not.toThrow();
    expect(await admin`SELECT name FROM jobs WHERE name IN ('crawl-agent-review','second-review') AND lease_token IS NOT NULL`).toHaveLength(0);
  } finally {
    await wrongDatabase.close();
  }
});

it("rejects new authority registration while genuine deferred callbacks are flushing", async () => {
  const value = await prepare();
  const authentic = database!;
  let lateError: unknown, lateAccepted = false, callbackEntered = false;
  const result = await certified(value, () => runJob("second-review", async ctx => {
    const hooks = currentReplayTransactionHooks(authentic);
    let ticket: ReplayTransactionTicket | undefined, committed = false;
    try {
      await authentic.client.begin(async raw => {
        await verifyReplayDatabaseSession(raw, authentic);
        ticket = await hooks.before(raw);
        const actual = nativeExecutor(raw);
        let enter!: () => void, finish!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const complete = new Promise<void>(resolve => { finish = resolve; });
        expect(await deferReplayFinalWrite(actual, async () => {
          // This callback runs after flush has locked/updated the actual run row
          // and inserted the transaction packet. It grants no writer authority.
          callbackEntered = true; enter(); await complete;
        })).toBe(true);
        const flushing = hooks.after(raw, ticket);
        void flushing.catch(() => undefined);
        try {
          await Promise.race([entered, flushing.then(() => { throw new Error("flush_callback_missing"); })]);
          const [packet] = await raw`SELECT tx_key::text AS tx_key FROM pipeline_replay.capacity_transactions
            WHERE run_id=${value.run.runId} AND tx_key=current_setting('pipeline_replay.tx_key',true)::uuid`;
          expect(packet?.tx_key).toEqual(expect.any(String));
          try {
            await registerReplayJobFinalAuthority(actual, ctx.lease!, "share");
            lateAccepted = true;
          } catch (error) { lateError = error; }
        } finally {
          finish(); await flushing;
        }
        await verifyReplayDatabaseSession(raw, authentic);
        await hooks.finalWall(raw, ticket);
      });
      committed = true;
      await hooks.commitAck(ticket);
    } catch (error) {
      if (!committed) hooks.rollback(ticket);
      throw error;
    }
    return { done: true };
  }));
  // Keep the feature assertion outside runJob so its catch cannot hide RED.
  expect(result.status).toBe("completed");
  expect(callbackEntered).toBe(true);
  expect(lateAccepted).toBe(false);
  expect(lateError).toMatchObject({ message: "replay_transaction_ticket_mismatch" });
  expect((await packets(value.run.runId)).every(row => row.confirmed)).toBe(true);
});
