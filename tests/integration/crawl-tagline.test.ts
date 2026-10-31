import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { directContractRow } from "./direct-engine-fixtures";

/**
 * 게이트웨이(abcLLM)는 2026-10-30 제거됐다. 잡은 이 경로·모델의 직접 연결 계약이 있어야 돌고, 용량을 끈(disabled) 잡이 부르는 옛 잎
 * writeTagline 은 이제 보내지 않고 no_key 로 끝난다(파일 끝 두 시험). 이 파일은 잡이 답을 받은 뒤의 판단(빈 줄 재질문·실패 시각·사람의 줄·
 * 원본 해시)을 보므로, 그 잎만 같은 wire 를 이 파일의 fetch 목(gateway)으로 보내는 대역으로 바꾼다(direct-engine-fixtures).
 */
vi.mock("@/lib/crawl/tagline", async load => {
  const original = await load<typeof import("@/lib/crawl/tagline")>();
  const { askRemovedGatewayLeaf, replyContent } = await import("./direct-engine-fixtures");
  const writeTagline: typeof original.writeTagline = (evidence, options) => askRemovedGatewayLeaf(original.writeTagline(evidence, options),
    options.request ?? fetch, original.crawlTaglineGatewayWire(evidence, options.model ?? original.TAGLINE_MODEL),
    async response => original.parseTagline(await replyContent(response), evidence), options);
  return { ...original, writeTagline };
});

const { db } = await import("@/lib/db");
const { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlTaglines, jobs } = await import("@/lib/db/schema");
const crawl = await import("@/lib/crawl/repository");
const { saveSettings } = await import("@/lib/crawl/settings");
const { writeTaglines } = await import("@/lib/crawl/jobs/tagline");
const { TAGLINE_MODEL, taglineEvidence } = await import("@/lib/crawl/tagline");
const { runJob } = await import("@/lib/jobs/runner");
const { ensureSchema, resetTables } = await import("./setup");

/** 소개가 없어 발행이 멈춘 후보 하나 */
async function held(repo: string, pageMeta: Record<string, unknown> = { title: "My App", textSample: "바를 등록하면 손님이 찾을 수 있습니다" }) {
  await crawl.putDocument({
    repo, repoMeta: { description: null, language: "TypeScript" },
    productUrl: "https://my-app.test", pageStatus: 200, pageMeta,
  });
  await crawl.recordJudgement({ repo, productUrl: "https://my-app.test", state: "needs_review", reason: "no_description", decidedBy: "auto" });
}

const answer = (tagline: string, source = "page") =>
  ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ tagline, source }) } }] }) }) as unknown as Response;

const tick = () => runJob("crawl-tagline", writeTaglines);

const gateway = vi.fn();

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlTaglines);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  await saveSettings({ enabled: true }, "테스트");
  setServingContractSnapshotForTest([directContractRow("crawl-tagline", TAGLINE_MODEL)]);
  gateway.mockReset();
  gateway.mockResolvedValue(answer("바를 등록하면 손님이 찾습니다"));
  vi.stubGlobal("fetch", gateway);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });

