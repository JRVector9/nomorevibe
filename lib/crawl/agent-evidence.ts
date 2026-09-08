import type { CrawlDocument } from "@/lib/db/schema";
import type { CrawlSettings } from "./settings-schema";
import type { SummaryInput } from "@/lib/domain/evidence/agents/summary";
import { getLatestRepositoryAgentEvidence, getLatestRepositoryAgentScan } from "@/lib/domain/evidence/agents/repository";

/** A repository homepage is a one-sided claim; require a source link from the product. */
export async function loadAgentJudgeInput(
  document: Pick<CrawlDocument, "repo" | "pageMeta" | "fetchedAt">,
  settings: CrawlSettings,
): Promise<SummaryInput & { scanId: number | null }> {
  const now = Date.now();
  const siteAge = now - document.fetchedAt.getTime();
  const rawKeys = siteAge >= 0 && siteAge < 24 * 3600_000 ? document.pageMeta?.repositoryKeys : undefined;
  const keys = Array.isArray(rawKeys) ? [...new Set(rawKeys.filter((key): key is string => typeof key === "string").map(key => key.replace(/^github:/, "").toLowerCase()))] : [];
  const relationship = keys.length === 1
    ? keys[0] === document.repo.toLowerCase() ? "same_product" : "conflict"
    : "unknown";
  const [latest, evidence] = await Promise.all([
    getLatestRepositoryAgentScan(document.repo), getLatestRepositoryAgentEvidence(document.repo),
  ]);
  const fresh = latest?.detectorVersion === settings.agentEvidence.detectorVersion
    && latest.lastErrorCode == null && latest.completedAt
    && now - latest.completedAt.getTime() >= 0 && now - latest.completedAt.getTime() < 24 * 3600_000;
  return {
    relationship,
    scanState: latest?.state === "complete" && !fresh ? "pending" : latest?.state ?? "pending",
    observations: evidence && latest && evidence.scan.id === latest.id
      ? evidence.observations.filter(observation => observation.scope === "") : [],
    scanId: latest?.id ?? null,
  };
}
