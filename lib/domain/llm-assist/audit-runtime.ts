import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { fetchCapped } from "@/lib/net/fetch";
import { extractTextSample } from "@/lib/net/normalize";
import { readmeText } from "@/lib/crawl/readme";
import { repositoryKey } from "@/lib/domain/products/repo-review";
import { actionAuditCandidateSchema, actionAuditPeriod, actionAuditSourceHash, buildBlindedActionAuditInput,
  independentAuditFamily, preferredAuditFamily, readActionAuditPolicy, semanticConflictEligible,
  type ActionAuditCandidate } from "@/lib/domain/products/automated-action-audit";
import { enqueueSemanticActionException, loadAutomatedDecision, lockActionAuditCandidate, lockActionAuditInput,
  readActionAuditProtections, readCurrentActionAuditFacts, recordActionAuditCompletion,
  type AuditTransaction } from "@/lib/domain/products/automated-action-audit-repository";
import { assistHash, assistInputHash, type AssistInput, type AssistSource } from "./contracts";
export class AuditDispatchBudgetExceededError extends Error {
  constructor() { super("audit_weekly_budget_exhausted"); this.name = "AuditDispatchBudgetExceededError"; }
}

/** 공통 claim SQL의 w alias 전용이다. 일반 task에는 부모가 별도 OR 분기를 둔다. */
export function actionAuditClaimEligible(backendFamily: string): SQL<boolean> {
  return sql<boolean>`coalesce((w.task in ('decision_audit','semantic_exception') and (
    (w.source->'decision'->>'modelFamily'='qwen3.8-flash-next' and ${backendFamily}='deepseek-v4.1-flash-1017')
    or (w.source->'decision'->>'modelFamily' in ('deepseek-v4.1-flash-1017','gpt-oss-120b') and ${backendFamily}='qwen3.8-flash-next'))),false)`;
}

export function actionAuditBackendEligible(candidateValue: ActionAuditCandidate, backendFamily: string): boolean {
  const candidate = actionAuditCandidateSchema.parse(candidateValue);
  return preferredAuditFamily(candidate.decision.modelFamily) === backendFamily
    && independentAuditFamily(candidate.decision.modelFamily, backendFamily);
}

async function currentSource(url: string, kind: "page" | "repository" | "readme", signal: AbortSignal): Promise<AssistSource> {
  const result = await fetchCapped(url, { maxBytes: 128_000, timeoutMs: 8_000, allowTruncatedBody: true, signal });
  const observedAt = new Date().toISOString();
  if (!result.ok) {
    const status = result.reason === "http" ? result.status : null;
    return { sourceId: `${kind}:${url}`, kind, url, observedAt, revision: assistHash({ url, status, observedAt }),
      text: "", completeness: status !== null && [401, 403, 429, 999].includes(status) ? "blocked" : "missing", httpStatus: status };
  }
  const raw = result.body.toString("utf8"), text = kind === "readme" ? readmeText(raw, 32_001) : extractTextSample(raw, 32_001) ?? "";
  const blocked = [401, 403, 429, 999].includes(result.status)
    || /(?:verify you are human|checking your browser|just a moment|captcha|보안 확인)/i.test(text.slice(0, 2000));
  return { sourceId: `${kind}:${url}`, kind, url: result.finalUrl, observedAt,
    revision: assistHash({ url: result.finalUrl, status: result.status, raw, observedAt }), text: text.slice(0, 32_000),
    completeness: blocked ? "blocked" : result.truncated || text.length > 32_000 ? "truncated" : text.trim() ? "complete" : "missing",
    httpStatus: result.status };
}

export type ActionAuditCollection = { kind: "ready"; input: AssistInput }
  | { kind: "obsolete" | "waiting_evidence"; reason: string };

/** 짧은 DB 사진을 읽은 후 TX를 닫고 수집한다. 실제 dispatch 때 concrete proof를 다시 수행한다. */
export async function collectActionAuditInput(candidateValue: ActionAuditCandidate, options: { signal?: AbortSignal } = {}): Promise<ActionAuditCollection> {
  const candidate = actionAuditCandidateSchema.parse(candidateValue);
  const snapshot = await db.transaction(async tx => {
    if (!await lockActionAuditCandidate(tx, candidate)) return null;
    const facts = await readCurrentActionAuditFacts(tx, candidate.decision.task, candidate.product.id);
    const protections = await readActionAuditProtections(tx, candidate);
    const [row] = await tx.execute<{ repoUrl: string | null }>(sql`select repo_url as "repoUrl" from products where id=${candidate.product.id} for share`);
    return facts && protections ? { facts, protections, repoUrl: row?.repoUrl ?? null } : null;
  });
  if (!snapshot) return { kind: "obsolete", reason: "audit_source_changed" };
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(25_000)]);
  const urls: { url: string; kind: "page" | "repository" | "readme" }[] = [{ url: candidate.product.url, kind: "page" }];
  const repository = snapshot.facts.task === "repo" ? snapshot.facts.repositoryUrl : snapshot.repoUrl;
  if (repository && repository !== candidate.product.url) urls.push({ url: repository, kind: "repository" });
  const key = repository && repositoryKey(repository);
  if (key) urls.push({ url: `https://raw.githubusercontent.com/${key}/HEAD/README.md`, kind: "readme" });
  const fetched = await Promise.allSettled(urls.map(item => currentSource(item.url, item.kind, signal)));
  if (signal.aborted) return { kind: "waiting_evidence", reason: "audit_collection_timeout" };
  const sources = fetched.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  try {
    return { kind: "ready", input: buildBlindedActionAuditInput(candidate, sources, snapshot.protections, snapshot.facts) };
  } catch { return { kind: "waiting_evidence", reason: "audit_current_evidence_required" }; }
}

