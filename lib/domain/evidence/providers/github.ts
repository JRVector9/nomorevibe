import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import {
  githubRequest,
  type ConditionalRequest,
  type GitHubHttpResult,
} from "@/lib/crawl/github";
import { normalizeUrl } from "@/lib/net/normalize";
import {
  findObservedSource,
  findProductEvidenceIdentity,
  isMakerLinkDeclared,
  siteObservedRepository,
  upsertObservedSource,
} from "../repository";
import { relationshipState } from "../relationship";
import { insertUpdateCandidates } from "../updates";

export const CONTRIBUTOR_COUNT_CAP = 500;
const README_BYTES_CAP = 256 * 1024;
const GITHUB_REFRESH_MS = 24 * 60 * 60 * 1000;
// Asset metadata is included in release payloads; 100 entries can exceed the 2 MiB HTTP cap.
const RELEASE_PAGE_SIZE = 10;
const RELEASE_LIMIT = 10;
const RELEASE_PAGE_LIMIT = 10;

type RepositoryPayload = {
  html_url: string;
  full_name: string;
  created_at: string;
  pushed_at: string | null;
  updated_at: string;
  stargazers_count: number;
  forks_count: number;
  private: boolean;
  archived: boolean;
  fork: boolean;
  homepage: string | null;
  license: { name: string; spdx_id: string | null; url: string | null } | null;
};

type ReleasePayload = {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
};

type ContributorPayload = { login?: string | null };
type ReadmePayload = { html_url?: string; content?: string; encoding?: string };

export type GitHubRepositoryFacts = {
  type: "github_repository";
  repositoryKey: string;
  repositoryUrl: string;
  createdAt: string;
  pushedAt: string | null;
  updatedAt: string;
  stars: number;
  forks: number;
  public: boolean;
  archived: boolean;
  fork: boolean;
  homepage: string | null;
  contributors: { count: number; incomplete: boolean; cap: number };
  license: { value: string; spdxId: string | null; url: string | null } | null;
  languages: Array<{ name: string; bytes: number; percent: number }>;
  latestRelease: NormalizedRelease | null;
  relationshipState?: ReturnType<typeof relationshipState>;
};

type NormalizedRelease = {
  id: number;
  tagName: string;
  name: string;
  url: string;
  notesUrl: string;
  publishedAt: string;
};

