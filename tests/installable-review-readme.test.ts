import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";

/**
 * 설치형 1차 심사 입력에 README 가 빈 채로 들어가던 문제(2026-11-17, 운영 보류 535건)의 TS 쪽 사슬.
 * GitHub raw README(모의) → loadReviewDocument → createReviewInput 의 snapshot.product.readme 까지 본다.
 * 원인이던 DB 대조(fetched_at 마이크로초)는 tests/integration/installable-review-readme.test.ts 가 시험 DB 에서 재현한다.
 */
const raw = vi.hoisted(() => ({ fetchCapped: vi.fn() }));
vi.mock("@/lib/net/fetch", () => ({ fetchCapped: raw.fetchCapped }));

const store = vi.hoisted(() => ({ documents: new Map<string, CrawlDocument>() }));
vi.mock("@/lib/crawl/repository", () => ({
  getDocument: async (repo: string) => store.documents.get(repo),
  setReadmeSample: async (repo: string, readmeSample: string, expected: CrawlDocument) => {
    if (store.documents.get(repo) !== expected) return undefined;
    const meta = { ...expected.pageMeta };
    delete meta.readmeFetchError; delete meta.readmeFetchAttempts; delete meta.readmeFetchRetryAfter;
    const next = { ...expected, pageMeta: { ...meta, readmeSample, readmeSampleVersion: (await import("@/lib/crawl/readme")).README_SAMPLE_VERSION } };
    store.documents.set(repo, next);
    return next;
  },
  recordReadmeFetchFailure: async (expected: CrawlDocument, failure: { error: string }, _lease: unknown, now: number) => {
    if (store.documents.get(expected.repo) !== expected) return undefined;
    const attempts = typeof expected.pageMeta?.readmeFetchAttempts === "number" ? expected.pageMeta.readmeFetchAttempts + 1 : 1;
    const next = { ...expected, pageMeta: { ...expected.pageMeta, readmeFetchError: failure.error, readmeFetchAttempts: attempts,
      readmeFetchRetryAfter: now + 15 * 60_000 * 2 ** (attempts - 1) } };
    store.documents.set(expected.repo, next);
    return next;
  },
}));

const { fetchReadmeResult, README_SAMPLE_VERSION } = await import("@/lib/crawl/readme");
const { loadReviewDocument, reviewReadmeState, README_FETCH_WAIT_ATTEMPTS } = await import("@/lib/crawl/jobs/review-document");
const { createReviewInput } = await import("@/lib/crawl/agent-review-contract");
const { mergeWithDefaults } = await import("@/lib/crawl/settings");

const README_MD = "# agent-bridge-mcp\n\nAn MCP server that bridges agents.\n\n## Install\n\n`npx agent-bridge-mcp`\n";
const ok = (body: string) => ({ ok: true, status: 200, finalUrl: "https://raw.githubusercontent.com/x", headers: new Headers(), body: Buffer.from(body) });
const notFound = { ok: false, reason: "http", status: 404 };

function document(repo: string, productUrl: string | null, pageMeta: Record<string, unknown> | null): CrawlDocument {
  return { id: 7, repo, repoMeta: { stargazers_count: 12, description: "bridge" }, productUrl, pageStatus: productUrl ? 200 : null,
    pageMeta, fetchedAt: new Date() } as CrawlDocument;
}
function candidate(repo: string, productUrl: string | null): CrawlCandidate {
  return { id: 1, repo, productUrl, state: "new", signals: {}, judgedAt: new Date() } as unknown as CrawlCandidate;
}
async function firstReviewReadme(repo: string, productUrl: string | null) {
  const loaded = await loadReviewDocument(repo);
  return createReviewInput(candidate(repo, productUrl), loaded!, mergeWithDefaults({}), { scan: null, observations: [] })
    .snapshot.product.readme;
}

beforeEach(() => { store.documents.clear(); raw.fetchCapped.mockReset(); });

