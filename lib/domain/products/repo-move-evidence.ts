import { fetchCapped, type CappedFetchResult } from "@/lib/net/fetch";
import { extractTextSample } from "@/lib/net/normalize";
import { readmeText } from "@/lib/crawl/readme";
import { assistHash, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { buildRepoMoveInput, repoMoveCandidateSchema, repoMoveSource, type RepoMoveCandidate, type RepoMoveInput } from "./repo-move-review";
import { classifyRepoResponse, repositoryKey, type RepoCheck } from "./repo-review";
import type { FreshRepoMoveChecks } from "./repo-move-reviews";

type Fetch = typeof fetchCapped;
type EvidenceOptions = { signal?: AbortSignal; fetch?: Fetch };
const MAX_BYTES = 256 * 1024;

async function repositoryObservation(key: string, options: EvidenceOptions): Promise<{ check: RepoCheck; response: CappedFetchResult }> {
  const response = await (options.fetch ?? fetchCapped)(`https://github.com/${key}`, {
    maxBytes: MAX_BYTES, allowTruncatedBody: true, timeoutMs: 8_000, signal: options.signal,
  });
  const check = response.ok ? classifyRepoResponse(key, response.status, response.finalUrl)
    : response.reason === "http" ? classifyRepoResponse(key, response.status, `https://github.com/${key}`) : { state: "unknown" as const };
  return { check, response };
}

async function readmeSource(key: string, sourceId: string, options: EvidenceOptions): Promise<AssistSource> {
  const observedAt = new Date().toISOString();
  // Common public filenames only, without credentials or a token fallback. All response distinctions stay explicit.
  for (const name of ["README.md", "readme.md", "README", "README.rst"]) {
    const url = `https://raw.githubusercontent.com/${key}/HEAD/${name}`;
    const response = await (options.fetch ?? fetchCapped)(url, { maxBytes: MAX_BYTES, timeoutMs: 8_000,
      allowTruncatedBody: true, signal: options.signal });
    if (response.ok) {
      const raw = response.body.toString("utf8");
      const text = readmeText(raw, 100_000);
      return repoMoveSource(sourceId, "readme", url, text, observedAt,
        response.truncated || raw.length > 100_000 ? "truncated" : text ? "complete" : "missing", response.status);
    }
    if (response.reason === "http" && response.status === 404) continue;
    const status = response.reason === "http" ? response.status : null;
    return repoMoveSource(sourceId, "readme", url, "", observedAt,
      status !== null && [401, 403, 429, 999].includes(status) ? "blocked" : "missing", status);
  }
  return repoMoveSource(sourceId, "readme", `https://github.com/${key}`, "", observedAt, "missing", 404);
}

/** No DB connection or model slot is held during evidence collection. */
export async function collectRepoMoveInput(value: RepoMoveCandidate, options: EvidenceOptions = {}): Promise<
  { kind: "ready"; input: RepoMoveInput } | { kind: "obsolete" | "waiting_evidence"; reason: string }> {
  const candidate = repoMoveCandidateSchema.parse(value);
  const budget = AbortSignal.timeout(25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  const bounded = { ...options, signal };
  const oldKey = repositoryKey(candidate.snapshot.repoUrl)!;
  const keys = candidate.candidates.map(item => repositoryKey(item.url)!);
  const results = await Promise.allSettled([repositoryObservation(oldKey, bounded), ...keys.map(key => repositoryObservation(key, bounded)),
    readmeSource(oldKey, "old_readme", bounded), ...keys.map((key, index) => readmeSource(key, `candidate_readme_${index}`, bounded))]);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  if (signal.aborted) return { kind: "waiting_evidence", reason: "repository_evidence_timeout" };
  const values = results.map(result => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof repositoryObservation>> | AssistSource>).value);
  const observations = values.slice(0, keys.length + 1) as Awaited<ReturnType<typeof repositoryObservation>>[];
  if (observations.some(item => item.check.state === "unknown")) return { kind: "waiting_evidence", reason: "repository_observation_unknown" };
  if (assistHash(observations[0].check) !== assistHash(candidate.oldRepository)
    || observations.slice(1).some(item => item.check.state !== "alive")) return { kind: "obsolete", reason: "repository_observation_changed" };
  const sources = values.slice(keys.length + 1) as AssistSource[];
  for (const [index, item] of observations.slice(1).entries()) {
    const response = item.response;
    if (!response.ok) continue;
    const text = extractTextSample(response.body.toString("utf8")) ?? "";
    sources.push(repoMoveSource(`candidate_repository_${index}`, "repository", candidate.candidates[index].url, text,
      new Date().toISOString(), response.truncated ? "truncated" : text ? "complete" : "missing", response.status));
  }
  if (!sources.some(source => source.sourceId.startsWith("candidate_") && source.completeness === "complete" && source.text.trim())) {
    return { kind: "waiting_evidence", reason: "candidate_repository_content_unavailable" };
  }
  return { kind: "ready", input: buildRepoMoveInput(candidate, sources) };
}

/** Reconnect immediately before the short apply transaction; unknown never becomes an absence. */
export async function checkRepoMoveBeforeApply(candidate: RepoMoveCandidate, options: EvidenceOptions = {}): Promise<FreshRepoMoveChecks> {
  const results = await Promise.allSettled([repositoryObservation(repositoryKey(candidate.snapshot.repoUrl)!, options),
    repositoryObservation(repositoryKey(candidate.candidates[0].url)!, options)]);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const [oldRepository, destination] = results.map(result => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof repositoryObservation>>>).value.check);
  return { oldRepository, destination, checkedAt: new Date().toISOString() };
}