/** 원 family와 현재 근거·DB 보호를 실제로 읽는 native dispatch 연결점이다. */
export async function lockActionAuditRuntimeInput(tx: ProductTransaction, candidate: ActionAuditCandidate, input: AssistInput,
  backendFamily: string): Promise<boolean> {
  return actionAuditBackendEligible(candidate, backendFamily) && await lockActionAuditInput(tx, candidate, input);
}

export async function completeActionAuditRuntime(tx: ProductTransaction, value: Parameters<typeof recordActionAuditCompletion>[1]) {
  if (!actionAuditBackendEligible(value.candidate, value.auditorFamily)) return null;
  const [native] = await tx.execute(sql`select r.id from llm_assist_results r join llm_assist_work w on w.id=r.work_id
    join model_capacity_requests m on m.request_id=r.capacity_request_id and m.request_id=w.capacity_request_id
    where r.id=${value.resultId}::uuid and w.id=${value.workId}::uuid and w.task=${value.candidate.kind}
      and w.state='claimed' and r.work_revision=w.revision and r.model_family=${value.auditorFamily}
      and r.input_hash=${assistInputHash(value.input)} and w.input_hash=r.input_hash
      and w.source_hash=${actionAuditSourceHash(value.candidate)} and m.state='settled' and m.provider='local-direct'
      and m.dispatch_binding->>'kind'='local_model_direct' and m.dispatch_binding->'target'->>'kind'='assist'
      and m.dispatch_binding->'target'->>'purpose'='assist_review' and m.dispatch_binding->'target'->>'task'=w.task
      and m.dispatch_binding->'target'->>'workId'=w.id::text and m.dispatch_binding->'target'->>'workRevision'=w.revision::text
      and m.dispatch_binding->'target'->>'subjectId'=w.product_id::text and m.dispatch_binding->'target'->>'backendId'=r.backend_id
      and m.dispatch_binding->'target'->>'claimToken'=w.claim_token::text and m.dispatch_binding->>'inputHash'=r.input_hash
      and m.dispatch_binding->>'sourceRevisionHash'=w.source_hash and m.dispatch_binding->>'servingContractHash'=r.contract_hash
      and m.dispatch_binding->>'backendId'=r.backend_id and m.terminal_evidence->>'kind'='local_model_terminal'
      and m.terminal_evidence->>'responseHash'=r.response_hash for share of r,w,m`);
  return native ? recordActionAuditCompletion(tx, value) : null;
}

/** 현재 result와 같은 입력의 충분한 Qwen 상반 결과가 이미 있을 때만 제한 예외를 생산한다. */
export async function enqueueSemanticExceptionForResult(tx: AuditTransaction, resultId: string,
  reason: Parameters<typeof enqueueSemanticActionException>[1]["reason"],
  env: Readonly<Record<string, string | undefined>> = process.env): Promise<"not_eligible" | "budget_exhausted" | "disabled" | "queued" | "duplicate"> {
  if (reason !== "semantic_conflict") return "not_eligible";
  const config = readActionAuditPolicy(env);
  if (!config.enabled) return "disabled";
  z.uuid().parse(resultId);
  const current = await loadAutomatedDecision(tx, resultId);
  if (!current || current.modelFamily !== "qwen3.8-flash-next") return "not_eligible";
  const previous = await tx.execute<{ id: string }>(sql`select r.id from llm_assist_results r join llm_assist_work w on w.id=r.work_id
    where r.id<>${resultId}::uuid and w.product_id=${current.productId} and r.input_hash=${current.inputHash}
      and w.source_hash=${current.sourceHash} and r.model_family='qwen3.8-flash-next'
      and w.task in ('uptime','repo_move','intro_recheck') order by r.completed_at,r.id limit ${Math.min(config.policy.maxCandidates, 100)}`);
  for (const row of previous) {
    const other = await loadAutomatedDecision(tx, row.id);
    if (!other || !semanticConflictEligible("semantic_conflict", current, other)) continue;
    // 같은 쌍을 역순으로 재전달해도 원 decision과 주간 멱등 키가 같다.
    const [first, second] = [current, other].sort((a, b) => Number(b.applied) - Number(a.applied)
      || (a.resultId < b.resultId ? -1 : a.resultId > b.resultId ? 1 : 0));
    const at = new Date();
    return enqueueSemanticActionException(tx, { firstResultId: first.resultId, secondResultId: second.resultId, reason,
      periodStart: actionAuditPeriod(at), selectedAt: at.toISOString(), seedHash: assistHash(config.seed), policy: config.policy });
  }
  return "not_eligible";
}