describe("소개 짓기 잡", () => {
  it("한 줄을 지어 두고 후보를 발행 대기로 되돌린다", async () => {
    await held("someone/my-app");

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    const [written] = await db.select().from(crawlTaglines);
    expect(written).toMatchObject({ repo: "someone/my-app", tagline: "바를 등록하면 손님이 찾습니다", source: "page", errorCode: null });
    // 발행할지는 발행 잡이 평소 관문으로 정한다 — 여기서는 대기줄로 돌려놓기만 한다
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ state: "approved", reason: "passed", decidedBy: "auto" });
  });

  it("증거로 알 수 없다고 하면 사람에게 남기고 다시 묻지 않는다", async () => {
    await held("someone/mystery");
    gateway.mockResolvedValue(answer(""));

    await tick();
    await tick();

    expect(await crawl.getCandidate("someone/mystery")).toMatchObject({ state: "needs_review", reason: "no_description" });
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "" });
    // 첫 틱에 두 번 묻고(빈 줄 재시도), 두 번째 틱은 이미 답이 있어 묻지 않는다
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  it("빈 줄이 오면 한 번만 더 묻는다 — 두 번째에 줄이 오면 그것을 쓴다", async () => {
    await held("someone/second-try");
    gateway.mockResolvedValueOnce(answer("")).mockResolvedValue(answer("바를 등록하면 손님이 찾습니다"));

    await tick();

    expect(gateway).toHaveBeenCalledTimes(2);
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "바를 등록하면 손님이 찾습니다" });
    expect(await crawl.getCandidate("someone/second-try")).toMatchObject({ state: "approved" });
  });

  it("읽을 글이 아무 데도 없으면 모델을 부르지 않는다", async () => {
    await held("someone/empty", { title: null, textSample: null, readmeSample: null });

    await tick();

    expect(gateway).not.toHaveBeenCalled();
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "", model: "" });
  });

  it("사람이 적은 줄은 다시 짓지 않는다", async () => {
    await held("someone/by-hand");
    const { writeTaglineByHand } = await import("@/lib/crawl/taglines");
    const document = await crawl.getDocument("someone/by-hand");
    await writeTaglineByHand({ repo: "someone/by-hand", tagline: "사람이 적은 한 줄", by: "admin", documentAt: document!.fetchedAt });

    await tick();

    expect(gateway).not.toHaveBeenCalled();
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "사람이 적은 한 줄", writtenBy: "admin" });
  });

  it("사람이 승인했지만 소개가 없어 멈춘 후보도 한 줄을 지어 승인을 발행까지 잇는다", async () => {
    // 발행은 사람의 승인도 소개 없이는 올리지 않는다(2026-10-14) — 멈춘 그 후보다
    await held("someone/mine");
    await db.update(crawlCandidates).set({ decidedBy: "admin" }).where(eq(crawlCandidates.repo, "someone/mine"));

    await tick();

    expect(gateway).toHaveBeenCalledTimes(1);
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ repo: "someone/mine", tagline: "바를 등록하면 손님이 찾습니다", writtenBy: null });
    // 사람의 결정은 그대로 남는다 — 발행이 사람의 승인으로 올린다
    expect(await crawl.getCandidate("someone/mine")).toMatchObject({ state: "approved", reason: "passed", decidedBy: "admin" });
  });

  it("실패는 다시 볼 시각을 달고 남는다 — 잇따라 둘이 막히면 이번 틱은 접는다", async () => {
    await held("someone/my-app");
    await held("someone/other-app");
    gateway.mockResolvedValue({ ok: false, status: 429 } as Response);

    await tick();

    // 한 건의 실패로 접지 않는다 — 둘 다 물어보고 나서 접는다
    expect(gateway).toHaveBeenCalledTimes(2);
    const [written] = await db.select().from(crawlTaglines);
    expect(written).toMatchObject({ errorCode: "rate_limit", attempts: 1, tagline: "" });
    expect(written.retryAt).not.toBeNull();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ state: "needs_review", reason: "no_description" });
    expect(await crawl.getCandidate("someone/other-app")).toMatchObject({ state: "needs_review", reason: "no_description" });
  });

  it("실패한 줄은 다시 볼 때가 되면 같은 원본이라도 다시 묻는다", async () => {
    await held("someone/flaky");
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);
    await tick();
    // 다시 볼 시각을 앞당긴다 — 운영에서는 5분 뒤다
    await db.update(crawlTaglines).set({ retryAt: new Date(Date.now() - 1_000) }).where(eq(crawlTaglines.repo, "someone/flaky"));
    gateway.mockClear();
    gateway.mockResolvedValue(answer("바를 등록하면 손님이 찾습니다"));

    await tick();

    expect(gateway).toHaveBeenCalled();
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "바를 등록하면 손님이 찾습니다", errorCode: null });
    expect(await crawl.getCandidate("someone/flaky")).toMatchObject({ state: "approved" });
  });

  it("원본을 다시 긁었지만 내용이 그대로면 또 부르지 않는다", async () => {
    await held("someone/steady");
    gateway.mockResolvedValue(answer(""));
    await tick();
    gateway.mockClear();
    // 재수집 — 같은 페이지를 다시 받아 왔다
    await crawl.putDocument({
      repo: "someone/steady", repoMeta: { description: null, language: "TypeScript" },
      productUrl: "https://my-app.test", pageStatus: 200,
      pageMeta: { title: "My App", textSample: "바를 등록하면 손님이 찾을 수 있습니다" },
    });

    await tick();

    expect(gateway).not.toHaveBeenCalled();
  });

  it("페이지가 바뀌면 다시 짓는다", async () => {
    await held("someone/changed");
    gateway.mockResolvedValue(answer(""));
    await tick();
    gateway.mockClear();
    await crawl.putDocument({
      repo: "someone/changed", repoMeta: { description: null, language: "TypeScript" },
      productUrl: "https://my-app.test", pageStatus: 200,
      pageMeta: { title: "My App", textSample: "이제 무엇을 하는 것인지 페이지가 말한다" },
    });
    gateway.mockResolvedValue(answer("이제 무엇을 하는지 알 수 있다"));

    await tick();

    expect(gateway).toHaveBeenCalledTimes(1);
    expect((await db.select().from(crawlTaglines))[0]).toMatchObject({ tagline: "이제 무엇을 하는지 알 수 있다" });
    expect(await crawl.getCandidate("someone/changed")).toMatchObject({ state: "approved" });
  });

  it("직접 연결 계약이 없으면 부르지 않고 no_direct_contract 로 넘긴다 — 성공이 아니다", async () => {
    await held("someone/no-contract");
    setServingContractSnapshotForTest([]);

    expect(await tick()).toMatchObject({ status: "completed", done: true, degraded: "no_direct_contract" });

    expect(gateway).not.toHaveBeenCalled();
    expect(await db.select().from(crawlTaglines)).toEqual([]);
    expect(await crawl.getCandidate("someone/no-contract")).toMatchObject({ state: "needs_review", reason: "no_description" });
  });

  it("옛 잎(writeTagline)은 계약이 있어도 게이트웨이로 보내지 않고 no_key 로 끝난다", async () => {
    await held("someone/real-leaf");
    const real = await vi.importActual<typeof import("@/lib/crawl/tagline")>("@/lib/crawl/tagline");
    const document = (await crawl.getDocument("someone/real-leaf"))!;

    expect(await real.writeTagline(taglineEvidence("someone/real-leaf", document), { timeoutMs: 1_000, request: gateway }))
      .toEqual({ ok: false, error: "no_key" });
    expect(gateway).not.toHaveBeenCalled();
  });
});
