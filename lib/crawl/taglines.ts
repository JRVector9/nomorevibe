import { isDeepStrictEqual } from "node:util";
import { assertJobLeaseAtWallTime, requestJob, type JobLease } from "@/lib/jobs/control";
import { emitPipelineEvent } from "@/lib/observability/review-pipeline";
import { TAGLINE_MODEL, taglineEvidence, taglineHash } from "./tagline";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, crawlTaglines, jobs, modelCapacityRequests, type CrawlCandidate, type CrawlDocument, type CrawlTagline } from "@/lib/db/schema";
import type { TaglineEvidenceSource } from "./tagline";
import { lockPipelineInputStages } from "./pipeline-stage-context";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobBatchAdmission } from "@/lib/jobs/batch-repository";
import { RoleLeaseLostError, type RoleLease } from "@/lib/jobs/role-leader";
import { JobLeaseLostError, STALE_LOCK_MS } from "@/lib/jobs/lease";
import { lockModelCapacityCallerControl, lockCrawlTaglineModelCapacityDispatch, finishCrawlTaglineModelCapacityDispatch,
  type CrawlTaglineContinuation } from "@/lib/llm/capacity-repository";
import { crawlTaglineMemberSchema, crawlTaglineGenerationHash, crawlTaglineInputHash, crawlTaglineLogicalWorkKey,
  crawlTaglineDispatchBindingSchema, crawlTaglineGatewayTerminalEvidenceSchema, crawlTaglineMemberKeys,
  type CrawlTaglineInput, type CrawlTaglineMember, type CrawlTaglineModelDispatch, type CrawlTaglineDispatchBinding,
  type CrawlTaglineParent, type ModelCapacityReservation, type ModelCapacityRequestIdentity } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { reviewHash } from "./agent-review-contract";
import { mergeWithDefaults } from "./settings";
import type { PreparedCrawlTaglineGatewayCall } from "./agent-review-gateway";
import type { CrawlTaglineCapacityOutcome } from "./tagline-model-capacity";

/**
 * 지은 소개의 보관과 대기열.
 *
 * 짓는 일(게이트웨이 호출)은 tagline.ts, 고르고 남기는 일은 여기다 — translate.ts/translations.ts 와 같다.
 */

/** 이만큼 실패하면 손을 뗀다. 남은 건 사람이 본다 */
const MAX_ATTEMPTS = 5;

export type TaglineTask = { candidate: CrawlCandidate; document: CrawlDocument; written: CrawlTagline | null;
  readyAgeMinutes: number };

/**
 * 소개를 지어 줘야 하는 후보.
 *
 * 소개가 없어 발행이 멈춘 후보다 — 자동 후보와, 사람이 승인했지만 소개가 없어 멈춘 후보(2026-10-14, publish.ts).
 * 소개를 짓는 일은 사람의 결정을 뒤집지 않는다 — 승인을 발행까지 잇는다. 다시 집는 경우는 셋 —
 * 아직 한 번도 안 지었거나, 실패가 다시 볼 때가 됐거나, **지은 뒤에 원본이 바뀌었거나**.
 * 세 번째가 있어야 "증거로는 알 수 없다"(빈 줄)로 남은 후보가 페이지가 바뀌었을 때 다시 불린다.
 * 원본이 그대로면 잡이 해시를 보고 부르지 않고 넘어간다(recordTaglineResult의 reuse).
 */
export async function pendingTaglines(limit: number): Promise<TaglineTask[]> {
  const rows = await db.select({ candidate: crawlCandidates, document: crawlDocuments, written: crawlTaglines,
    readyAgeMinutes: sql<number>`extract(epoch from (localtimestamp - ${crawlCandidates.updatedAt})) / 60` })
    .from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .leftJoin(crawlTaglines, eq(crawlTaglines.repo, crawlCandidates.repo))
    .where(and(
      eq(crawlCandidates.state, "needs_review"),
      eq(crawlCandidates.reason, "no_description"),
      inArray(crawlCandidates.decidedBy, ["auto", "admin"]),
      // 사람이 적은 줄은 다시 짓지 않는다 — 그 사람이 페이지를 보고 적었다
      sql`${crawlTaglines.writtenBy} is null`,
      sql`(${crawlTaglines.repo} is null
        or (${crawlTaglines.errorCode} is not null and ${crawlTaglines.attempts} < ${MAX_ATTEMPTS}
            and (${crawlTaglines.retryAt} is null or ${crawlTaglines.retryAt} <= now()))
        or ${crawlTaglines.documentAt} is distinct from ${crawlDocuments.fetchedAt})`,
    ))
    // 오래 기다린 것부터. 실패한 것이 새 후보를 밀어내지 않도록 시도 적은 순이 먼저다
    .orderBy(sql`coalesce(${crawlTaglines.attempts}, 0) asc, ${crawlCandidates.updatedAt} asc`)
    .limit(limit);
  return rows.map((row) => ({ candidate: row.candidate, document: row.document,
    written: row.written ?? null, readyAgeMinutes: Number(row.readyAgeMinutes) }));
}

