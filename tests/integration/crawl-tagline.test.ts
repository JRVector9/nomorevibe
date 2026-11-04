import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract } from "../text-task-ranks-fixture";

/**
 * 게이트웨이(abcLLM)는 2026-10-30 제거됐다. 잡은 이 경로·모델의 직접 연결 계약이 있어야 돌고, 옛 잎 writeTagline 은 이제 보내지 않고
 * no_key 로 끝난다(파일 끝 두 시험). 이 파일은 잡이 답을 받은 뒤의 판단(빈 줄 재질문·실패 시각·사람의 줄·원본 해시)을 보므로, 그 잎만
 * 같은 wire 를 이 파일의 fetch 목(gateway)으로 보내는 대역으로 바꾸고, 용량 조정기는 그 잎의 결과를 그대로 돌려주는 대역으로 둔다
 * (장부·예약·native 경로는 crawl-tagline-capacity-dispatch 가 본다). 용량 disabled 는 이제 옛 길로 떨어지지 않고 미룬다.
 * 2026-11-02(PR B): 모델은 「작업 ↔ 모델」 순위가 고른다 — 순위를 고정하고(pinTextRanks) 그 연결의 엔진 직접 계약 행(textContract)을 넣는다.
 */
// 1순위 모델 — 예전 TAGLINE_MODEL(등록부 기본값)과 같은 이름이다
const { TAGLINE_MODEL } = vi.hoisted(() => ({ TAGLINE_MODEL: "qwen3.6-35b-heretic" }));
vi.mock("@/lib/crawl/tagline", async load => {
  const original = await load<typeof import("@/lib/crawl/tagline")>();
  const { askRemovedGatewayLeaf, replyContent } = await import("./direct-engine-fixtures");
  const writeTagline: typeof original.writeTagline = (evidence, options) => askRemovedGatewayLeaf(original.writeTagline(evidence, options),
    options.request ?? fetch, original.crawlTaglineGatewayWire(evidence, options.model ?? TAGLINE_MODEL),
    async response => original.parseTagline(await replyContent(response), evidence), options);
  return { ...original, writeTagline };
});
const capacityHook = vi.hoisted(() => ({ tagline: null as null | ((task: { candidate: { repo: string }; document: Parameters<typeof import("@/lib/crawl/tagline").taglineEvidence>[1] },
  options: { timeoutMs: number; signal?: AbortSignal; previous?: unknown }) => Promise<unknown>) }));
vi.mock("@/lib/crawl/tagline-model-capacity", () => ({
  writeCrawlTaglineWithModelCapacity: async (task: { candidate: { repo: string }; document: Parameters<typeof import("@/lib/crawl/tagline").taglineEvidence>[1] },
    _job: unknown, options: { timeoutMs: number; signal?: AbortSignal; previous?: unknown }) =>
    capacityHook.tagline!(task, options),
}));

const { db } = await import("@/lib/db");
const { retryBackoffSql } = await import("@/lib/db/retry-backoff");
const { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlTaglines, jobs } = await import("@/lib/db/schema");
const crawl = await import("@/lib/crawl/repository");
const { saveSettings } = await import("@/lib/crawl/settings");
const { writeTaglines } = await import("@/lib/crawl/jobs/tagline");
const { taglineEvidence, writeTagline } = await import("@/lib/crawl/tagline");
capacityHook.tagline = async (task, options) => ({ kind: "result", result: await writeTagline(taglineEvidence(task.candidate.repo, task.document),
  { signal: options.signal, timeoutMs: options.timeoutMs }), askOrdinal: options.previous ? 2 as const : 1 as const, parent: null, expectation: undefined });
const { pendingTaglines, recordTaglineResult } = await import("@/lib/crawl/taglines");
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
  pinTextRanks({ "crawl-tagline": TAGLINE_MODEL });
  setServingContractSnapshotForTest([textContract("crawl-tagline", TAGLINE_MODEL)]);
  gateway.mockReset();
  gateway.mockResolvedValue(answer("바를 등록하면 손님이 찾습니다"));
  vi.stubGlobal("fetch", gateway);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); pinTextRanks(null); });
afterAll(async () => {
  // 마지막 옛 잎 시험이 남긴 후보·문서를 지운다 — 다른 통합 파일의 beforeAll 이 빈 대기열을 먼저 볼 수 있다.
  await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, "someone/real-leaf"));
  await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, "someone/real-leaf"));
});

