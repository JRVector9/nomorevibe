import { fetchReadmeSample, readmeText } from "./readme";
import { githubRequest, type GitHubFailure } from "./github";
import { fetchCapped } from "@/lib/net/fetch";

export type ReadmeRefreshResult = { ok: true; sample: string }
  | { ok: false; error: string; retryAfter: number | null };
const failed = (error = "temporary", retryAfter: number | null = null): ReadmeRefreshResult => ({ ok: false, error, retryAfter });
function apiFailure(error: GitHubFailure): ReadmeRefreshResult {
  return error.kind === "not_found" ? { ok: true, sample: "" }
    : failed(error.kind === "http" ? `http_${error.status}` : error.kind,
      error.kind === "rate_limited" ? error.resetAt?.getTime() ?? null : null);
}

/** One eight-second budget; authenticated fallback may only read a currently public repository. */
export async function fetchPublicReadme(repo: string, signal?: AbortSignal): Promise<ReadmeRefreshResult> {
  const deadline = Date.now() + 8_000;
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const expired = () => combined.aborted || Date.now() >= deadline;
  const sample = await fetchReadmeSample(repo, (url, options) => fetchCapped(url, {
    ...options, timeoutMs: remaining(), signal: combined, allowTruncatedBody: true,
  }));
  if (expired() || sample === null) return failed();
  if (sample) return { ok: true, sample };
  // GitHub supports README locations and casing beyond the common raw filenames.
  if (!process.env.GITHUB_TOKEN?.trim()) return failed("no_token");
  const repository = await githubRequest<{ private?: boolean }>(`/repos/${repo}`, {}, { timeoutMs: remaining() });
  if (!repository.ok) return apiFailure(repository.error);
  if (repository.status !== 200 || repository.value.private !== false) return failed("not_public");
  if (expired()) return failed();
  const result = await githubRequest<{ encoding?: string; content?: string; download_url?: string }>(
    `/repos/${repo}/readme`, {}, { timeoutMs: remaining() });
  if (!result.ok) return apiFailure(result.error);
  if (expired() || result.status !== 200) return failed();
  if (result.value.encoding === "base64" && typeof result.value.content === "string") {
    const prefix = result.value.content.replace(/\s/g, "").slice(0, Math.ceil(256 * 1024 / 3) * 4);
    return { ok: true, sample: readmeText(Buffer.from(prefix, "base64").subarray(0, 256 * 1024).toString("utf8")) };
  }
  // Large Contents API responses omit inline content. Do not forward authentication to a download URL.
  let url: URL;
  try { url = new URL(result.value.download_url ?? ""); } catch { return failed(); }
  if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com" || url.username || url.password) return failed();
  const raw = await fetchCapped(url.href, { maxBytes: 256 * 1024, timeoutMs: remaining(), signal: combined, allowTruncatedBody: true });
  return raw.ok && !expired() ? { ok: true, sample: readmeText(raw.body.toString("utf8")) } : failed();
}
