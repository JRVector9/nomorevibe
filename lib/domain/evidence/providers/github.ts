import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { productEvidenceSources, productLinks, products } from "@/lib/db/schema";
import { lockProductGeneration, type ProductTransaction, withProductGeneration } from "@/lib/domain/products/generation";
import { assertJobLease, withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
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
import { notifyNewReleases } from "@/lib/me/notifications";
import { fetchPushActivity, type PushActivity } from "./github-activity";

export const CONTRIBUTOR_COUNT_CAP = 500;
const README_BYTES_CAP = 256 * 1024;
const GITHUB_REFRESH_MS = 24 * 60 * 60 * 1000;
// Asset metadata is included in release payloads; 100 entries can exceed the 2 MiB HTTP cap.
const RELEASE_PAGE_SIZE = 10;
const RELEASE_LIMIT = 10;
const RELEASE_PAGE_LIMIT = 10;

type RepositoryPayload = {
  id?: number;
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
type ReadmePayload = { html_url?: string; content?: string; encoding?: string;
  canonicalHost?: string | null; linksCanonicalHost?: boolean };

type CachedEndpoint = { value: unknown; etag: string | null; lastModified: string | null; link: string | null };
type ReleaseProgress = { page: number; perPage: number; pagesRead: number; published: ReleasePayload[]; complete?: boolean };
type GitHubCollection = {
  version: 1;
  cache: Record<string, CachedEndpoint>;
  partial?: { startedAt: string; completed: string[]; releases: ReleaseProgress };
};

function validReleaseProgress(releases: ReleaseProgress | null | undefined): releases is ReleaseProgress {
  if (!releases || typeof releases !== "object" || Array.isArray(releases)
    || !Number.isSafeInteger(releases.page) || releases.page <= 0
    || ![1, RELEASE_PAGE_SIZE].includes(releases.perPage)
    || !Number.isSafeInteger(releases.pagesRead) || releases.pagesRead < 0 || releases.pagesRead > RELEASE_PAGE_LIMIT
    || (releases.complete !== undefined && typeof releases.complete !== "boolean")
    || (releases.complete === true && releases.pagesRead === 0)
    || (releases.pagesRead === RELEASE_PAGE_LIMIT && releases.complete !== true)
    || !validEndpointPayload("/releases?", releases.published) || releases.published.length > RELEASE_LIMIT
    || releases.published.some(release => release.draft || !iso(release.published_at))) return false;
  const offset = releases.page - (releases.complete ? 0 : 1);
  // Switching from ten-item pages to one-item pages retains the consumed item offset.
  const tenItemPages = releases.perPage === RELEASE_PAGE_SIZE ? releases.pagesRead
    : (offset - releases.pagesRead) / (RELEASE_PAGE_SIZE - 1);
  if (releases.perPage === RELEASE_PAGE_SIZE && offset !== releases.pagesRead) return false;
  if (!Number.isSafeInteger(tenItemPages) || tenItemPages < 0
    || tenItemPages > releases.pagesRead - (releases.perPage === 1 && releases.complete ? 1 : 0)) return false;
  const consumedItems = releases.pagesRead + (RELEASE_PAGE_SIZE - 1) * tenItemPages;
  return releases.published.length <= consumedItems && (releases.complete === true || releases.published.length < RELEASE_LIMIT);
}

function collection(value: unknown): GitHubCollection {
  if (!value || typeof value !== "object") return { version: 1, cache: {} };
  const saved = (value as { _githubCollection?: GitHubCollection })._githubCollection;
  if (saved?.version !== 1 || !saved.cache || typeof saved.cache !== "object" || Array.isArray(saved.cache)) return { version: 1, cache: {} };
  // Invalid resume state must not skip collection; keep independently valid last-good endpoints.
  const cache = Object.fromEntries(Object.entries(saved.cache).filter(([path, cached]) => validEndpointCache(path, cached)));
  const partial = saved.partial;
  const releases = partial?.releases;
  const validPartial = partial && !Array.isArray(partial) && typeof partial.startedAt === "string" && Boolean(iso(partial.startedAt))
    && Array.isArray(partial.completed) && partial.completed.every(path => typeof path === "string"
      && (Object.hasOwn(cache, path) || /^\/repos\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/releases\?per_page=(1|10)&page=[1-9][0-9]*$/.test(path)))
    && validReleaseProgress(releases);
  return structuredClone({ version: 1, cache, ...(validPartial ? { partial } : {}) });
}

function validEndpointPayload(path: string, value: unknown): boolean {
  if (path.includes("/releases?")) return Array.isArray(value) && value.every(release => release && typeof release === "object"
    && Number.isSafeInteger(release.id) && typeof release.tag_name === "string" && typeof release.html_url === "string"
    && (release.name === null || typeof release.name === "string") && typeof release.draft === "boolean"
    && (release.published_at === null || typeof release.published_at === "string"));
  if (path.includes("/contributors?")) return Array.isArray(value) && value.every(contributor => contributor && typeof contributor === "object"
    && (contributor.login === undefined || contributor.login === null || typeof contributor.login === "string"));
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (path.endsWith("/languages")) return Object.values(value).every(bytes => typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0);
  if (path.endsWith("/readme")) return ["html_url", "content", "encoding"].every(key => !(key in value) || typeof value[key as keyof typeof value] === "string")
    && (!("canonicalHost" in value) || value.canonicalHost === null || typeof value.canonicalHost === "string")
    && (!("linksCanonicalHost" in value) || typeof value.linksCanonicalHost === "boolean");
  const repository = value as RepositoryPayload;
  const license = repository.license;
  return (repository.id === undefined || (Number.isSafeInteger(repository.id) && repository.id > 0))
    && [repository.private, repository.archived, repository.fork].every(value => typeof value === "boolean")
    && typeof repository.html_url === "string" && typeof repository.full_name === "string"
    && typeof repository.created_at === "string" && Boolean(iso(repository.created_at))
    && typeof repository.updated_at === "string" && Boolean(iso(repository.updated_at))
    && (repository.pushed_at === null || (typeof repository.pushed_at === "string" && Boolean(iso(repository.pushed_at))))
    && [repository.stargazers_count, repository.forks_count].every(value => Number.isSafeInteger(value) && value >= 0)
    && (repository.homepage === null || typeof repository.homepage === "string")
    && (license === null || (typeof license === "object" && !Array.isArray(license) && typeof license.name === "string"
      && (license.spdx_id === null || typeof license.spdx_id === "string") && (license.url === null || typeof license.url === "string")));
}

function validEndpointCache(path: string, cached: CachedEndpoint): boolean {
  return Boolean(cached) && typeof cached === "object" && !Array.isArray(cached) && validEndpointPayload(path, cached.value)
    && [cached.etag, cached.lastModified, cached.link].every(value => value === null || typeof value === "string");
}

/** Cache only fields consumed by this collector; assets and full README bodies are unnecessary. */
function cachedPayload(path: string, value: unknown, canonicalProductUrl?: string): unknown {
  if (path.includes("/releases?")) return (value as ReleasePayload[]).map(({ id, tag_name, name, html_url, published_at, draft }) => ({
    id, tag_name: tag_name.slice(0, 160), name: name?.slice(0, 500) ?? null,
    html_url: html_url.slice(0, 1_000), published_at, draft,
  }));
  if (path.endsWith("/readme")) {
    const hosts = [...new Set((decodeReadme(value as ReadmePayload).match(/https?:\/\/[^\s)\]}>"']+/gi) ?? [])
      .flatMap(url => canonicalHost(url) ?? []))];
    const expected = canonicalHost(canonicalProductUrl ?? null);
    return { encoding: "base64", content: Buffer.from(hosts.slice(0, 64).map(host => `https://${host}`).join("\n")).toString("base64"),
      canonicalHost: expected, linksCanonicalHost: expected !== null && hosts.includes(expected) };
  }
  if (path.endsWith("/languages") || path.includes("/contributors?")) return value;
  const repository = value as RepositoryPayload;
  return { ...Object.fromEntries(["id", "html_url", "full_name", "created_at", "pushed_at", "updated_at", "stargazers_count",
    "forks_count", "private", "archived", "fork", "homepage"].flatMap(key => key in repository
    ? [[key, repository[key as keyof RepositoryPayload]]] : [])),
    license: repository.license ? { name: repository.license.name.slice(0, 120),
      spdx_id: repository.license.spdx_id?.trim().slice(0, 80) ?? null, url: repository.license.url?.slice(0, 1_000) ?? null } : null };
}

function rememberEndpoint(state: GitHubCollection, path: string, result: Extract<GitHubHttpResult<unknown>, { ok: true; status: 200 }>, canonicalProductUrl: string): boolean {
  const saved = { value: cachedPayload(path, result.value, canonicalProductUrl), etag: result.etag, lastModified: result.lastModified, link: result.link };
  // The source's normalized facts have an existing 64 KiB cap. Evict older endpoint
  // payloads within a 24 KiB cache budget; missing caches always require a fresh body.
  if (Buffer.byteLength(JSON.stringify(saved)) > 24 * 1024) return false;
  const previous = state.cache[path];
  delete state.cache[path];
  state.cache[path] = saved;
  const pinned = new Set(state.partial?.completed.filter(key => !key.includes("/releases?")));
  if (!path.includes("/releases?")) pinned.add(path);
  while (Buffer.byteLength(JSON.stringify(state.cache)) > 24 * 1024) {
    const evictable = Object.keys(state.cache).find(key => !pinned.has(key));
    // Keep active completed core payloads. A new entry that cannot fit remains uncached.
    if (!evictable) {
      if (previous) state.cache[path] = previous;
      else delete state.cache[path];
      return false;
    }
    delete state.cache[evictable];
  }
  return state.cache[path] === saved;
}

export type GitHubRepositoryFacts = {
  type: "github_repository";
  repositoryKey: string;
  repositoryId?: number;
  repositoryUrl: string;
  createdAt: string;
  pushedAt: string | null;
  pushActivity?: PushActivity | null;
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
  const licenseSpdxId = input.repository.license?.spdx_id?.trim();
  return {
    type: "github_repository",
    repositoryKey: input.repository.full_name.toLowerCase(),
    ...(typeof input.repository.id === "number" && Number.isSafeInteger(input.repository.id) && input.repository.id > 0
      ? { repositoryId: input.repository.id } : {}),
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
          // NOASSERTION is an unknown value, not a license identity.
          spdxId: licenseSpdxId && !/^(NOASSERTION|NONE)$/i.test(licenseSpdxId)
            ? licenseSpdxId.slice(0, 80) : null,
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
  options?: { deadlineAt?: number; signal?: AbortSignal },
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
  options: { progress?: ReleaseProgress; saveProgress?: (progress: ReleaseProgress) => Promise<void> } = {},
): Promise<ReleaseFetchResult> {
  const progress = validReleaseProgress(options.progress) ? options.progress : { page: 1, perPage: RELEASE_PAGE_SIZE, pagesRead: 0, published: [] };
  const published = [...progress.published];
  let page = progress.page;
  let perPage = progress.perPage;
  let responseHeaders = { etag: null, lastModified: null, link: null } as {
    etag: string | null;
    lastModified: string | null;
    link: string | null;
  };
  for (let pagesRead = progress.pagesRead; !progress.complete && pagesRead < RELEASE_PAGE_LIMIT; pagesRead++) {
    if (!hasBudget()) return { ok: false, error: { kind: "budget_exhausted" } };
    let result = await request(
      `/repos/${repositoryKey}/releases?per_page=${perPage}&page=${page}`,
    );
    if (!result.ok && result.error.kind === "invalid_response" && perPage > 1) {
      // Retry a capped page with one item; retain its absolute offset after changing page size.
      page = (page - 1) * perPage + 1;
      perPage = 1;
      Object.assign(progress, { page, perPage });
      await options.saveProgress?.(progress);
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
    published.sort((a, b) => (iso(b.published_at) ?? "").localeCompare(iso(a.published_at) ?? ""));
    const followingPage = nextPage(result.link);
    const nextLink = result.link?.split(",").find(part => /rel="next"/.test(part));
    const nextPageSize = nextLink?.match(/[?&]per_page=(\d+)/)?.[1];
    if (nextLink && (followingPage !== page + 1 || (nextPageSize !== undefined && Number(nextPageSize) !== perPage))) {
      return { ok: false, error: { kind: "invalid_response" } };
    }
    const complete = published.length >= RELEASE_LIMIT || !followingPage || followingPage <= page || pagesRead + 1 >= RELEASE_PAGE_LIMIT;
    Object.assign(progress, { page: complete ? page : followingPage, perPage, pagesRead: pagesRead + 1,
      published: cachedPayload("/releases?", published.slice(0, RELEASE_LIMIT)), complete });
    await options.saveProgress?.(progress);
    if (complete) break;
    page = followingPage!;
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
  lease?: JobLease;
  deadlineAt?: number;
  signal?: AbortSignal;
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
 * 각 endpoint의 마지막 정상 payload는 따로 재검증한다. 레포 본문의 304는
 * 언어·기여자·README·릴리스가 그대로라는 뜻이 아니다.
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
  if (readme.canonicalHost === expected && readme.linksCanonicalHost !== undefined) return readme.linksCanonicalHost;
  const text = decodeReadme(readme);
  const urls = text.match(/https?:\/\/[^\s)\]}>"']+/gi) ?? [];
  return urls.some((url) => canonicalHost(url) === expected);
}

/** A site-only refresh can update the relationship without re-fetching a fresh repository. */
export async function recomputeRepositoryRelationships(slug: string, productId: number, lease?: JobLease,
  options: Pick<RefreshDependencies, "hasBudget" | "deadlineAt" | "signal"> & { transaction?: ProductTransaction } = {}): Promise<void> {
  const hasBudget = () => (options.hasBudget?.() ?? true) && !options.signal?.aborted && Date.now() < (options.deadlineAt ?? Infinity);
  if (!hasBudget()) return;
  const executor = options.transaction ?? db;
  if (options.transaction && !(await lockProductGeneration(options.transaction, productId, slug))) return;
  const identity = options.transaction
    ? (await options.transaction.select({ id: products.id, url: products.url }).from(products).where(eq(products.id, productId)))[0]
    : await findProductEvidenceIdentity(slug);
  if (!hasBudget()) return;
  if (!identity || identity.id !== productId) return;
  const rows = await executor.select({ source: productEvidenceSources }).from(productEvidenceSources)
    .innerJoin(productLinks, and(eq(productLinks.slug, productEvidenceSources.slug), eq(productLinks.kind, "repository"),
      eq(productLinks.normalizedKey, productEvidenceSources.sourceKey), eq(productLinks.visible, true)))
    .where(and(eq(productEvidenceSources.slug, slug), eq(productEvidenceSources.kind, "repository")));
  if (!hasBudget()) return;
  for (const { source } of rows) {
    if (!hasBudget()) return;
    const facts = previousGitHubRepositoryFacts(source.normalizedFacts);
    if (!facts) continue;
    const [makerDeclared, siteLinksRepository] = await Promise.all([
      isMakerLinkDeclared({ slug, kind: "repository", normalizedKey: source.sourceKey }, executor),
      siteObservedRepository({ slug, repositoryKey: source.sourceKey }, executor),
    ]);
    if (!hasBudget()) return;
    const readmePath = `/repos/${source.sourceKey}/readme`;
    const cachedReadme = collection(facts).cache[readmePath];
    const readme = cachedReadme && validEndpointCache(readmePath, cachedReadme) ? cachedReadme.value as ReadmePayload : undefined;
    const repositoryLinksSite = repositoryLinksCanonicalSite(facts.homepage, readme ?? {}, identity.url);
    const unknownReadmeHost = !repositoryLinksSite && readme?.canonicalHost !== undefined && readme.canonicalHost !== canonicalHost(identity.url);
    // A bounded projection proves positive links, but cannot prove a new host absent.
    const relationship = unknownReadmeHost && !siteLinksRepository && connected(facts) ? facts.relationshipState
      : relationshipState({ makerDeclared, siteLinksRepository, repositoryLinksCanonicalSite: repositoryLinksSite, previouslyConnected: connected(facts) });
    if (facts.relationshipState === relationship) continue;
    const update = async (tx: ProductTransaction) => {
      if (!hasBudget()) return;
      const [latest] = await tx.select({ facts: productEvidenceSources.normalizedFacts }).from(productEvidenceSources).where(eq(productEvidenceSources.id, source.id));
      if (!hasBudget()) return;
      if (latest?.facts) await tx.update(productEvidenceSources).set({ normalizedFacts: { ...latest.facts, relationshipState: relationship } })
        .where(eq(productEvidenceSources.id, source.id));
      if (lease && !options.transaction) await assertJobLease(tx, lease);
    };
    if (options.transaction) await update(options.transaction);
    else await withProductGeneration(slug, productId, update);
  }
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

/** GitHub가 알려준 재시도 시각. 그 밖의 실패는 자체 백오프를 쓴다. */
function rateLimitRetryAt(
  result: Extract<GitHubHttpResult<unknown>, { ok: false }>,
): Date | null {
  return result.error.kind === "rate_limited" || result.error.kind === "auth_unavailable"
    ? result.error.resetAt ?? null : null;
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
  lease?: JobLease;
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
  await withJobLeaseWrite(context.lease, tx => upsertObservedSource({
    slug: context.slug,
    kind: "repository",
    provider: "github",
    sourceKey: context.repositoryKey,
    state: failure.state,
    lastFailureAt: context.now,
    nextAttemptAt: failure.retryAt ?? new Date(context.now.getTime() + GITHUB_REFRESH_MS),
    attempts: context.attempts,
    lastErrorCode: failure.errorCode,
  }, tx, context.productId));
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
  let signal = dependencies.signal;
  const hasBudget = () => (dependencies.hasBudget?.() ?? true) && !signal?.aborted
    && Date.now() < (dependencies.deadlineAt ?? Infinity);
  if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
  const identity = await findProductEvidenceIdentity(input.slug);
  if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
  if (!identity || (input.productId !== undefined && input.productId !== identity.id)) {
    throw new Error("product generation changed");
  }
  const productId = input.productId ?? identity.id;
  const remainingMs = (dependencies.deadlineAt ?? Infinity) - Date.now();
  const deadlineSignal = Number.isFinite(remainingMs) ? AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs))) : undefined;
  signal = dependencies.signal && deadlineSignal ? AbortSignal.any([dependencies.signal, deadlineSignal]) : dependencies.signal ?? deadlineSignal;
  const hardStopped = () => Boolean(signal?.aborted) || Date.now() >= (dependencies.deadlineAt ?? Infinity);
  const request: EvidenceRequest = (path, conditional) => {
    const stopped = { ok: false, error: { kind: "transport" } } as const;
    if (!hasBudget()) return Promise.resolve(stopped);
    // Bound the entire read, including token/DB preparation and shared-account queue wait.
    const pending = (dependencies.request ?? githubRequest)(path, conditional, { deadlineAt: dependencies.deadlineAt, signal });
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", abort);
      const abort = () => { cleanup(); resolve(stopped); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  };
  const now = (dependencies.now ?? (() => new Date()))();
  const current = await findObservedSource({
    slug: input.slug,
    kind: "repository",
    sourceKey: repositoryKey,
  });
  if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
  const state = collection(current?.normalizedFacts);
  if (!state.partial || Date.parse(state.partial.startedAt) > now.getTime() || now.getTime() - Date.parse(state.partial.startedAt) >= GITHUB_REFRESH_MS) {
    state.partial = { startedAt: now.toISOString(), completed: [], releases: {
      page: 1, perPage: RELEASE_PAGE_SIZE, pagesRead: 0, published: [],
    } };
  }
  // A retry with completed core skips optional activity so repeated hard cutoffs cannot starve freshness.
  const resumingCompletedCore = state.partial.releases.complete === true;
  const previousFacts = previousGitHubRepositoryFacts(current?.normalizedFacts);
  let checkpointFacts = previousFacts;
  const checkpoint = async () => {
    if (!checkpointFacts) return;
    await withJobLeaseWrite(dependencies.lease, tx => upsertObservedSource({
      slug: input.slug, kind: "repository", provider: "github", sourceKey: repositoryKey,
      sourceUrl: `https://github.com/${repositoryKey}`, state: current?.state ?? "unobserved",
      normalizedFacts: { ...checkpointFacts, _githubCollection: state },
      nextAttemptAt: new Date(now.getTime() + 60_000),
    }, tx, productId));
  };
  const endpoint: EvidenceRequest = async (path, conditional) => {
    const saved = state.cache[path] && validEndpointCache(path, state.cache[path]) ? state.cache[path] : undefined;
    // A host projection cannot establish absence for a new host. Fetch the full
    // body again unless the current host has a saved match fact or explicit link.
    const knownReadmeHost = !path.endsWith("/readme") || (saved?.value as ReadmePayload | undefined)?.canonicalHost === canonicalHost(identity.url)
      || repositoryLinksCanonicalSite(null, saved?.value as ReadmePayload ?? {}, identity.url);
    const cached = saved && knownReadmeHost ? saved : undefined;
    if (cached && state.partial!.completed.includes(path)) return { ok: true, status: 200, ...cached };
    let result = await request(path, cached ? { etag: cached.etag, lastModified: cached.lastModified } : conditional);
    if (result.ok && result.status === 304) {
      if (cached) {
        state.cache[path] = { ...cached, etag: result.etag ?? cached.etag, lastModified: result.lastModified ?? cached.lastModified };
        state.partial!.completed.push(path);
        return { ok: true, status: 200, ...state.cache[path] };
      }
      result = await request(path);
    }
    if (result.ok && result.status === 200) {
      if (!validEndpointPayload(path, result.value)) return { ok: false, error: { kind: "invalid_response" } };
      if (rememberEndpoint(state, path, result, identity.url)) state.partial!.completed.push(path);
    }
    if (path.endsWith("/readme") && !result.ok && result.error.kind === "not_found") {
      delete state.cache[path];
      state.partial!.completed = state.partial!.completed.filter(key => key !== path);
    }
    return result;
  };
  // 숫자 ID가 없는 과거 관측은 본문을 다시 받아 활동 페이지의 저장소를 확인한다.
  const id = current?.normalizedFacts?.repositoryId;
  const hasRepositoryId = typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  const root = await endpoint(`/repos/${repositoryKey}`, hasRepositoryId ? {
    etag: current?.etag,
    lastModified: current?.lastModified,
  } : {});

  const log = (outcome: string, httpClass: string, count: number) => dependencies.log?.(
    "evidence.github_refresh",
    { sourceKind: "repository", slug: input.slug, outcome, httpClass, count },
  );
  const failureContext: GitHubFailureContext = {
    lease: dependencies.lease,
    slug: input.slug,
    repositoryKey,
    productId,
    now,
    attempts: (current?.attempts ?? 0) + 1,
    log,
  };


  if (!root.ok) {
    if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
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
    if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
    return recordGitHubFailure(failureContext, {
      state: "disconnected",
      retryAt: null,
      errorCode: "private_repository",
      httpClass: "private",
    });
  }
  checkpointFacts = repositoryFacts({ repository, previousFacts, languages: {}, contributors: { items: [], link: null }, releases: [] });
  if (previousFacts) Object.assign(checkpointFacts, { languages: previousFacts.languages,
    contributors: previousFacts.contributors, latestRelease: previousFacts.latestRelease, pushActivity: previousFacts.pushActivity ?? null,
    ...(previousFacts.relationshipState !== undefined ? { relationshipState: previousFacts.relationshipState } : {}) });
  await checkpoint();
  const supportingResults: GitHubHttpResult<unknown>[] = [];
  for (const path of [`/repos/${repositoryKey}/languages`, `/repos/${repositoryKey}/contributors?per_page=1&anon=false`, `/repos/${repositoryKey}/readme`]) {
    if (!hasBudget()) {
      log("budget_exhausted", "budget", 0);
      return { status: "budget_exhausted", releases: 0 };
    }
    const result = await endpoint(path);
    supportingResults.push(result);
    if (isSuccessfulGitHubResponse(result)) {
      if (path.endsWith("/languages")) checkpointFacts.languages = languageSummary(result.value as Record<string, number>);
      if (path.includes("/contributors?")) checkpointFacts.contributors = contributorSummary({ items: result.value as ContributorPayload[], link: result.link });
    }
    await checkpoint();
    if (!result.ok && !(path.endsWith("/readme") && result.error.kind === "not_found")) {
      if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
      return recordGitHubFailure(failureContext, { state: "failed", retryAt: rateLimitRetryAt(result),
        errorCode: failureCode(result), httpClass: httpClass(result) });
    }
  }
  const [languages, contributors, readme] = supportingResults;
  if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
  const releases = await fetchPublishedReleases(endpoint, repositoryKey, hasBudget, {
    progress: state.partial.releases,
    saveProgress: async progress => { state.partial!.releases = progress; await checkpoint(); },
  });
  if (isBudgetExhausted(releases) || !hasBudget()) {
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
  if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
  const [makerDeclared, siteLinksRepository] = await Promise.all([
    isMakerLinkDeclared({
      slug: input.slug,
      kind: "repository",
      normalizedKey: repositoryKey,
    }),
    siteObservedRepository({ slug: input.slug, repositoryKey }),
  ]);
  if (!hasBudget()) return { status: "budget_exhausted", releases: 0 };
  facts.pushActivity = resumingCompletedCore ? previousFacts?.pushActivity ?? null
    : await fetchPushActivity(request, repositoryKey, now, hasBudget, facts.repositoryId);
  // Optional soft-budget exhaustion may finalize completed core; explicit cancellation may not start final writes.
  if (hardStopped()) return { status: "budget_exhausted", releases: 0 };
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

  const previousPublicFacts = Object.fromEntries(Object.entries(current?.normalizedFacts ?? {}).filter(([key]) => key !== "_githubCollection"));
  const factsChanged = !isDeepStrictEqual(previousPublicFacts, facts);
  const finalState = { ...state };
  delete finalState.partial;
  const releaseCount = await withJobLeaseWrite(dependencies.lease, async (tx) => {
    if (hardStopped()) return null;
    await upsertObservedSource({
      slug: input.slug,
      kind: "repository",
      provider: "github",
      sourceKey: repositoryKey,
      sourceUrl: `https://github.com/${repositoryKey}`,
      state: "ok",
      normalizedFacts: { ...facts, _githubCollection: finalState },
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
  if (releaseCount === null) return { status: "budget_exhausted", releases: 0 };
  // 팔로한 사람에게 새 릴리스 — commit 뒤 같은 lease 쓰기로, 실패해도 수집은 그대로(lib/me/notifications.ts)
  if (releaseCount > 0) await notifyNewReleases(productId, dependencies.lease);
  const status = !factsChanged && releaseCount === 0
    ? "not_modified"
    : "updated";
  log(status, String(root.status), releaseCount);
  return { status, releases: releaseCount };
}
