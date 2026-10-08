import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// 발행은 OG 복사·분류에서 바깥을 탄다 — 이 파일은 관문만 본다
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: vi.fn().mockResolvedValue(null),
  classifyCategories: vi.fn().mockImplementation(async (inputs: unknown[]) => inputs.map(() => null)),
}));
// 1차 AI 심사의 바깥 CLI 만 바꾼다 — 스팸 의심은 여기까지 오면 안 된다
const review = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: review,
}));

const { db } = await import("@/lib/db");
const { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, crawlTaglines, jobs, products: productsTable } =
  await import("@/lib/db/schema");
const crawl = await import("@/lib/crawl/repository");
const { judgeRevision } = await import("@/lib/crawl/rules");
const { README_SAMPLE_VERSION } = await import("@/lib/crawl/readme");
const { changeReviewMode, getSettings, saveSettings } = await import("@/lib/crawl/settings");
const { judgeCrawlDocuments } = await import("@/lib/crawl/jobs/judge");
const { publishCandidates } = await import("@/lib/crawl/jobs/publish");
const { reviewCrawlCandidates } = await import("@/lib/crawl/jobs/agent-review");
const { listReviewCandidates } = await import("@/lib/crawl/agent-review-repository");
const { requeueResolvedCandidates, reviewQueueCauses } = await import("@/lib/crawl/admin-review");
const { runJob } = await import("@/lib/jobs/runner");
const products = await import("@/lib/domain/products/repository");
const { getNewThisWeek, getPublicList } = await import("@/lib/domain/products/view");
const { ensureSchema, resetTables } = await import("./setup");

/** 프로드 /p/codex-deepseek 를 줄인 것 — 틀 제목·다운로드 미끼·남의 github.io 첫 화면·★1·이슈 꺼짐 */
const SPAM_REPO_META = {
  name: "codex-deepseek", owner: { login: "Promisedlandsubtraction2856", type: "User" },
  stargazers_count: 1, fork: false, archived: false, has_issues: false,
  description: "Run the real OpenAI Codex CLI on DeepSeek models.",
};
const SPAM_URL = "https://promisedlandsubtraction2856.github.io";
const SPAM_PAGE = {
  title: "🤖 codex-deepseek - Run Real OpenAI Codex on DeepSeek Models",
  description: "Isolated CODEX_HOME, easy installers for Windows/macOS/Linux.",
  textSample: "⬇️ Download Codex-DeepSeek Now. Visit this link to download the application.",
};
/** 같은 캠페인인데 페이지만으로는 강한 신호가 하나뿐이다 — README 를 받아야 드러난다 */
const QUIET_PAGE = { title: "codex-deepseek", description: "Run Codex on DeepSeek models." };
const SPAM_README = "🤖 codex-deepseek - Run Codex on DeepSeek Models\n\n"
  + "1. **Download** – Visit this link to download the application: https://promisedlandsubtraction2856.github.io";
const SPAM_REPO = "Promisedlandsubtraction2856/codex-deepseek";

const judge = () => runJob("crawl-judge", judgeCrawlDocuments);
const publish = () => runJob("crawl-publish", publishCandidates);

async function putSpam(pageMeta: Record<string, unknown> = SPAM_PAGE, repo = SPAM_REPO, repoMeta: Record<string, unknown> = {}) {
  await crawl.putDocument({ repo, productUrl: SPAM_URL, pageStatus: 200, pageMeta,
    repoMeta: { ...SPAM_REPO_META, pushed_at: new Date().toISOString(), ...repoMeta } });
}

/** 탐지기가 생기기 전에 승인돼 발행을 기다리던 후보 — 판정 리비전은 지금 원본과 같다 */
async function approvedBeforeDetector(repo: string, productUrl: string, decidedBy: "auto" | "admin" = "auto") {
  const document = await crawl.getDocument(repo);
  await crawl.recordJudgement({ repo, productUrl, state: "approved", reason: "passed", decidedBy,
    signals: { stars: 1, judgedRevision: judgeRevision(document!) } });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlTaglines);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  review.mockReset();
  await saveSettings({ enabled: true }, "test");
});