describe("소개 짓기 잡", () => {
  it("preserves the tagline retry budget when its tokenizer is unavailable", async () => {
    await held("tokenizer/unavailable");
    for (let iteration = 0; iteration < 2; iteration++) {
      const [task] = await pendingTaglines(1);
      expect(task).toBeDefined();
      await runJob("crawl-tagline", async ctx => {
        expect(await recordTaglineResult(task, ctx.lease!, { kind: "failure", error: "tokenizer_unavailable" }))
          .toMatchObject({ stored: true, released: false });
        return { done: true };
      });
      const [saved] = await db.select().from(crawlTaglines);
      expect(saved).toMatchObject({ attempts: 0, errorCode: "tokenizer_unavailable", tagline: "" });
      expect(await crawl.getCandidate("tokenizer/unavailable")).toMatchObject({ state: "needs_review", reason: "no_description" });
      await db.update(crawlTaglines).set({ retryAt: sql`now()-interval '1 second'` }).where(eq(crawlTaglines.repo, "tokenizer/unavailable"));
    }
  });

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

  // 2026-10-31 결정: 잇따라 둘이 막혀도 틱을 접지 않는다 — 각 후보의 실패로만 남기고 다음 후보를 본다(하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다)
  it("실패는 다시 볼 시각을 달고 남는다 — 잇따라 막혀도 남은 후보를 모두 묻는다", async () => {
    await held("someone/my-app");
    await held("someone/other-app");
    await held("someone/third-app");
    gateway.mockResolvedValue({ ok: false, status: 429 } as Response);

    await tick();

    // 예전에는 둘이 막히면 접어 세 번째가 차례를 잃었다 — 이제 셋 다 묻고 각자의 실패로 남긴다
    expect(gateway).toHaveBeenCalledTimes(3);
    const written = await db.select().from(crawlTaglines);
    expect(written).toHaveLength(3);
    for (const row of written) {
      expect(row).toMatchObject({ errorCode: "rate_limit", attempts: 1, tagline: "" });
      expect(row.retryAt).not.toBeNull();
    }
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ state: "needs_review", reason: "no_description" });
    expect(await crawl.getCandidate("someone/other-app")).toMatchObject({ state: "needs_review", reason: "no_description" });
  });

  it("키·모델이 없다는 답(모든 후보에 대해 증명된 엔진 탈)은 한 번으로 틱을 접는다", async () => {
    for (const repo of ["someone/my-app", "someone/other-app", "someone/third-app", "someone/fourth-app"]) await held(repo);
    gateway.mockResolvedValue({ ok: false, status: 404 } as Response);

    await tick();

    // 동시에 띄운 자리(등록부 동시 호출 수)만 답을 받고 새 호출은 시작하지 않는다 — 넷을 다 묻지 않는다
    expect(gateway.mock.calls.length).toBeLessThan(4);
    expect((await db.select().from(crawlTaglines)).length).toBeLessThan(4);
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

  it("attempts 가 35여도 실패를 다시 적으면 넘치지 않고 하루 뒤로 미룬다", async () => {
    await held("someone/overflow");
    const document = (await crawl.getDocument("someone/overflow"))!;
    await db.insert(crawlTaglines).values({
      repo: "someone/overflow", tagline: "", source: "page", model: "fixture", sourceHash: "a".repeat(64),
      documentAt: new Date(document.fetchedAt.getTime() - 60_000), attempts: 35, errorCode: "model_unavailable",
      retryAt: new Date(Date.now() - 60_000),
    });
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);

    await expect(tick()).resolves.toMatchObject({ status: "completed" });

    const [row] = await db.execute<{ attempts: number; error_code: string; on_day: boolean }>(sql`
      select attempts, error_code,
        retry_at between now() + interval '24 hours' - interval '5 minutes'
          and now() + interval '24 hours' + interval '5 minutes' as on_day
      from crawl_taglines where repo = 'someone/overflow'`);
    expect(row).toMatchObject({ attempts: 36, error_code: "http_502", on_day: true });
    const minutes = async (attempts: number) => {
      const [delay] = await db.execute<{ minutes: string }>(sql`
        select extract(epoch from (${retryBackoffSql(sql`${attempts}`)} - now())) / 60 as minutes`);
      return Number(delay.minutes);
    };
    expect(await minutes(0)).toBeCloseTo(5, 2);
    expect(await minutes(1)).toBeCloseTo(10, 2);
    expect(await minutes(8)).toBeCloseTo(1280, 2);
    expect(await minutes(9)).toBeCloseTo(24 * 60, 2);
    expect(await minutes(35)).toBeCloseTo(24 * 60, 2);
  });

  // PR B: 순위의 연결을 가리키는 직접 계약이 없으면 그 순위를 쓸 수 없다 — 순위가 하나뿐이니 all_ranks_unusable(예전 no_direct_contract)
  it("직접 연결 계약이 없으면 부르지 않고 all_ranks_unusable 로 넘긴다 — 성공이 아니다", async () => {
    await held("someone/no-contract");
    setServingContractSnapshotForTest([]);

    expect(await tick()).toMatchObject({ status: "completed", done: true, degraded: "all_ranks_unusable" });

    expect(gateway).not.toHaveBeenCalled();
    expect(await db.select().from(crawlTaglines)).toEqual([]);
    expect(await crawl.getCandidate("someone/no-contract")).toMatchObject({ state: "needs_review", reason: "no_description" });
    // 관리자 상태 화면이 읽는 까닭 — 순위마다 쓸 수 없는 까닭을 적는다
    const [observed] = await db.execute<{ detail: string }>(sql`select value->'degraded'->>'detail' as detail from operations_observations where key = 'job:crawl-tagline'`);
    expect(observed.detail).toContain(`1순위 test-engine · ${TAGLINE_MODEL}: 이 연결·모델의 엔진 직접 계약이 없음`);
  });

  it("순위가 없으면 코드 기본값으로 부르지 않고 no_task_models 로 넘긴다 — 성공이 아니다", async () => {
    await held("someone/no-ranks");
    pinTextRanks([]);

    expect(await tick()).toMatchObject({ status: "completed", done: true, degraded: "no_task_models" });

    expect(gateway).not.toHaveBeenCalled();
    expect(await db.select().from(crawlTaglines)).toEqual([]);
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