function iso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeReleases(releases: ReleasePayload[]): NormalizedRelease[] {
  return releases
    .flatMap((release) => {
      const publishedAt = release.draft ? null : iso(release.published_at);
      if (!publishedAt) return [];
      return [{
        id: release.id,
        tagName: release.tag_name.slice(0, 160),
        name: (release.name || release.tag_name).slice(0, 500),
        url: release.html_url.slice(0, 1_000),
        notesUrl: release.html_url.slice(0, 1_000),
        publishedAt,
      }];
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function lastPage(link: string | null): number | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="last"/.test(part)) continue;
    const match = part.match(/[?&]page=(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function nextPage(link: string | null): number | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const match = part.match(/[?&]page=(\d+)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function contributorSummary(input: { items: ContributorPayload[]; link: string | null }) {
  const identified = lastPage(input.link) ?? input.items.filter((item) => item.login).length;
  return {
    count: Math.min(identified, CONTRIBUTOR_COUNT_CAP),
    incomplete: identified > CONTRIBUTOR_COUNT_CAP || (Boolean(input.link) && lastPage(input.link) === null),
    cap: CONTRIBUTOR_COUNT_CAP,
  };
}

function languageSummary(languages: Record<string, number>) {
  const rows = Object.entries(languages)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = rows.reduce((sum, [, bytes]) => sum + bytes, 0);
  if (total === 0) return [];
  return rows.map(([name, bytes]) => ({
    name: name.slice(0, 120),
    bytes: Math.trunc(bytes),
    percent: Math.round((bytes / total) * 1_000) / 10,
  }));
}

export function mapGitHubRepositoryFacts(input: {
  repository: RepositoryPayload;
  languages: Record<string, number>;
  contributors: { items: ContributorPayload[]; link: string | null };
  releases: ReleasePayload[];
}): GitHubRepositoryFacts {
  const createdAt = iso(input.repository.created_at);
  const updatedAt = iso(input.repository.updated_at);
  if (!createdAt || !updatedAt) throw new Error("GitHub repository timestamps are invalid");
  const releases = normalizeReleases(input.releases);
  return {
    type: "github_repository",
    repositoryKey: input.repository.full_name.toLowerCase(),
    repositoryUrl: input.repository.html_url,
    createdAt,
    pushedAt: iso(input.repository.pushed_at),
    updatedAt,
    stars: Math.max(0, Math.trunc(input.repository.stargazers_count)),
    forks: Math.max(0, Math.trunc(input.repository.forks_count)),
    public: !input.repository.private,
    archived: input.repository.archived,
    fork: input.repository.fork,
    homepage: input.repository.homepage,
    contributors: contributorSummary(input.contributors),
    license: input.repository.license
      ? {
          value: input.repository.license.name.slice(0, 120),
          spdxId: input.repository.license.spdx_id?.slice(0, 80) ?? null,
          url: input.repository.license.url?.slice(0, 1_000) ?? null,
        }
      : null,
    languages: languageSummary(input.languages),
    latestRelease: releases[0] ?? null,
  };
}

type EvidenceRequest = (
  path: string,
  conditional?: ConditionalRequest,
) => Promise<GitHubHttpResult<unknown>>;

type ReleaseFetchResult = GitHubHttpResult<ReleasePayload[]>
  | { ok: false; error: { kind: "budget_exhausted" } };

function isBudgetExhausted(
  result: ReleaseFetchResult,
): result is { ok: false; error: { kind: "budget_exhausted" } } {
  return !result.ok && result.error.kind === "budget_exhausted";
}

export async function fetchPublishedReleases(
  request: EvidenceRequest,
  repositoryKey: string,
  hasBudget: () => boolean,
): Promise<ReleaseFetchResult> {
  const published: ReleasePayload[] = [];
  let page = 1;
  let perPage = RELEASE_PAGE_SIZE;
  let responseHeaders = { etag: null, lastModified: null, link: null } as {
    etag: string | null;
    lastModified: string | null;
    link: string | null;
  };
  for (let pagesRead = 0; pagesRead < RELEASE_PAGE_LIMIT; pagesRead++) {
    if (!hasBudget()) return { ok: false, error: { kind: "budget_exhausted" } };
    let result = await request(
      `/repos/${repositoryKey}/releases?per_page=${perPage}&page=${page}`,
    );
    if (!result.ok && result.error.kind === "invalid_response" && perPage > 1) {
      // Retry a capped page with one item; retain its absolute offset after changing page size.
      page = (page - 1) * perPage + 1;
      perPage = 1;
      if (!hasBudget()) return { ok: false, error: { kind: "budget_exhausted" } };
      result = await request(`/repos/${repositoryKey}/releases?per_page=${perPage}&page=${page}`);
    }
    if (!result.ok || result.status === 304) return result;
    responseHeaders = {
      etag: result.etag,
      lastModified: result.lastModified,
      link: result.link,
    };
    if (!Array.isArray(result.value) || result.value.some(release =>
      !release || typeof release !== "object" || !Number.isSafeInteger(release.id)
      || typeof release.tag_name !== "string" || typeof release.html_url !== "string"
      || (release.name !== null && typeof release.name !== "string") || typeof release.draft !== "boolean"
      || (release.published_at !== null && typeof release.published_at !== "string")
    )) return { ok: false, error: { kind: "invalid_response" } };
    const payload = result.value as ReleasePayload[];
    published.push(...payload.filter((release) => !release.draft && iso(release.published_at)));
    if (published.length >= RELEASE_LIMIT) break;
    const followingPage = nextPage(result.link);
    if (!followingPage || followingPage <= page) break;
    page = followingPage;
  }
  published.sort((a, b) => (iso(b.published_at) ?? "").localeCompare(iso(a.published_at) ?? ""));
  return {
    ok: true,
    status: 200,
    value: published.slice(0, RELEASE_LIMIT),
    ...responseHeaders,
  };
}

type RefreshDependencies = {
  request?: EvidenceRequest;
  now?: () => Date;
  hasBudget?: () => boolean;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

type EvidenceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type EvidenceExecutor = typeof db | EvidenceTransaction;

function isSuccessfulGitHubResponse<T>(
  result: GitHubHttpResult<T>,
): result is Extract<GitHubHttpResult<T>, { ok: true; status: 200 }> {
  return result.ok && result.status === 200;
}

function connected(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const state = (value as { relationshipState?: unknown }).relationshipState;
  return state === "bidirectional" || state === "site_link" || state === "repository_link";
}

function previousGitHubRepositoryFacts(value: unknown): GitHubRepositoryFacts | null {
  if (!value || typeof value !== "object") return null;
  return (value as { type?: unknown }).type === "github_repository"
    ? value as GitHubRepositoryFacts
    : null;
}

/**
 * 이번 관측의 저장소 facts.
 *
 * 레포 본문에만 조건부 요청(etag)을 건다. 304면 본문이 오지 않으므로 지난 facts를 바탕에
 * 두고, 조건부 요청을 걸지 않아 매번 새로 받는 것(언어·기여자·릴리스)만 덮어쓴다.
 * 지난 facts도 없이 304가 오는 것은 우리가 보낸 etag의 출처가 사라졌다는 뜻이라 진행할 수 없다.
 */
function repositoryFacts(input: {
  repository: RepositoryPayload | null;
  previousFacts: GitHubRepositoryFacts | null;
  languages: Record<string, number>;
  contributors: { items: ContributorPayload[]; link: string | null };
  releases: ReleasePayload[];
}): GitHubRepositoryFacts {
  if (input.repository) {
    return mapGitHubRepositoryFacts({
      repository: input.repository,
      languages: input.languages,
      contributors: input.contributors,
      releases: input.releases,
    });
  }
  if (!input.previousFacts) {
    throw new Error("GitHub returned 304 without previous repository facts");
  }
  return {
    ...input.previousFacts,
    contributors: contributorSummary(input.contributors),
    languages: languageSummary(input.languages),
    latestRelease: normalizeReleases(input.releases)[0] ?? null,
  };
}

function canonicalHost(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  return new URL(normalized).hostname;
}

function decodeReadme(payload: ReadmePayload): string {
  if (payload.encoding !== "base64" || !payload.content) return "";
  const bytes = Buffer.from(payload.content.replace(/\s/g, ""), "base64");
  return bytes.subarray(0, README_BYTES_CAP).toString("utf8");
}

function repositoryLinksCanonicalSite(
  repositoryHomepage: string | null,
  readme: ReadmePayload,
  canonicalProductUrl: string,
): boolean {
  const expected = canonicalHost(canonicalProductUrl);
  if (!expected) return false;
  if (canonicalHost(repositoryHomepage) === expected) return true;
  const text = decodeReadme(readme);
  const urls = text.match(/https?:\/\/[^\s)\]}>"']+/gi) ?? [];
  return urls.some((url) => canonicalHost(url) === expected);
}

function failureCode(result: Extract<GitHubHttpResult<unknown>, { ok: false }>): string {
  if (result.error.kind === "http") return `http_${result.error.status}`;
  return result.error.kind;
}

/** 로그에 남길 실패 구분 — HTTP 오류는 상태 코드로, 그 밖은 종류 이름으로 */
function httpClass(result: Extract<GitHubHttpResult<unknown>, { ok: false }>): string {
  if (result.error.kind === "http") return String(result.error.status);
  return result.error.kind;
}

/** rate limit이 알려준 재시도 시각. 그 밖의 실패는 자체 백오프를 쓰므로 null이다 */
function rateLimitRetryAt(
  result: Extract<GitHubHttpResult<unknown>, { ok: false }>,
): Date | null {
  return result.error.kind === "rate_limited" ? result.error.resetAt ?? null : null;
}

async function persistReleases(
  executor: EvidenceExecutor,
  slug: string,
  releases: ReleasePayload[],
  observedAt: Date,
  productId: number,
): Promise<number> {
  const normalized = normalizeReleases(releases);
  if (normalized.length === 0) return 0;
  return insertUpdateCandidates(slug, normalized.map((release) => ({
    sourceKind: "github_release" as const,
    dedupeKey: `github-release:${release.id}`,
    canonicalUrl: release.url,
    title: release.name,
    summary: null,
    beforeAfter: null,
    publishedAt: new Date(release.publishedAt),
    observedAt,
  })), executor, productId);
}

type GitHubFailureContext = {
  slug: string;
  repositoryKey: string;
  productId: number;
  now: Date;
  attempts: number;
  log: (outcome: string, httpClass: string, count: number) => void;
};

type GitHubFailure = {
  state: "failed" | "disconnected";
  /** rate limit이 알려준 시각. 없으면 자체 백오프를 쓴다 */
  retryAt: Date | null;
  errorCode: string;
  httpClass: string;
};

/**
 * 실패한 관측을 기록하고 호출부가 그대로 돌려줄 결과를 만든다.
 *
 * 실패 분기 셋(레포 조회 실패·비공개 레포·보조 조회 실패)이 같은 행을 남긴다. 다른 것은
 * 상태와 재시도 시각, 오류 코드뿐이라 판정은 호출부에, 기록은 여기에 둔다.
 */
async function recordGitHubFailure(
  context: GitHubFailureContext,
  failure: GitHubFailure,
): Promise<{ status: "disconnected" | "deferred"; releases: number; retryAt?: Date | null }> {
  await upsertObservedSource({
    slug: context.slug,
    kind: "repository",
    provider: "github",
    sourceKey: context.repositoryKey,
    state: failure.state,
    lastFailureAt: context.now,
    nextAttemptAt: failure.retryAt ?? new Date(context.now.getTime() + GITHUB_REFRESH_MS),
    attempts: context.attempts,
    lastErrorCode: failure.errorCode,
  }, db, context.productId);
  if (failure.state === "disconnected") {
    context.log("disconnected", failure.httpClass, 0);
    return { status: "disconnected", releases: 0 };
  }
  context.log("deferred", failure.httpClass, 0);
  return { status: "deferred", releases: 0, retryAt: failure.retryAt };
}

export async function refreshGitHubEvidence(
  input: {
    slug: string;
    repository: string;
    productId?: number;
  },
  dependencies: RefreshDependencies = {},
): Promise<{
  status: "updated" | "not_modified" | "disconnected" | "deferred" | "budget_exhausted";
  releases: number;
  retryAt?: Date | null;
}> {
  const repositoryKey = input.repository.toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repositoryKey)) {
    throw new Error("invalid GitHub repository key");
  }
  const identity = await findProductEvidenceIdentity(input.slug);
  if (!identity || (input.productId !== undefined && input.productId !== identity.id)) {
    throw new Error("product generation changed");
  }
  const productId = input.productId ?? identity.id;
  const request: EvidenceRequest = dependencies.request ?? ((path, conditional) => githubRequest(path, conditional));
  const hasBudget = dependencies.hasBudget ?? (() => true);
  const now = (dependencies.now ?? (() => new Date()))();
  const current = await findObservedSource({
    slug: input.slug,
    kind: "repository",
    sourceKey: repositoryKey,
  });
  const root = await request(`/repos/${repositoryKey}`, {
    etag: current?.etag,
    lastModified: current?.lastModified,
  });

  const log = (outcome: string, httpClass: string, count: number) => dependencies.log?.(
    "evidence.github_refresh",
    { sourceKind: "repository", slug: input.slug, outcome, httpClass, count },
  );
  const failureContext: GitHubFailureContext = {
    slug: input.slug,
    repositoryKey,
    productId,
    now,
    attempts: (current?.attempts ?? 0) + 1,
    log,
  };


  if (!root.ok) {
    // 레포가 없어진 것은 재시도할 일이 아니라 연결이 끊긴 것이다
    return recordGitHubFailure(failureContext, {
      state: root.error.kind === "not_found" ? "disconnected" : "failed",
      retryAt: rateLimitRetryAt(root),
      errorCode: failureCode(root),
      httpClass: httpClass(root),
    });
  }

  const repository = root.status === 200 ? root.value as RepositoryPayload : null;
  if (repository && repository.private !== false) {
    return recordGitHubFailure(failureContext, {
      state: "disconnected",
      retryAt: null,
      errorCode: "private_repository",
      httpClass: "private",
    });
  }

  const [languages, contributors, releases, readme] = await Promise.all([
    request(`/repos/${repositoryKey}/languages`),
    request(`/repos/${repositoryKey}/contributors?per_page=1&anon=false`),
    fetchPublishedReleases(request, repositoryKey, hasBudget),
    request(`/repos/${repositoryKey}/readme`),
  ]);
  if (isBudgetExhausted(releases)) {
    log("budget_exhausted", "budget", 0);
    return { status: "budget_exhausted", releases: 0 };
  }
  const readmeMissing = !readme.ok && readme.error.kind === "not_found";
  const supporting = readmeMissing
    ? [languages, contributors, releases]
    : [languages, contributors, releases, readme];
  const failed = supporting.find((result): result is Extract<GitHubHttpResult<unknown>, { ok: false }> => !result.ok);
  if (failed) {
    return recordGitHubFailure(failureContext, {
      state: "failed",
      retryAt: rateLimitRetryAt(failed),
      errorCode: failureCode(failed),
      httpClass: httpClass(failed),
    });
  }
  if (
    !isSuccessfulGitHubResponse(languages)
    || !isSuccessfulGitHubResponse(contributors)
    || !isSuccessfulGitHubResponse(releases)
    || (!readmeMissing && !isSuccessfulGitHubResponse(readme))
  ) {
    throw new Error("unexpected 304 for unconditional GitHub evidence request");
  }
  const readmePayload = isSuccessfulGitHubResponse(readme)
    ? readme.value as ReadmePayload
    : {};

  const releasePayloads = releases.value as ReleasePayload[];
  const previousFacts = previousGitHubRepositoryFacts(current?.normalizedFacts);
  const facts = repositoryFacts({
    repository,
    previousFacts,
    languages: languages.value as Record<string, number>,
    contributors: {
      items: contributors.value as ContributorPayload[],
      link: contributors.link,
    },
    releases: releasePayloads,
  });
  const [makerDeclared, siteLinksRepository] = await Promise.all([
    isMakerLinkDeclared({
      slug: input.slug,
      kind: "repository",
      normalizedKey: repositoryKey,
    }),
    siteObservedRepository({ slug: input.slug, repositoryKey }),
  ]);
  facts.relationshipState = relationshipState({
    makerDeclared,
    siteLinksRepository,
    repositoryLinksCanonicalSite: repositoryLinksCanonicalSite(
      repository?.homepage ?? previousFacts?.homepage ?? null,
      readmePayload,
      identity.url,
    ),
    previouslyConnected: connected(current?.normalizedFacts),
  });

  const factsChanged = !isDeepStrictEqual(current?.normalizedFacts ?? null, facts);
  const releaseCount = await db.transaction(async (tx) => {
    await upsertObservedSource({
      slug: input.slug,
      kind: "repository",
      provider: "github",
      sourceKey: repositoryKey,
      sourceUrl: `https://github.com/${repositoryKey}`,
      state: "ok",
      normalizedFacts: facts,
      etag: root.etag ?? current?.etag ?? null,
      lastModified: root.lastModified ?? current?.lastModified ?? null,
      observedAt: now,
      lastSuccessAt: now,
      nextAttemptAt: new Date(now.getTime() + GITHUB_REFRESH_MS),
      attempts: 0,
      lastErrorCode: null,
    }, tx, productId);
    return persistReleases(tx, input.slug, releasePayloads, now, productId);
  });
  const status = root.status === 304 && !factsChanged && releaseCount === 0
    ? "not_modified"
    : "updated";
  log(status, String(root.status), releaseCount);
  return { status, releases: releaseCount };
}