type AutomaticTaglineResult =
  | { kind: "success"; tagline: string; source: TaglineEvidenceSource; model: string }
  | { kind: "failure"; error: string }
  | { kind: "reuse" };

/** A worker result, source CAS, release and wake-up are a single fenced transaction. */
export async function recordTaglineResult(task: TaglineTask, lease: JobLease, result: AutomaticTaglineResult, expectation?: CrawlTaglineWriteExpectation) {
  if (expectation) return recordReservedCrawlTagline(task, lease, result, expectation);
  let request: Awaited<ReturnType<typeof requestJob>> | undefined;
  const recorded = await db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, task.candidate.id)).for("update");
    const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.id, task.document.id)).for("share");
    const [written] = await tx.select().from(crawlTaglines).where(eq(crawlTaglines.repo, task.candidate.repo)).for("update");
    if (!candidate || candidate.state !== "needs_review" || candidate.reason !== "no_description" || !["auto", "admin"].includes(candidate.decidedBy ?? "")
      || written?.writtenBy || !isDeepStrictEqual(candidate, task.candidate) || !isDeepStrictEqual(document, task.document)
      || !isDeepStrictEqual(written ?? null, task.written)) return { stored: false, released: false };
    const sourceHash = taglineHash(taglineEvidence(candidate.repo, document!));
    let line = "";
    if (result.kind === "reuse") {
      if (!written || written.errorCode || written.sourceHash !== sourceHash) return { stored: false, released: false };
      line = written.tagline;
      await tx.update(crawlTaglines).set({ documentAt: document!.fetchedAt, updatedAt: sql`now()` })
        .where(eq(crawlTaglines.repo, candidate.repo));
    } else {
      line = result.kind === "success" ? result.tagline.slice(0, 200) : "";
      const common = { sourceHash, documentAt: document!.fetchedAt, updatedAt: sql`now()`,
        errorCode: result.kind === "failure" ? result.error.slice(0, 60) : null };
      const [saved] = await tx.insert(crawlTaglines).values({ repo: candidate.repo, ...common, tagline: line,
        source: result.kind === "success" ? result.source : "page", model: result.kind === "success" ? result.model : "",
        attempts: 1, retryAt: result.kind === "failure" ? sql`now() + interval '5 minutes'` : null,
      }).onConflictDoUpdate({ target: crawlTaglines.repo,
        set: { ...common, attempts: sql`${crawlTaglines.attempts} + 1`,
          ...(result.kind === "success" ? { tagline: line, source: result.source, model: result.model, retryAt: null }
            : { retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${crawlTaglines.attempts}))` }),
        },
        // An absent row can be inserted by an administrator after our SELECT. It always wins.
        setWhere: task.written ? sql`${crawlTaglines.writtenBy} is null AND date_trunc('milliseconds', ${crawlTaglines.updatedAt}) = ${task.written.updatedAt.toISOString()}::timestamp` : sql`false`,
      }).returning({ repo: crawlTaglines.repo });
      if (!saved) return { stored: false, released: false };
    }
    const released = Boolean(line);
    if (released) {
      await tx.update(crawlCandidates).set({ state: "approved", reason: "passed", updatedAt: new Date() })
        .where(eq(crawlCandidates.id, candidate.id));
      request = await requestJob("crawl-publish", tx);
    }
    // Scheduler locks publish before tagline. Check ownership last, rolling everything back on loss.
    await assertJobLeaseAtWallTime(tx, lease);
    return { stored: true, released };
  });
  if (recorded.stored) emitPipelineEvent("committed", { stage: "text", candidateId: task.candidate.id, job: lease.name, state: result.kind });
  if (request) emitPipelineEvent("requested", { stage: "text", candidateId: task.candidate.id,
    nextJob: request.job, requestedVersion: request.requestedVersion });
  return recorded;
}

/**
 * 사람이 적은 한 줄을 남긴다. 심사에서 페이지를 열어 본 사람이 적는다.
 *
 * 모델이 지은 줄을 덮어써도 된다 — 사람이 그 줄을 보고도 직접 적기로 한 것이다.
 */
export async function writeTaglineByHand(row: { repo: string; tagline: string; by: string; documentAt: Date }): Promise<void> {
  const line = row.tagline.trim().slice(0, 200);
  await db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    await tx.insert(crawlTaglines).values({
      repo: row.repo, tagline: line, source: "page", model: "", sourceHash: "",
      documentAt: row.documentAt, attempts: 0, errorCode: null, retryAt: null, writtenBy: row.by, updatedAt: sql`now()`,
    }).onConflictDoUpdate({
      target: crawlTaglines.repo,
      set: { tagline: line, source: "page", model: "", sourceHash: "", documentAt: row.documentAt,
        errorCode: null, retryAt: null, writtenBy: row.by, updatedAt: sql`now()` },
    });
  });
}

/** 발행이 쓸 줄. 지을 때 본 원본이 지금 원본과 같을 때만 준다(사람이 적은 줄은 원본이 바뀌어도 쓴다) */
export async function writtenTagline(repo: string): Promise<CrawlTagline | undefined> {
  const [row] = await db.select().from(crawlTaglines).where(eq(crawlTaglines.repo, repo));
  return row;
}


type Raw = Record<string, unknown>;
type CrawlRole = CrawlTaglineDispatchBinding["role"];
type CrawlSnapshot = { candidate: Raw; document: Raw; cache: Raw | null };
type CrawlInitial = { kind: "ready"; member: CrawlTaglineMember; role: CrawlRole; snapshot: CrawlSnapshot };
export type CrawlTaglineWriteExpectation = Readonly<{ kind: "crawl_tagline_write" }>;
type Writer = { task: TaglineTask; job: JobLease; initial: CrawlInitial; dispatch: CrawlTaglineModelDispatch;
  history: CrawlTaglineContinuation | null; used: boolean };
const crawlWrites = new WeakMap<CrawlTaglineWriteExpectation, Writer>();
class CrawlTaglineChanged extends Error {}
const skipped = () => ({ kind: "skipped" as const, reason: "source_changed" });
function issueCrawlWriter(writer: Writer): CrawlTaglineWriteExpectation {
  const expectation = Object.freeze({ kind: "crawl_tagline_write" as const }); crawlWrites.set(expectation, structuredClone(writer)); return expectation;
}
async function lockCrawlRole(tx: ProductTransaction, lease: RoleLease): Promise<CrawlRole> {
  const [row] = await tx.execute<{ raw: Raw }>(sql`SELECT to_jsonb(r) AS raw FROM role_leases r WHERE role='text' FOR SHARE`);
  const raw = row?.raw;
  if (lease.role !== "text" || !raw || raw.owner_instance_id !== lease.instanceId || raw.owner_boot_id !== lease.bootId
    || raw.owner_release !== lease.release || raw.epoch !== lease.epoch) throw new RoleLeaseLostError();
  return crawlTaglineDispatchBindingSchema.shape.role.parse({ role: "text", instanceId: lease.instanceId, bootId: lease.bootId,
    release: lease.release, epoch: lease.epoch, kind: raw.owner_kind, batch: lease.batchVersion === 1
      ? { mode: "versioned", host: lease.host, batchEpoch: lease.batchEpoch } : { mode: "legacy" } });
}
function roleLeaseFor(role: CrawlRole): RoleLease {
  return { role: "text", instanceId: role.instanceId, bootId: role.bootId, release: role.release, epoch: role.epoch, kind: role.kind,
    ...(role.batch.mode === "versioned" ? { batchVersion: 1 as const, host: role.batch.host, batchEpoch: role.batch.batchEpoch } : {}) };
}
async function crawlWall(tx: ProductTransaction, role: CrawlRole, job: JobLease, dispatch?: CrawlTaglineModelDispatch) {
  const request = dispatch ? sql`EXISTS (SELECT 1 FROM model_capacity_requests WHERE request_id=${dispatch.requestId}::uuid
    AND token=${dispatch.token}::uuid AND owner_instance_id=${dispatch.owner.instanceId} AND owner_boot_id=${dispatch.owner.bootId}::uuid
    AND epoch=${dispatch.epoch} AND revision=${dispatch.revision} AND policy_hash=${dispatch.policyHash} AND state='dispatched'
    AND dispatch_binding_hash=${dispatch.bindingHash} AND dispatch_binding=${JSON.stringify(dispatch.binding)}::text::jsonb
    AND reserved_until>clock_timestamp())` : sql`true`;
  const [wall] = await tx.execute<{ role_live: boolean; job_live: boolean; live: boolean }>(sql`SELECT
    EXISTS (SELECT 1 FROM role_leases WHERE role='text' AND owner_instance_id=${role.instanceId} AND owner_boot_id=${role.bootId}
      AND owner_release=${role.release} AND owner_kind=${role.kind} AND epoch=${role.epoch} AND lease_until>clock_timestamp()) AS role_live,
    EXISTS (SELECT 1 FROM jobs WHERE name=${job.name} AND lease_token=${job.token}
      AND locked_at>=clock_timestamp()-${STALE_LOCK_MS}*interval '1 millisecond') AS job_live, ${request} AS live`);
  if (!wall?.role_live) throw new RoleLeaseLostError();
  if (!wall.job_live) throw new JobLeaseLostError();
  if (!wall.live) throw new ModelCapacityDeferredError("reservation_lost");
}
async function lockCrawlJobs(tx: ProductTransaction, job: JobLease) {
  // 빈 행도 같은 순서로 만든 뒤 잠근다. publish wake-up은 아래 최종 writer에서만 증가한다.
  for (const name of ["crawl-publish", "crawl-tagline"]) await tx.insert(jobs).values({ name }).onConflictDoNothing();
  await tx.select({ name: jobs.name }).from(jobs).where(inArray(jobs.name, ["crawl-publish", "crawl-tagline"])).orderBy(jobs.name).for("update");
  await assertJobLeaseAtWallTime(tx, job, "update");
}
async function lockCrawlSources(tx: ProductTransaction, task: TaglineTask): Promise<CrawlInitial["snapshot"]> {
  const [candidate] = await tx.select({ row: crawlCandidates, raw: sql<Raw>`to_jsonb(${crawlCandidates})` })
    .from(crawlCandidates).where(eq(crawlCandidates.id, task.candidate.id)).for("update");
  const [document] = await tx.select({ row: crawlDocuments, raw: sql<Raw>`to_jsonb(${crawlDocuments})` })
    .from(crawlDocuments).where(eq(crawlDocuments.id, task.document.id)).for("share");
  const [settings] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("share");
  const [cache] = await tx.select({ row: crawlTaglines, raw: sql<Raw>`to_jsonb(${crawlTaglines})`,
    due: sql<boolean>`${crawlTaglines.retryAt} IS NULL OR ${crawlTaglines.retryAt}<=clock_timestamp()` })
    .from(crawlTaglines).where(eq(crawlTaglines.repo, task.candidate.repo)).for("update");
  if (!candidate || !document || !mergeWithDefaults(settings?.values).enabled || candidate.row.state !== "needs_review"
    || candidate.row.reason !== "no_description" || !["auto", "admin"].includes(candidate.row.decidedBy ?? "") || cache?.row.writtenBy
    || candidate.row.repo !== document.row.repo || !isDeepStrictEqual(candidate.row, task.candidate) || !isDeepStrictEqual(document.row, task.document)
    || !isDeepStrictEqual(cache?.row ?? null, task.written)) throw new CrawlTaglineChanged();
  const sourceHash = taglineHash(taglineEvidence(candidate.row.repo, document.row));
  if (cache && ((!cache.row.errorCode && cache.row.sourceHash === sourceHash)
    || cache.raw.document_at === document.raw.fetched_at && !(cache.row.errorCode && cache.row.attempts < MAX_ATTEMPTS && cache.due))) throw new CrawlTaglineChanged();
  return { candidate: candidate.raw, document: document.raw, cache: cache?.raw ?? null };
}
function crawlMember(task: TaglineTask, snapshot: CrawlSnapshot): CrawlTaglineMember {
  return crawlTaglineMemberSchema.parse({ candidateId: task.candidate.id, repo: task.candidate.repo,
    sourceHash: taglineHash(taglineEvidence(task.candidate.repo, task.document)), candidateRowIdentityHash: reviewHash(snapshot.candidate),
    documentRowIdentityHash: reviewHash(snapshot.document), cache: snapshot.cache ? { kind: "present",
      rowIdentityHash: reviewHash(snapshot.cache), attempts: snapshot.cache.attempts } : { kind: "absent" } });
}
type PreparationOptions = { roleLease: RoleLease; call?: PreparedCrawlTaglineGatewayCall; previous?: CrawlTaglineWriteExpectation;
  reserved?: { reservation: ModelCapacityReservation; identity: ModelCapacityRequestIdentity; input: CrawlTaglineInput; initial: CrawlInitial } };
export type CrawlTaglinePreparation = { kind: "disabled" } | ReturnType<typeof skipped> | CrawlInitial
  | { kind: "ready"; dispatch: CrawlTaglineModelDispatch; expectation: CrawlTaglineWriteExpectation };
export async function prepareCrawlTaglineDispatch(value: TaglineTask, job: JobLease, valueOptions: PreparationOptions): Promise<CrawlTaglinePreparation> {
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  const task = structuredClone(value), lease = structuredClone(job), roleLease = structuredClone(valueOptions.roleLease);
  const reserved = valueOptions.reserved && structuredClone(valueOptions.reserved), call = valueOptions.call;
  const prior = valueOptions.previous && crawlWrites.get(valueOptions.previous);
  if (valueOptions.previous && (!prior || prior.used || !isDeepStrictEqual(prior.task, task) || !isDeepStrictEqual(prior.job, lease)))
    throw new Error("invalid_crawl_tagline_write_expectation");
  if (lease.name !== "crawl-tagline") throw new Error("crawl_tagline_job_lease_required");
  let writer: Writer | undefined;
  try {
    const prepared = await onPrimary(() => db.transaction(async tx => {
      const lock = reserved ? await lockCrawlTaglineModelCapacityDispatch(tx, reserved) : null;
      if (reserved && !lock) throw new ModelCapacityDeferredError("reservation_lost");
      const control = lock?.control ?? await lockModelCapacityCallerControl(tx);
      if (!reserved && !prior && control.mode === "disabled") return { kind: "disabled" } as const;
      if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "draining" ? "draining" : "disabled");
      if (!control.policy?.routes.some(route => route.routeId === "crawl-tagline" && route.provider === "abcllm" && route.model === TAGLINE_MODEL))
        throw new ModelCapacityDeferredError("unmapped");
      await assertJobBatchAdmission(tx, lease.name, roleLease);
      const role = await lockCrawlRole(tx, roleLease);
      await lockPipelineInputStages(tx);
      const snapshot = await lockCrawlSources(tx, task), member = crawlMember(task, snapshot);
      const initial: CrawlInitial = { kind: "ready", member, role, snapshot };
      if (prior && !isDeepStrictEqual(prior.initial.snapshot, snapshot)) throw new CrawlTaglineChanged();
      if (reserved && (!isDeepStrictEqual(initial, reserved.initial) || !isDeepStrictEqual(member, reserved.input.member))) throw new CrawlTaglineChanged();
      await lockCrawlJobs(tx, lease);
      if (!reserved) { await crawlWall(tx, role, lease); return initial; }
      if (!call || call.model !== TAGLINE_MODEL || call.sourceHash !== member.sourceHash) throw new CrawlTaglineChanged();
      const binding = crawlTaglineDispatchBindingSchema.parse({ ...reserved.input, kind: "crawl_tagline_gateway", version: 1,
        generationHash: crawlTaglineGenerationHash(reserved.input), logicalWorkKey: crawlTaglineLogicalWorkKey(reserved.input), inputHash: crawlTaglineInputHash(reserved.input),
        provider: "abcllm", routeId: "crawl-tagline", wireHash: call.wireHash, servingContractHash: call.servingContractHash,
        totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job: lease, role });
      const dispatch = await finishCrawlTaglineModelCapacityDispatch(tx, lock!, binding);
      await crawlWall(tx, role, lease, dispatch); // request/event를 포함한 모든 wait 뒤의 벽
      writer = { task, job: lease, initial, dispatch, history: null, used: false };
      return { kind: "ready", dispatch } as const;
    }));
    return prepared.kind === "ready" && "dispatch" in prepared ? { ...prepared, expectation: issueCrawlWriter(writer!) } : prepared;
  } catch (error) { if (error instanceof CrawlTaglineChanged) return skipped(); throw error; }
}

/** 저장된 JSON은 권한이 아니다. Control SHARE 뒤 실제 request와 terminal 행을 고정 검증한다. */
async function storedCrawlPhase(tx: ProductTransaction, parent: CrawlTaglineParent, initial: CrawlInitial, ordinal: 1 | 2) {
  const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, parent.requestId)).for("share");
  const parsed = crawlTaglineGatewayTerminalEvidenceSchema.safeParse(row?.terminalEvidence);
  if (!row || row.state !== "settled" || !row.settledAt || !row.dispatchedAt || !parsed.success) throw new CrawlTaglineChanged();
  const evidence = parsed.data, dispatch = evidence.dispatch, binding = dispatch.binding;
  if (dispatch.requestId !== row.requestId || dispatch.token !== row.token || dispatch.owner.instanceId !== row.ownerInstanceId
    || dispatch.owner.bootId !== row.ownerBootId || dispatch.epoch !== row.epoch || dispatch.revision !== row.revision || dispatch.policyHash !== row.policyHash
    || row.class !== "background" || row.pool !== "text" || row.routeId !== "crawl-tagline" || row.provider !== "abcllm" || row.model !== TAGLINE_MODEL
    || row.workKey !== `${binding.logicalWorkKey}:${binding.inputHash}` || row.logicalWorkKey !== binding.logicalWorkKey
    || !isDeepStrictEqual(row.logicalMemberKeys, crawlTaglineMemberKeys(binding.member))
    || !isDeepStrictEqual(row.dispatchBinding, binding) || row.dispatchBindingHash !== dispatch.bindingHash
    || row.terminalEvidenceHash !== reviewHash(evidence) || !isDeepStrictEqual(row.terminalEvidence, evidence)
    || parent.bindingHash !== dispatch.bindingHash || parent.responseHash !== evidence.responseHash
    || binding.askOrdinal !== ordinal || binding.generationHash !== crawlTaglineGenerationHash({ member: initial.member, model: TAGLINE_MODEL })) throw new CrawlTaglineChanged();
  return evidence;
}
async function noSecondCrawlPhase(tx: ProductTransaction, initial: CrawlInitial) {
  const input = { member: initial.member, model: TAGLINE_MODEL, askOrdinal: 2 as const,
    parent: { requestId: "00000000-0000-4000-8000-000000000000", bindingHash: "0".repeat(64), responseHash: "0".repeat(64) } };
  const [second] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests)
    .where(and(eq(modelCapacityRequests.logicalWorkKey, crawlTaglineLogicalWorkKey(input)),
      inArray(modelCapacityRequests.state, ["waiting", "reserved", "dispatched", "indeterminate", "settled"]))).limit(1);
  if (second) throw new ModelCapacityDeferredError("dispatched");
}
async function checkCrawlHistory(tx: ProductTransaction, initial: CrawlInitial, history: CrawlTaglineContinuation, writing = true) {
  if (history.generationHash !== crawlTaglineGenerationHash({ member: initial.member, model: TAGLINE_MODEL })) throw new CrawlTaglineChanged();
  const first = await storedCrawlPhase(tx, history.first, initial, 1);
  if (!isDeepStrictEqual(first.outcome, history.first.outcome)) throw new CrawlTaglineChanged();
  if (!history.second) { if (writing || !first.outcome.ok || first.outcome.tagline) await noSecondCrawlPhase(tx, initial); return first; }
  const second = await storedCrawlPhase(tx, history.second, initial, 2);
  if (!first.outcome.ok || first.outcome.tagline || !isDeepStrictEqual(second.dispatch.binding.parent,
    { requestId: first.dispatch.requestId, bindingHash: first.dispatch.bindingHash, responseHash: first.responseHash })
    || !isDeepStrictEqual(second.outcome, history.second.outcome)) throw new CrawlTaglineChanged();
  return second;
}
export async function prepareCrawlTaglineHistory(value: TaglineTask, job: JobLease,
  options: { initial: CrawlInitial; history: CrawlTaglineContinuation }): Promise<CrawlTaglineCapacityOutcome | ReturnType<typeof skipped>> {
  const task = structuredClone(value), lease = structuredClone(job), initial = structuredClone(options.initial), history = structuredClone(options.history);
  if (currentReplayDb()) throw new Error("model_capacity_replay_unsupported");
  if (lease.name !== "crawl-tagline") throw new Error("crawl_tagline_job_lease_required");
  try {
    const evidence = await onPrimary(() => db.transaction(async tx => {
      await lockModelCapacityCallerControl(tx);
      const selected = await checkCrawlHistory(tx, initial, history, false);
      await assertJobBatchAdmission(tx, lease.name, roleLeaseFor(initial.role));
      if (!isDeepStrictEqual(await lockCrawlRole(tx, roleLeaseFor(initial.role)), initial.role)) throw new RoleLeaseLostError();
      await lockPipelineInputStages(tx);
      if (!isDeepStrictEqual(await lockCrawlSources(tx, task), initial.snapshot)) throw new CrawlTaglineChanged();
      await lockCrawlJobs(tx, lease); await crawlWall(tx, initial.role, lease);
      return selected;
    }));
    return { kind: "result", result: evidence.outcome, askOrdinal: evidence.dispatch.binding.askOrdinal,
      parent: { requestId: evidence.dispatch.requestId, bindingHash: evidence.dispatch.bindingHash, responseHash: evidence.responseHash },
      expectation: issueCrawlWriter({ task, job: lease, initial, dispatch: evidence.dispatch, history, used: false }) };
  } catch (error) { if (error instanceof CrawlTaglineChanged) return skipped(); throw error; }
}
async function recordReservedCrawlTagline(value: TaglineTask, job: JobLease, valueResult: AutomaticTaglineResult, expectation: CrawlTaglineWriteExpectation) {
  const proof = crawlWrites.get(expectation), task = structuredClone(value), lease = structuredClone(job), result = structuredClone(valueResult);
  if (!proof || proof.used || !isDeepStrictEqual(task, proof.task) || !isDeepStrictEqual(lease, proof.job)
    || result.kind === "reuse" || result.kind === "success" && result.model !== TAGLINE_MODEL) throw new Error("invalid_crawl_tagline_write_expectation");
  proof.used = true;
  let request: Awaited<ReturnType<typeof requestJob>> | undefined;
  try {
    const recorded = await onPrimary(() => db.transaction(async tx => {
      await lockModelCapacityCallerControl(tx); // disabled에서도 역사적 정산을 읽고 현재 full raw로 쓰기를 판단한다
      if (proof.history) {
        const evidence = await checkCrawlHistory(tx, proof.initial, proof.history);
        const outcome = result.kind === "success" ? { ok: true, tagline: result.tagline, source: result.source } : { ok: false, error: result.error };
        if (!isDeepStrictEqual(evidence.outcome, outcome)) throw new CrawlTaglineChanged();
      }
      else {
        const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, proof.dispatch.requestId)).for("share");
        if (!row || !["settled", "dispatched", "indeterminate"].includes(row.state) || row.token !== proof.dispatch.token
          || row.ownerInstanceId !== proof.dispatch.owner.instanceId || row.ownerBootId !== proof.dispatch.owner.bootId
          || row.epoch !== proof.dispatch.epoch || row.revision !== proof.dispatch.revision || row.policyHash !== proof.dispatch.policyHash
          || row.routeId !== "crawl-tagline" || row.provider !== "abcllm" || row.model !== TAGLINE_MODEL || row.class !== "background" || row.pool !== "text"
          || row.workKey !== `${proof.dispatch.binding.logicalWorkKey}:${proof.dispatch.binding.inputHash}`
          || row.logicalWorkKey !== proof.dispatch.binding.logicalWorkKey || !isDeepStrictEqual(row.logicalMemberKeys, crawlTaglineMemberKeys(proof.dispatch.binding.member))
          || row.dispatchBindingHash !== proof.dispatch.bindingHash || !isDeepStrictEqual(row.dispatchBinding, proof.dispatch.binding)) throw new CrawlTaglineChanged();
        if (row.state === "settled") {
          const evidence = await storedCrawlPhase(tx, { requestId: row.requestId, bindingHash: proof.dispatch.bindingHash,
            responseHash: (row.terminalEvidence as { responseHash?: string })?.responseHash ?? "" }, proof.initial, proof.dispatch.binding.askOrdinal);
          const outcome = result.kind === "success" ? { ok: true, tagline: result.tagline, source: result.source } : { ok: false, error: result.error };
          if (!isDeepStrictEqual(evidence.outcome, outcome)) throw new CrawlTaglineChanged();
        }
        if (proof.dispatch.binding.askOrdinal === 1) await noSecondCrawlPhase(tx, proof.initial);
        else {
          const first = await storedCrawlPhase(tx, proof.dispatch.binding.parent!, proof.initial, 1);
          if (!first.outcome.ok || first.outcome.tagline) throw new CrawlTaglineChanged();
        }
      }
      await assertJobBatchAdmission(tx, lease.name, roleLeaseFor(proof.initial.role));
      if (!isDeepStrictEqual(await lockCrawlRole(tx, roleLeaseFor(proof.initial.role)), proof.initial.role)) throw new RoleLeaseLostError();
      await lockPipelineInputStages(tx);
      const snapshot = await lockCrawlSources(tx, task);
      if (!isDeepStrictEqual(snapshot, proof.initial.snapshot)) throw new CrawlTaglineChanged();
      await lockCrawlJobs(tx, lease);
      const line = result.kind === "success" ? result.tagline.slice(0, 200) : "", raw = snapshot.cache;
      const common = { sourceHash: proof.initial.member.sourceHash, documentAt: sql`${snapshot.document.fetched_at}::timestamp`, updatedAt: sql`now()`,
        errorCode: result.kind === "failure" ? result.error.slice(0, 60) : null };
      const saved = raw ? await tx.update(crawlTaglines).set({ ...common, attempts: sql`${crawlTaglines.attempts}+1`,
        ...(result.kind === "success" ? { tagline: line, source: result.source, model: result.model, retryAt: null }
          : { retryAt: sql`now()+least(interval '24 hours',interval '5 minutes'*power(2,${crawlTaglines.attempts}))` }) })
        .where(and(eq(crawlTaglines.repo, task.candidate.repo), sql`to_jsonb(${crawlTaglines})=${JSON.stringify(raw)}::text::jsonb`)).returning({ repo: crawlTaglines.repo })
        : await tx.insert(crawlTaglines).values({ repo: task.candidate.repo, ...common, tagline: line,
          source: result.kind === "success" ? result.source : "page", model: result.kind === "success" ? result.model : "", attempts: 1,
          retryAt: result.kind === "failure" ? sql`now()+interval '5 minutes'` : null }).onConflictDoNothing({ target: crawlTaglines.repo }).returning({ repo: crawlTaglines.repo });
      if (saved.length !== 1) throw new CrawlTaglineChanged();
      if (line) {
        const updated = await tx.update(crawlCandidates).set({ state: "approved", reason: "passed", updatedAt: new Date() })
          .where(and(eq(crawlCandidates.id, task.candidate.id), sql`to_jsonb(${crawlCandidates})=${JSON.stringify(snapshot.candidate)}::text::jsonb`)).returning({ id: crawlCandidates.id });
        if (updated.length !== 1) throw new CrawlTaglineChanged();
        request = await requestJob("crawl-publish", tx);
      }
      await crawlWall(tx, proof.initial.role, lease);
      return { stored: true, released: Boolean(line) };
    }));
    emitPipelineEvent("committed", { stage: "text", candidateId: task.candidate.id, job: lease.name, state: result.kind });
    if (request) emitPipelineEvent("requested", { stage: "text", candidateId: task.candidate.id, nextJob: request.job, requestedVersion: request.requestedVersion });
    return recorded;
  } catch (error) { if (error instanceof CrawlTaglineChanged) return { stored: false, released: false }; throw error; }
}
