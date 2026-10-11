import "server-only";

import { createMemo, memoKey } from "@/lib/cache/memo";
import { sharedStore } from "@/lib/cache/shared";
import { githubRequest } from "@/lib/crawl/github";
import { onPrimary } from "@/lib/db";
import { githubRepositoryPath, parseGithubRepository, type GithubRepositoryName } from "@/lib/github/repositories";
import { fetchCapped } from "@/lib/net/fetch";

export const README_CONTENT_MAX_BYTES = 256 * 1024;
const README_TIMEOUT_MS = 8_000;

export type ReadmeContent = {
  state: "available";
  markdown: string;
  sourceUrl: string;
  repositoryRootUrl: string;
};
type ReadmeFailure = { state: "unavailable" | "too_large"; sourceUrl: string };
export type ReadmeContentResult = ReadmeContent | ReadmeFailure;

class ReadmeLoadError extends Error {
  constructor(readonly result: ReadmeFailure) { super(result.state); }
}

// Large documents have their own small cache. Failed attempts only live for 30 seconds.
const contents = createMemo<ReadmeContent>({ ttlMs: 5 * 60_000, max: 64,
  shared: { store: sharedStore, namespace: "readme-content" } });
const attempts = createMemo<ReadmeContentResult>({ ttlMs: 30_000, max: 128,
  shared: { store: sharedStore, namespace: "readme-attempt" } });

function originalUrl(value: unknown, repository: GithubRepositoryName): string {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      if (url.origin === "https://github.com" && !url.username && !url.password) return url.href;
    } catch { /* Fall back to the repository's README tab. */ }
  }
  return `${repository.htmlUrl}#readme`;
}

async function readContent(repository: GithubRepositoryName, deadline: number, signal: AbortSignal): Promise<ReadmeContent> {
  let sourceUrl = originalUrl(null, repository);
  const fail = (state: ReadmeFailure["state"] = "unavailable"): never => {
    throw new ReadmeLoadError({ state, sourceUrl });
  };
  const remaining = () => {
    if (signal.aborted || Date.now() >= deadline) return fail();
    return Math.max(1, deadline - Date.now());
  };
  const path = githubRepositoryPath(repository);
  const metadata = await githubRequest<{ private?: unknown; html_url?: unknown; default_branch?: unknown }>(path, {}, { timeoutMs: remaining() });
  if (!metadata.ok || metadata.status !== 200 || metadata.value?.private !== false) return fail();
  const currentRepository = typeof metadata.value.html_url === "string" ? parseGithubRepository(metadata.value.html_url) : null;
  if (!currentRepository || typeof metadata.value.default_branch !== "string" || !metadata.value.default_branch) return fail();
  // The branch is one encoded URL segment, including refs such as "feature/docs".
  const repositoryRootUrl = `${currentRepository.htmlUrl}/blob/${encodeURIComponent(metadata.value.default_branch)}/`;

  const readme = await githubRequest<{ download_url?: unknown; html_url?: unknown; size?: unknown }>(
    `${githubRepositoryPath(currentRepository)}/readme`, {}, { timeoutMs: remaining() });
  if (!readme.ok || readme.status !== 200) return fail();
  sourceUrl = originalUrl(readme.value?.html_url, repository);
  if (typeof readme.value?.size === "number" && readme.value.size > README_CONTENT_MAX_BYTES) return fail("too_large");
  if (typeof readme.value?.download_url !== "string") return fail();
  let download: URL;
  try { download = new URL(readme.value.download_url); } catch { return fail(); }
  // Read the body anonymously: an authenticated API payload must never expose a private README.
  if (download.origin !== "https://raw.githubusercontent.com" || download.username || download.password
    || download.search || download.hash) return fail();
  const raw = await fetchCapped(download.href, { maxBytes: README_CONTENT_MAX_BYTES, timeoutMs: remaining(), signal });
  remaining();
  if (!raw.ok) return fail(raw.reason === "too_large" ? "too_large" : "unavailable");
  if (raw.status !== 200) return fail();
  return { state: "available", markdown: raw.body.toString("utf8").replaceAll("\0", ""), sourceUrl, repositoryRootUrl };
}

async function readWithinBudget(repository: GithubRepositoryName): Promise<ReadmeContent> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("readme_timeout")); }, README_TIMEOUT_MS);
  });
  try {
    return await Promise.race([readContent(repository, Date.now() + README_TIMEOUT_MS, controller.signal), timeout]);
  } finally { clearTimeout(timer); }
}

/** Fetch only a requested public repository; search/crawler excerpts keep their existing limits. */
export async function getReadmeContent(repoUrl: string): Promise<ReadmeContentResult | null> {
  const repository = parseGithubRepository(repoUrl);
  if (!repository) return null;
  const key = memoKey(repository.fullName.toLowerCase());
  return attempts.get(key, async (): Promise<ReadmeContentResult> => {
    try {
      // Collector quota/cooldown writes must stay on the primary even inside a public read scope.
      return await contents.get(key, () => onPrimary(() => readWithinBudget(repository)));
    } catch (error) {
      return error instanceof ReadmeLoadError ? error.result : { state: "unavailable", sourceUrl: originalUrl(null, repository) };
    }
  });
}
