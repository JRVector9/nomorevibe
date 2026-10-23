import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ProductTransaction } from "./generation";
import { lockProductGeneration } from "./generation";
import { assistHash, assistInputHash, type AssistInput } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { ACTION_AUDIT_POLICY_VERSION, actionAuditCandidateSchema, actionAuditProductSchema, actionAuditSourceHash,
  automatedDecisionSchema, buildBlindedActionAuditInput, compareActionAudit, semanticConflictEligible, type ActionAuditCandidate, type ActionAuditComparison,
  currentActionAuditFactsSchema, type ActionAuditPolicy, type ActionAuditSubject, type AutomatedDecision } from "./automated-action-audit";

export type AuditTransaction = ProductTransaction;
export type FrozenActionAuditPeriod = { periodStart: string; selectedResultIds: string[] | null; exceptionCount: number };
const originJob = (task: AutomatedDecision["task"]) => task === "uptime" ? "uptime-ping" : task === "repo" ? "product-repo-review" : "product-intro-check";

/** 원본 common result/work에서 모델 provenance와 당시 근거를 함께 읽는다. 옛 unknown은 추측하지 않는다. */
export async function loadAutomatedDecisions(tx: AuditTransaction, input: { after: Date; before: Date; limit: number }): Promise<AutomatedDecision[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10000) throw new Error("invalid_audit_candidate_limit");
  const rows = await tx.execute(sql`select r.id as "resultId",w.id as "workId",w.product_id as "productId",
    case w.task when 'repo_move' then 'repo' when 'intro_recheck' then 'intro' else w.task end as task,
    r.model_family as "modelFamily",r.completed_at::text as "decidedAt",w.source_hash as "sourceHash",
    r.input_hash as "inputHash",snapshot.input->>'policyVersion' as "policyVersion",snapshot.input->>'promptVersion' as "promptVersion",r.applied,snapshot.input,r.outcome
    from llm_assist_results r join llm_assist_work w on w.id=r.work_id
    cross join lateral (select coalesce(nullif(to_jsonb(r)->'input','null'::jsonb),w.input) as input) snapshot
    where w.task in ('uptime','repo_move','intro_recheck') and snapshot.input is not null
      and octet_length(snapshot.input::text)<=262144 and octet_length(r.outcome::text)<=65536
      and r.completed_at >= ${input.after.toISOString()}::timestamp and r.completed_at <= ${input.before.toISOString()}::timestamp
    order by r.completed_at,r.id limit ${input.limit}`);
  return rows.flatMap(row => { const parsed = automatedDecisionSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
}

export async function loadAutomatedDecision(tx: AuditTransaction, resultId: string): Promise<AutomatedDecision | null> {
  const [row] = await tx.execute(sql`select r.id as "resultId",w.id as "workId",w.product_id as "productId",
    case w.task when 'repo_move' then 'repo' when 'intro_recheck' then 'intro' else w.task end as task,
    r.model_family as "modelFamily",r.completed_at::text as "decidedAt",w.source_hash as "sourceHash",
    r.input_hash as "inputHash",snapshot.input->>'policyVersion' as "policyVersion",snapshot.input->>'promptVersion' as "promptVersion",r.applied,snapshot.input,r.outcome
    from llm_assist_results r join llm_assist_work w on w.id=r.work_id
    cross join lateral (select coalesce(nullif(to_jsonb(r)->'input','null'::jsonb),w.input) as input) snapshot
    where r.id=${resultId}::uuid for share of r,w`);
  const parsed = automatedDecisionSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

async function lockedPeriod(tx: AuditTransaction, periodStart: string, seedHash: string, policy: ActionAuditPolicy) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`llm-action-audit:${periodStart}`}))`);
  const policyHash = assistHash(policy);
  await tx.execute(sql`insert into llm_assist_audit_periods(period_start,policy_hash,seed_hash,max_audits,max_exceptions)
    values (${periodStart}::date,${policyHash},${seedHash},${policy.maxAuditsPerWeek},${policy.maxExceptionsPerWeek}) on conflict do nothing`);
  const [period] = await tx.execute<{ period_start: string; policy_hash: string; seed_hash: string; selected_result_ids: string[] | null;
    exception_count: number }>(sql`select period_start::text,policy_hash,seed_hash,selected_result_ids,exception_count
      from llm_assist_audit_periods where period_start=${periodStart}::date for update`);
  if (!period || period.policy_hash !== policyHash || period.seed_hash !== seedHash) throw new Error("audit_period_configuration_changed");
  return period;
}

/** 이번 주 최초 표본 집합을 고정한다. 재실행 시 새 로그가 도착해도 추가 표본을 뽑지 않는다. */
export async function freezeActionAuditPeriod(tx: AuditTransaction, input: { periodStart: string; seedHash: string; policy: ActionAuditPolicy;
  selected: readonly AutomatedDecision[]; skippedUnknownFamily: number; candidatesClipped: boolean }): Promise<FrozenActionAuditPeriod> {
  const period = await lockedPeriod(tx, input.periodStart, input.seedHash, input.policy);
  if (period.selected_result_ids === null) {
    const ids = [...new Set(input.selected.map(item => item.resultId))];
    if (ids.length !== input.selected.length || ids.length > input.policy.maxAuditsPerWeek) throw new Error("invalid_frozen_audit_sample");
    await tx.execute(sql`update llm_assist_audit_periods set selected_result_ids=${JSON.stringify(ids)}::jsonb,frozen_at=clock_timestamp(),
      skipped_unknown_family=${input.skippedUnknownFamily},candidates_clipped=${input.candidatesClipped} where period_start=${input.periodStart}::date`);
    return { periodStart: input.periodStart, selectedResultIds: ids, exceptionCount: period.exception_count };
  }
  return { periodStart: period.period_start, selectedResultIds: period.selected_result_ids, exceptionCount: period.exception_count };
}

export async function readActionAuditProduct(tx: AuditTransaction, productId: number) {
  const [row] = await tx.execute(sql`select id,slug,url,updated_at::text as "updatedAt",status from products where id=${productId} for share`);
  return row ? actionAuditProductSchema.parse(row) : null;
}

export async function readCurrentActionAuditFacts(tx: AuditTransaction, subject: ActionAuditSubject, productId: number) {
  const [row] = await tx.execute<{ url: string; repoUrl: string | null; name: string; description: string; tagline: string; taglineSource: string }>(
    sql`select url,repo_url as "repoUrl",name,left(description,8000) as description,tagline,tagline_source as "taglineSource"
      from products where id=${productId} for share`);
  if (!row) return null;
  return currentActionAuditFactsSchema.parse(subject === "uptime" ? { task: subject, requestedUrl: row.url }
    : subject === "repo" ? { task: subject, repositoryUrl: row.repoUrl, productName: row.name, description: row.description }
      : { task: subject, tagline: row.tagline, taglineSource: row.taglineSource });
}

export async function readActionAuditProtections(tx: AuditTransaction, candidate: ActionAuditCandidate) {
  const [row] = await tx.execute<{ administratorReleased: boolean; makerProtected: boolean }>(sql`select
    exists(select 1 from product_evidence_audit a where a.slug=p.slug and a.action='admin.product.unban'
      and a.created_at>=${candidate.decision.decidedAt}::timestamp) as "administratorReleased",
    (p.tagline_source='maker' or p.claimed_at is not null or exists(select 1 from product_maker_members m where m.product_id=p.id
      and m.revoked_at is null)) as "makerProtected" from products p where p.id=${candidate.product.id} for share of p`);
  return row ?? null;
}

/** native dispatch와 최종 record가 같이 쓰는 concrete input proof. 외부 boolean 검증기를 받지 않는다. */
export async function lockActionAuditInput(tx: AuditTransaction, candidateValue: ActionAuditCandidate, input: AssistInput): Promise<boolean> {
  const candidate = actionAuditCandidateSchema.parse(candidateValue);
  if (!await lockActionAuditCandidate(tx, candidate)) return false;
  const facts = await readCurrentActionAuditFacts(tx, candidate.decision.task, candidate.product.id);
  const protections = await readActionAuditProtections(tx, candidate);
  const metadata = input.sources.find(source => source.sourceId === "current-subject" && source.kind === "metadata");
  const observed = metadata && Date.parse(metadata.observedAt);
  if (!facts || !protections || !metadata || observed === undefined || !Number.isFinite(observed)
    || observed > Date.now() || observed < Date.now()-300_000) return false;
  try {
    const expected = buildBlindedActionAuditInput(candidate, input.sources.filter(source => source.kind !== "metadata"), protections, facts, new Date(observed));
    return assistInputHash(expected) === assistInputHash(input);
  } catch { return false; }
}

/** 공통 claim TX의 dispatch fence. 제품 현재 세대와 원 result를 함께 고정한다. */
export async function lockActionAuditCandidate(tx: AuditTransaction, candidateValue: ActionAuditCandidate): Promise<boolean> {
  const candidate = actionAuditCandidateSchema.parse(candidateValue);
  if (!await lockProductGeneration(tx, candidate.product.id, candidate.product.slug)) return false;
  const current = await readActionAuditProduct(tx, candidate.product.id);
  if (!current || assistHash(current) !== assistHash(candidate.product)) return false;
  const decision = await loadAutomatedDecision(tx, candidate.decision.resultId);
  if (!decision || assistHash(decision) !== assistHash(candidate.decision)) return false;
  const [origin] = await tx.execute(sql`select name from jobs where name=${originJob(decision.task)}
    and (not_before is null or not_before<=clock_timestamp()) for share`);
  if (!origin) return false;
  if (candidate.conflict) {
    const other = await loadAutomatedDecision(tx, candidate.conflict.otherResultId);
    if (!other || assistHash(other.outcome) !== candidate.conflict.otherOutcomeHash || !semanticConflictEligible("semantic_conflict", decision, other)) return false;
  }
  return true;
}

async function queueCandidate(tx: AuditTransaction, candidate: ActionAuditCandidate): Promise<{ workId: string; created: boolean } | null> {
  const [control] = await tx.execute<{ revision: number }>(sql`select revision::float8 as revision from llm_assist_controls
    where task=${candidate.kind} and mode in ('shadow','confirm') and dispatch_enabled for share`);
  if (!control) return null;
  const hash = actionAuditSourceHash(candidate), id = randomUUID();
  const [inserted] = await tx.execute<{ id: string }>(sql`insert into llm_assist_work(id,task,product_id,origin_job,source_hash,source,
    policy_version,prompt_version,control_revision,priority)
    values (${id}::uuid,${candidate.kind},${candidate.product.id},${originJob(candidate.decision.task)},${hash},${JSON.stringify(candidate)}::jsonb,
      ${ACTION_AUDIT_POLICY_VERSION},${ASSIST_PROMPT_VERSION},${control.revision},${candidate.kind === "semantic_exception" ? 20 : 0})
    on conflict do nothing returning id`);
  if (inserted) return { workId: inserted.id, created: true };
  const [existing] = await tx.execute<{ id: string }>(sql`select id from llm_assist_work where task=${candidate.kind}
    and source->'decision'->>'resultId'=${candidate.decision.resultId} and source->>'periodStart'=${candidate.periodStart}`);
  return existing ? { workId: existing.id, created: false } : null;
}

export async function enqueueFrozenActionAudit(tx: AuditTransaction, candidateValue: ActionAuditCandidate): Promise<{ workId: string; created: boolean } | null> {
  const candidate = actionAuditCandidateSchema.parse(candidateValue);
  if (candidate.kind !== "decision_audit") throw new Error("decision_audit_kind_required");
  const [period] = await tx.execute(sql`select period_start from llm_assist_audit_periods where period_start=${candidate.periodStart}::date
    and frozen_at is not null and seed_hash=${candidate.seedHash} and selected_result_ids ? ${candidate.decision.resultId} for share`);
  if (!period || !await lockActionAuditCandidate(tx, candidate)) return null;
  return queueCandidate(tx, candidate);
}

/** 한도는 주간 DB 행을 잠근 같은 TX의 새 enqueue에만 소비한다. format/수집/대기 예외는 여기 오지 않는다. */
export async function enqueueSemanticActionException(tx: AuditTransaction, input: { firstResultId: string; secondResultId: string;
  reason: "capacity" | "transport" | "invalid_output" | "missing_evidence" | "semantic_conflict";
  periodStart: string; selectedAt: string; seedHash: string; policy: ActionAuditPolicy }): Promise<"not_eligible" | "budget_exhausted" | "disabled" | "queued" | "duplicate"> {
  if (input.reason !== "semantic_conflict") return "not_eligible";
  const first = await loadAutomatedDecision(tx, input.firstResultId), second = await loadAutomatedDecision(tx, input.secondResultId);
  if (!first || !second || !semanticConflictEligible(input.reason, first, second)) return "not_eligible";
  const period = await lockedPeriod(tx, input.periodStart, input.seedHash, input.policy);
  const product = await readActionAuditProduct(tx, first.productId);
  if (!product) return "not_eligible";
  const candidate: ActionAuditCandidate = { kind: "semantic_exception", product, decision: first, periodStart: input.periodStart,
    selectedAt: input.selectedAt, seedHash: input.seedHash, conflict: { otherResultId: second.resultId,
      otherOutcomeHash: assistHash(second.outcome), subject: first.task } };
  const [existing] = await tx.execute(sql`select id from llm_assist_work where task='semantic_exception'
    and source->'decision'->>'resultId'=${first.resultId} and source->>'periodStart'=${input.periodStart}`);
  if (existing) return "duplicate";
  if (period.exception_count >= input.policy.maxExceptionsPerWeek) return "budget_exhausted";
  if (!await lockActionAuditCandidate(tx, candidate)) return "not_eligible";
  const queued = await queueCandidate(tx, candidate);
  if (!queued) return "disabled";
  if (!queued.created) return "duplicate";
  await tx.execute(sql`update llm_assist_audit_periods set exception_count=exception_count+1 where period_start=${input.periodStart}::date`);
  return "queued";
}

/** common consumer가 result 선insert한 same TX. findings만 쓰며 제품·소개·차단 상태는 절대 갱신하지 않는다. */
export async function recordActionAuditCompletion(tx: AuditTransaction, value: { candidate: ActionAuditCandidate; workId: string; resultId: string;
  input: AssistInput; auditorFamily: string; outcome: unknown }): Promise<{ stored: boolean; comparison: ActionAuditComparison } | null> {
  const candidate = actionAuditCandidateSchema.parse(value.candidate);
  const comparison = compareActionAudit(candidate, value.input, value.outcome, value.auditorFamily);
  if (["invalid", "not_independent"].includes(comparison.status) || !await lockActionAuditInput(tx, candidate, value.input)) return null;
  const [result] = await tx.execute<{ id: string }>(sql`select r.id from llm_assist_results r join llm_assist_work w on w.id=r.work_id
    join llm_assist_controls c on c.task=w.task and c.mode in ('shadow','confirm') and c.dispatch_enabled and c.revision=w.control_revision
    where r.id=${value.resultId}::uuid and w.id=${value.workId}::uuid and w.task=${candidate.kind} and w.state='claimed'
      and r.work_revision=w.revision and r.capacity_request_id=w.capacity_request_id and r.model_family=${value.auditorFamily}
      and r.input_hash=${assistInputHash(value.input)} and w.input_hash=r.input_hash
      and w.source_hash=${actionAuditSourceHash(candidate)} and r.outcome=${JSON.stringify(value.outcome)}::jsonb
    for share of r,w,c`);
  if (!result) return null;
  const [stored] = await tx.execute(sql`insert into llm_assist_audit_findings(audit_result_id,original_result_id,work_id,period_start,
    subject,original_model_family,auditor_model_family,decision_at,audited_at,decision_source_hash,current_input_hash,comparison)
    values (${value.resultId}::uuid,${candidate.decision.resultId}::uuid,${value.workId}::uuid,${candidate.periodStart}::date,
      ${candidate.decision.task},${candidate.decision.modelFamily},${value.auditorFamily},${candidate.decision.decidedAt}::timestamp,
      clock_timestamp(),${candidate.decision.sourceHash},${assistInputHash(value.input)},${JSON.stringify(comparison)}::jsonb)
    on conflict do nothing returning audit_result_id`);
  return { stored: Boolean(stored), comparison };
}