describe("first-review README for installable and website documents", () => {
  it("fills snapshot.product.readme of an installable document without page metadata from the GitHub README", async () => {
    store.documents.set("vstratful/agent-bridge-mcp", document("vstratful/agent-bridge-mcp", null, null));
    raw.fetchCapped.mockResolvedValueOnce(ok(README_MD));
    const readme = await firstReviewReadme("vstratful/agent-bridge-mcp", null);
    expect(readme).toContain("An MCP server that bridges agents.");
    expect(readme).toContain("npx agent-bridge-mcp");
    expect(raw.fetchCapped.mock.calls[0][0]).toBe("https://raw.githubusercontent.com/vstratful/agent-bridge-mcp/HEAD/README.md");
  });

  it("fills snapshot.product.readme of a document with a product page", async () => {
    store.documents.set("acme/site-tool", document("acme/site-tool", "https://site-tool.example/", { title: "Site tool" }));
    raw.fetchCapped.mockResolvedValueOnce(notFound).mockResolvedValueOnce(ok("Site tool\n\nSign up at https://site-tool.example"));
    expect(await firstReviewReadme("acme/site-tool", "https://site-tool.example/")).toContain("Sign up");
  });

  it("treats README absence (404 for every name) as a known empty README, not a failure", async () => {
    store.documents.set("acme/no-readme", document("acme/no-readme", null, null));
    raw.fetchCapped.mockResolvedValue(notFound);
    expect(await firstReviewReadme("acme/no-readme", null)).toBe("");
    expect(store.documents.get("acme/no-readme")?.pageMeta).toEqual({ readmeSample: "", readmeSampleVersion: README_SAMPLE_VERSION });
    expect(reviewReadmeState(store.documents.get("acme/no-readme")!)).toEqual({ kind: "ready" });
  });
});

describe("README fetch failures are distinguished from absence", () => {
  it.each([
    [{ ok: false, reason: "http", status: 429 }, "http_429"],
    [{ ok: false, reason: "http", status: 403 }, "http_403"],
    [{ ok: false, reason: "http", status: 503 }, "http_503"],
    [{ ok: false, reason: "http", status: 0 }, "http_0"],
    [{ ok: false, reason: "timeout" }, "timeout"],
  ])("reports %o as %s", async (response, error) => {
    raw.fetchCapped.mockResolvedValueOnce(response);
    expect(await fetchReadmeResult("acme/limited")).toEqual({ ok: false, error, retryAfter: null });
  });

  it("records the failure, waits instead of reviewing an empty README, and gives up waiting after the limit", async () => {
    const repo = "acme/limited";
    store.documents.set(repo, document(repo, null, null));
    raw.fetchCapped.mockResolvedValue({ ok: false, reason: "http", status: 429 });
    let now = Date.parse("2026-11-17T05:00:00Z");
    let loaded = await loadReviewDocument(repo, undefined, now);
    expect(loaded?.pageMeta).toMatchObject({ readmeFetchError: "http_429", readmeFetchAttempts: 1 });
    expect(reviewReadmeState(loaded!)).toMatchObject({ kind: "waiting", error: "http_429", attempts: 1 });
    // 기다릴 시각 전에는 다시 받지 않는다
    await loadReviewDocument(repo, undefined, now + 60_000);
    expect(raw.fetchCapped).toHaveBeenCalledTimes(1);
    for (let attempt = 2; attempt <= README_FETCH_WAIT_ATTEMPTS; attempt++) {
      now = (loaded!.pageMeta!.readmeFetchRetryAfter as number) + 1;
      loaded = await loadReviewDocument(repo, undefined, now);
    }
    expect(reviewReadmeState(loaded!)).toEqual({ kind: "unavailable", error: "http_429", attempts: README_FETCH_WAIT_ATTEMPTS });
    // 기다림을 다 쓴 뒤의 입력 모양은 그대로다 — README 는 빈 글자, 까닭은 원본에 남는다
    expect(createReviewInput(candidate(repo, null), loaded!, mergeWithDefaults({}), { scan: null, observations: [] }).snapshot.product.readme).toBe("");
  });

  it("clears the failure record once the README arrives", async () => {
    const repo = "acme/recovered";
    store.documents.set(repo, document(repo, null, { readmeFetchError: "http_429", readmeFetchAttempts: 1, readmeFetchRetryAfter: 1 }));
    raw.fetchCapped.mockResolvedValueOnce(ok(README_MD));
    const loaded = await loadReviewDocument(repo, undefined, 2);
    expect(loaded?.pageMeta).toEqual({ readmeSample: expect.stringContaining("bridges agents"), readmeSampleVersion: README_SAMPLE_VERSION });
    expect(reviewReadmeState(loaded!)).toEqual({ kind: "ready" });
  });
});
