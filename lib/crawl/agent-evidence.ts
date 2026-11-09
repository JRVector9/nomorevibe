import type { CrawlDocument } from "@/lib/db/schema";
import type { CrawlSettings } from "./settings-schema";
import type { SummaryInput } from "@/lib/domain/evidence/agents/summary";
import { getLatestRepositoryAgentEvidence, getLatestRepositoryAgentScan } from "@/lib/domain/evidence/agents/repository";
import { effectiveAgentScanState } from "@/lib/domain/evidence/agents/coverage";
import type { ReviewEvidenceAge } from "./agent-review-contract";

/** A repository homepage is a one-sided claim; require a source link from the product. */
export async function loadAgentJudgeInput(
  document: Pick<CrawlDocument, "repo" | "pageMeta" | "fetchedAt">,
  settings: CrawlSettings,
  /** any_age — 사람 몫 위임 검수의 승인만(createReviewInput 의 ReviewEvidenceAge 와 같은 뜻). 24시간 창 대신 미래 시각만 거른다 */
  evidenceAge: ReviewEvidenceAge = "window",
): Promise<SummaryInput & { scanId: number | null }> {
  const now = Date.now();
  const fresh = (age: number) => age >= 0 && (evidenceAge === "any_age" || age < 24 * 3600_000);
  const siteAge = now - document.fetchedAt.getTime();
  const rawKeys = fresh(siteAge) ? document.pageMeta?.repositoryKeys : undefined;
  const keys = Array.isArray(rawKeys) ? [...new Set(rawKeys.filter((key): key is string => typeof key === "string").map(key => key.replace(/^github:/, "").toLowerCase()))] : [];
  const relationship = keys.length === 1
    ? keys[0] === document.repo.toLowerCase() ? "same_product" : "conflict"
    : "unknown";
  const [latest, evidence] = await Promise.all([
    getLatestRepositoryAgentScan(document.repo), getLatestRepositoryAgentEvidence(document.repo),
  ]);
  const scanFresh = latest?.detectorVersion === settings.agentEvidence.detectorVersion
    && latest.lastErrorCode == null && latest.completedAt && fresh(now - latest.completedAt.getTime());
  return {
    relationship,
    scanState: latest?.state === "complete" && !scanFresh ? "pending" : latest ? effectiveAgentScanState(latest) : "pending",
    observations: evidence && latest && evidence.scan.id === latest.id
      ? evidence.observations.filter(observation => observation.scope === "") : [],
    scanId: latest?.id ?? null,
  };
}
