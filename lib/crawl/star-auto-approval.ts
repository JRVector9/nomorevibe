import type { CrawlSettings } from "./settings-schema";

export function starAutoApproval(
  document: { repo: string; repoMeta: Record<string, unknown>; fetchedAt?: Date },
  settings: CrawlSettings,
  now = new Date(),
): { stars: number; githubId: number } | null {
  const meta = document.repoMeta;
  const stars = meta.stargazers_count;
  const id = meta.id;
  const age = document.fetchedAt instanceof Date ? now.getTime() - document.fetchedAt.getTime() : Number.NaN;
  if (!Number.isSafeInteger(stars) || (stars as number) < settings.judge.autoApproveMinStars
    || !Number.isSafeInteger(id) || (id as number) <= 0
    || typeof meta.full_name !== "string" || meta.full_name.toLowerCase() !== document.repo.toLowerCase()
    || meta.private !== false || meta.fork !== false || meta.archived !== false
    || !Number.isFinite(age) || age < 0 || age >= 24 * 3600_000) return null;
  return { stars: stars as number, githubId: id as number };
}

/** Candidate evidence is only a claim until checked against the current stored GitHub response. */
export function candidateStarAutoApproval(
  candidate: { decidedBy: string | null; signals: Record<string, unknown> | null },
  document: { repo: string; repoMeta: Record<string, unknown>; fetchedAt?: Date },
  settings: CrawlSettings,
  now = new Date(),
): { stars: number; githubId: number } | null {
  if (candidate.decidedBy !== "auto") return null;
  const proof = starAutoApproval(document, settings, now);
  const marker = candidate.signals?.starAutoApproval;
  return proof && marker && typeof marker === "object"
    && (marker as { stars?: unknown }).stars === proof.stars
    && (marker as { githubId?: unknown }).githubId === proof.githubId ? proof : null;
}
