import { and, eq, sql } from "drizzle-orm";
import { operationsAudit, productHealth, products, llmAssistResults } from "@/lib/db/schema";
import { uptimeControl } from "@/lib/db/product-uptime-schema";
import type { ProductTransaction } from "./generation";
import { lockProductGeneration } from "./generation";
import { setStatusWithAudit } from "./repository";
import { eligibleUptimeAutoBanObservation, UPTIME_AUTO_BAN_THRESHOLD } from "./uptime-auto-ban";
import { assistHash, assistInputHash, ASSIST_POLICY_VERSION, ASSIST_SCHEMA_VERSION, validateAssistOutcome, type AssistInput,
  type AssistOutcome, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { uptimeCandidateSchema, type UptimeAssistCandidate } from "@/lib/domain/llm-assist/work";
import { assistOriginActive, lockAssistClaim, readAssistControl, type AssistWorkClaim } from "@/lib/domain/llm-assist/repository";
import { safeFetch } from "@/lib/net/fetch";
import { extractTextSample } from "@/lib/net/normalize";

/** 본문 상한은 잘림으로 기록한다. null·예외·접근 차단은 종료 증거가 아니다. */
export async function collectUptimeAssist(candidate: UptimeAssistCandidate, signal?: AbortSignal): Promise<AssistInput> {
  const now = new Date().toISOString();
  let finalUrl: string | null = null;
  let source: AssistSource = { sourceId: "current-page", kind: "page", url: candidate.product.url, observedAt: now,
    revision: assistHash({ url: candidate.product.url, observedAt: now }), text: "", completeness: "missing", httpStatus: null };
  const fetched = await safeFetch(candidate.product.url, "background", { signal });
  if (fetched) {
    finalUrl = fetched.finalUrl;
    const reader = fetched.response.body?.getReader();
    const chunks: Buffer[] = []; let bytes = 0, truncated = false;
    try {
      for (;;) {
        const next = await reader?.read();
        if (!next || next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 512_000) { truncated = true; await reader!.cancel(); break; }
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader?.releaseLock(); }
    const html = Buffer.concat(chunks).toString("utf8"), sample = extractTextSample(html, 32_001) ?? "";
    const blocked = [401, 403, 429, 999].includes(fetched.response.status)
      || /(?:verify you are human|checking your browser|just a moment|captcha|보안 확인)/i.test(sample.slice(0, 2000));
    source = { ...source, url: finalUrl, httpStatus: fetched.response.status, text: sample.slice(0, 32_000),
      revision: assistHash({ html, finalUrl, status: fetched.response.status, observedAt: now }),
      completeness: blocked ? "blocked" : truncated || sample.length > 32_000 ? "truncated" : sample.trim() ? "complete" : "missing" };
  }
  return { schemaVersion: ASSIST_SCHEMA_VERSION, task: "uptime", subject: { type: "product", id: candidate.product.id,
    revision: candidate.product.updatedAt }, policyVersion: ASSIST_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION,
    sources: [source], context: { requestedUrl: candidate.product.url, finalUrl, failureCount: candidate.health.failures,
      requiredFailures: UPTIME_AUTO_BAN_THRESHOLD, administratorReleased: false } };
}

/** 공통 consumer가 같은 TX에 저장한 실제 결과와 현재 관측을 잠근 뒤에만 최종 내림한다. */
export async function applyUptimeAssist(tx: ProductTransaction, claim: AssistWorkClaim, input: AssistInput,
  outcome: AssistOutcome, resultId: string): Promise<boolean> {
  if (input.task !== "uptime" || outcome.task !== "uptime" || !validateAssistOutcome(input, outcome).ok
    || outcome.action.proposal !== "delist_candidate" || outcome.evidence_quality.status !== "sufficient") return false;
  const work = await lockAssistClaim(tx, claim);
  if (!work || work.inputHash !== assistInputHash(input) || !await assistOriginActive(tx, work.originJob)) return false;
  const control = await readAssistControl("uptime", tx);
  if (control.mode !== "confirm" || !control.confirmationRequired || !control.dispatchEnabled || !control.applyEnabled
    || control.revision !== work.controlRevision) return false;
  const candidate = uptimeCandidateSchema.parse(work.source);
  if (input.subject.id !== candidate.product.id || input.subject.revision !== candidate.product.updatedAt
    || input.context.requestedUrl !== candidate.product.url || input.context.failureCount !== candidate.health.failures) return false;
  if (!input.sources.some(source => source.completeness === "complete" && source.text.trim()
    && Date.parse(source.observedAt) <= Date.now() && Date.parse(source.observedAt) >= Date.now() - 180_000)) return false;
  const [result] = await tx.select().from(llmAssistResults).where(and(eq(llmAssistResults.id, resultId),
    eq(llmAssistResults.workId, work.id), eq(llmAssistResults.workRevision, work.revision),
    eq(llmAssistResults.capacityRequestId, work.capacityRequestId!))).for("update");
  if (!result || result.applied || assistHash(result.outcome) !== assistHash(outcome) || result.inputHash !== work.inputHash) return false;
  await tx.select().from(uptimeControl).where(eq(uptimeControl.id, 1)).for("share");
  if (!await lockProductGeneration(tx, candidate.product.id, candidate.product.slug)) return false;
  const [current] = await tx.select({ status: products.status }).from(products)
    .innerJoin(productHealth, eq(productHealth.slug, products.slug)).where(and(eq(products.id, candidate.product.id),
      eq(products.url, candidate.product.url), sql`${products.updatedAt}::text=${candidate.product.updatedAt}`,
      sql`${productHealth.checkedAt}::text=${candidate.health.checkedAt}`, sql`${productHealth.downSince}::text=${candidate.health.downSince}`,
      eq(productHealth.failures, candidate.health.failures), eq(productHealth.status, candidate.health.status), eligibleUptimeAutoBanObservation())).for("update");
  if (!current) return false;
  const detail = { policy: "uptime_llm_confirmed", threshold: UPTIME_AUTO_BAN_THRESHOLD, productId: candidate.product.id,
    slug: candidate.product.slug, url: candidate.product.url, previousStatus: current.status, status: "banned", workId: work.id,
    resultId, failures: candidate.health.failures, lastStatus: candidate.health.status, checkedAt: candidate.health.checkedAt,
    pageState: outcome.state.page_state, evidence: outcome.evidence, backendId: result.backendId, modelFamily: result.modelFamily };
  if (!await setStatusWithAudit({ id: candidate.product.id, slug: candidate.product.slug, status: "banned", actor: "system:uptime-assist",
    action: "admin.product.ban", reason: "uptime_llm_confirmed", metadata: detail }, tx)) return false;
  await tx.insert(operationsAudit).values({ actor: "system:uptime-assist", actorKind: "token", action: "product-auto-ban-uptime",
    target: candidate.product.slug, detail });
  return true;
}