describe("spam gate", () => {
  it("holds a flagged candidate for a person as suspected_spam, keeps the signals, and does not wake AI review", async () => {
    await putSpam();
    await judge();
    const candidate = await crawl.getCandidate(SPAM_REPO);
    expect(candidate).toMatchObject({ state: "needs_review", reason: "suspected_spam", decidedBy: "auto",
      signals: { suspectedSpam: { confidence: "high" }, stoppedAt: { rule: "스팸·악성 배포 의심 아님" } } });
    expect((candidate!.signals!.suspectedSpam as { signals: { key: string }[] }).signals.map(signal => signal.key))
      .toEqual(expect.arrayContaining(["templated_title", "download_lure", "pages_root_landing"]));
    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-agent-review") })).toBeUndefined();
    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-publish") })).toBeUndefined();
  });

  it("is never picked again by AI review or rule requeue, and is counted in its own queue bucket", async () => {
    await putSpam();
    await judge();
    const settings = { ...await getSettings(), reviewMode: "enforce" as const };
    expect(await listReviewCandidates(settings, 20)).toEqual([]);
    expect(await requeueResolvedCandidates("test")).toMatchObject({ requeued: 0 });
    expect(await crawl.getCandidate(SPAM_REPO)).toMatchObject({ state: "needs_review", reason: "suspected_spam" });
    const causes = await reviewQueueCauses(settings);
    expect(causes.counts).toEqual([{ cause: "suspected_spam", count: 1 }]);
  });

  it("does not publish an automatic approval made before the detector, and hands it to a person", async () => {
    await putSpam(QUIET_PAGE);
    await db.update(crawlDocuments).set({ pageMeta: { ...QUIET_PAGE, readmeSample: SPAM_README, readmeSampleVersion: README_SAMPLE_VERSION } })
      .where(eq(crawlDocuments.repo, SPAM_REPO));
    await approvedBeforeDetector(SPAM_REPO, SPAM_URL);
    await publish();
    expect(await products.findByUrl(SPAM_URL)).toBeUndefined();
    expect(await crawl.getCandidate(SPAM_REPO)).toMatchObject({ state: "needs_review", reason: "suspected_spam",
      signals: { suspectedSpam: { confidence: "high" }, stoppedAt: { rule: "발행 조건" } } });
  });

  it("publishes it once a person approved it", async () => {
    await putSpam();
    await approvedBeforeDetector(SPAM_REPO, SPAM_URL, "admin");
    await publish();
    expect(await products.findByUrl(SPAM_URL)).toMatchObject({ status: "seeded" });
  });

  it("hands a candidate whose README reveals the pattern to a person before any model call", async () => {
    vi.stubEnv("CRAWL_REVIEW_MODEL", "test-model");
    vi.stubEnv("CRAWL_REVIEW_READY", "true");
    expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "spam gate test" })).toMatchObject({ ok: true });
    // 판정은 README 없이 페이지만 봤다 — 강한 신호 하나에 약한 신호 둘(이슈는 켜 둠)이라 통과했다
    await putSpam(QUIET_PAGE, SPAM_REPO, { has_issues: true });
    await judge();
    expect(await crawl.getCandidate(SPAM_REPO)).toMatchObject({ state: "approved" });
    // 심사 직전에 받은 README(받은 것으로 둔다 — 바깥을 타지 않게)
    await db.update(crawlDocuments).set({ pageMeta: { ...QUIET_PAGE, readmeSample: SPAM_README, readmeSampleVersion: README_SAMPLE_VERSION } })
      .where(eq(crawlDocuments.repo, SPAM_REPO));
    expect(await runJob("crawl-agent-review", reviewCrawlCandidates)).toMatchObject({ status: "completed" });
    expect(review).not.toHaveBeenCalled();
    expect(await crawl.getCandidate(SPAM_REPO)).toMatchObject({ state: "needs_review", reason: "suspected_spam",
      signals: { suspectedSpam: { confidence: "high" } } });
    vi.unstubAllEnvs();
  });

  it("holds the page-only shape at judging when all three weak signals line up (low confidence)", async () => {
    // 같은 캠페인 계정 — ★1·이슈 꺼짐·무작위 계정 이름이 다 겹치면 README 를 받기 전 규칙 판정에서 사람에게 넘긴다
    await putSpam(QUIET_PAGE);
    await judge();
    expect(await crawl.getCandidate(SPAM_REPO)).toMatchObject({ state: "needs_review", reason: "suspected_spam",
      signals: { suspectedSpam: { confidence: "low" } } });
  });

  it("leaves a legit low-star repository with a github.io site alone", async () => {
    await crawl.putDocument({ repo: "jane/lagebuch", productUrl: "https://jane.github.io", pageStatus: 200,
      repoMeta: { name: "lagebuch", owner: { login: "jane", type: "User" }, stargazers_count: 0, has_issues: true,
        description: "Einsatzdokumentation", pushed_at: new Date().toISOString() },
      pageMeta: { title: "Einsatzdokumentation für den ELW", description: "Lagebuch für den Einsatzleitwagen" } });
    await judge();
    expect((await crawl.getCandidate("jane/lagebuch"))?.reason).not.toBe("suspected_spam");
  });
});

describe("newest lists wait for the repository check", () => {
  const listed = async (slug: string, repoUrl: string | null, repoStatus: "ok" | "not_found" | null, stars = 100) => {
    await products.insert({ slug, url: `https://${slug}.test`, repoUrl, repoStatus, stars, name: slug, tagline: slug,
      description: slug, category: "Dev", status: "seeded", source: "crawler", verifyToken: `verify-${slug}`, editTokenHash: "x".repeat(64) });
  };
  const slugs = (rows: { slug: string }[]) => rows.map(row => row.slug).sort();

  beforeEach(async () => {
    await db.delete(productsTable);
    await listed("checked", "https://github.com/maker/checked", "ok");
    await listed("unchecked", "https://github.com/maker/unchecked", null);
    await listed("no-repo", null, null);
    await listed("gitlab", "https://gitlab.com/maker/tool", null);
  });

  it("hides unchecked GitHub repositories from the recent list, its count, new-this-week and the discovery board", async () => {
    expect(slugs(await getPublicList(10, { sort: "recent", repoChecked: true }))).toEqual(["checked", "gitlab", "no-repo"]);
    expect(await products.countProducts({ statuses: ["seeded", "verified"], excludeDown: true, repoChecked: true })).toBe(3);
    expect(slugs(await getNewThisWeek(10, new Date(Date.now() - 86_400_000)))).toEqual(["checked", "gitlab", "no-repo"]);
    expect(slugs(await products.listRecentlyDiscovered(10))).toEqual(["checked", "gitlab", "no-repo"]);
  });

  it("does not change other lists", async () => {
    expect(slugs(await getPublicList(10, { sort: "recent" }))).toEqual(["checked", "gitlab", "no-repo", "unchecked"]);
    expect(slugs(await getPublicList(10, { sort: "stars" }))).toEqual(["checked", "gitlab", "no-repo", "unchecked"]);
    expect(await products.countProducts({ statuses: ["seeded", "verified"], excludeDown: true })).toBe(4);
  });
});
