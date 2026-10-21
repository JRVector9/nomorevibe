import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { auditPublishedProducts, latencyStats, QWEN_CALL_TIMEOUT_MS, QWEN_MIN_START_MS, qwenAuditBackoffMs, qwenAuditConcurrency,
  resetQwenAuditBackoff } from "@/lib/crawl/jobs/product-audit";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { QWEN_V2_PROMPT_VERSION, reviewWithQwenDirect } from "@/lib/crawl/qwen-direct-review";
import { qwenEndpointBackingOff, qwenEndpointBackoff, qwenSoftFailures } from "@/lib/crawl/qwen-endpoint-backoff";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";

/**
 * 남은 감사 모델 바꾸기(0112) 뒤의 감사 틱 — Qwen 직접 심사(qwen-direct-review.ts)는 진짜로 돌고 HTTP 끝(gpu3090 vLLM)만 가짜다.
 * 감사 행·일감·기록은 이 파일이 흉내 낸다(DB 를 여는 쪽은 tests/integration/product-audit-qwen.test.ts).
 */
const mocks = vi.hoisted(() => ({ campaign: vi.fn(), settings: vi.fn(), candidates: vi.fn(), pending: vi.fn(),
  input: vi.fn(), record: vi.fn(), noSource: vi.fn(), inputFailed: vi.fn(), finish: vi.fn(), gateway: vi.fn(),
  realReview: null as typeof import("@/lib/crawl/qwen-direct-review").reviewWithQwenDirect | null }));
// Qwen-v2 두 번째 의견 단계(감사 잡 틱 안에서 나란히 돈다)는 tests/integration/audit-second-opinion-auto.test.ts 가 본다 — 여기 가짜 서버의 호출 수는 감사 묻기만
vi.mock("@/lib/crawl/audit-second-opinion-auto", () => ({ runQwenSecondOpinions: async () => null }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ listReviewCandidates: mocks.candidates }));
vi.mock("@/lib/crawl/product-audit-hold", () => ({ sweepAuditHolds: async () => 0 }));
vi.mock("@/lib/crawl/product-audit", () => ({ runningAuditCampaign: mocks.campaign, pendingAuditItems: mocks.pending,
  loadAuditInput: mocks.input, recordAuditResult: mocks.record, markAuditNoSource: mocks.noSource, markAuditInputFailed: mocks.inputFailed,
  finishAuditCampaign: mocks.finish }));
// 진짜 제공자를 그대로 부르되 넘긴 제한 시간을 본다
vi.mock("@/lib/crawl/qwen-direct-review", async (original) => {
  const actual = await original<typeof import("@/lib/crawl/qwen-direct-review")>();
  mocks.realReview = actual.reviewWithQwenDirect;
  return { ...actual, reviewWithQwenDirect: vi.fn(actual.reviewWithQwenDirect) };
});
vi.mock("@/lib/llm/capacity-repository", () => ({
  readModelCapacityCallerControl: async () => ({ mode: "disabled", epoch: 1, revision: 1, policyHash: null, policy: null }),
}));

const QWEN_URL = "http://qwen.test/v1";
const QWEN_MODEL = "qwen3.8-flash-next";
/** 감사 #4 — gpt-oss 로 시작해 남은 것을 Qwen 으로 바꿨다 */
const switched = { id: 4, provider: "abcllm", model: "[MLX] gpt-oss-120b", currentProvider: "qwen-direct", currentModel: QWEN_MODEL,
  promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, status: "running" };

function reviewInput() {
  const now = new Date();
  return createReviewInput({ repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Demo", textSample: "Sign up to track tasks" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
const outcome = { decision: "reject", reason: 'pageText: "Acme" — a marketing site for a design agency', evidenceIds: ["product"], confidence: 1 };
const body = (content: string) => JSON.stringify({ model: QWEN_MODEL, choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 5_000, completion_tokens: 120 } });

/** 가짜 vLLM — 부를 때마다 ms 만큼 걸린다. 몇 개가 동시에 떠 있었는지, 언제 시작했는지 센다. 끊으면 AbortError.
 * respond 가 Error 를 돌려주면 그만큼 기다린 뒤 던진다 — TimeoutError(DOMException)는 제공자가 시간 초과(qwen_timeout)로 읽는다 */
function endpoint(options: { ms?: number | ((call: number) => number); respond?: (call: number) => Response | Error } = {}) {
  const state = { inFlight: 0, maxInFlight: 0, starts: [] as number[], aborted: 0, urls: [] as string[], heads: [] as Headers[] };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const call = state.starts.length;
    state.starts.push(Date.now());
    state.urls.push(String(url));
    state.heads.push(new Headers(init.headers));
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, typeof options.ms === "function" ? options.ms(call) : options.ms ?? 3_000);
        init.signal?.addEventListener("abort", () => { clearTimeout(timer); state.aborted += 1; reject(init.signal?.reason); }, { once: true });
      });
    } finally { state.inFlight -= 1; }
    const answer = options.respond?.(call) ?? new Response(body(JSON.stringify(outcome)), { status: 200 });
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal("fetch", fetcher);
  return { state, fetcher };
}

/** 마지막으로 만든 문맥 — 틱이 남긴 로그를 본다 */
let lastContext: JobContext<null> | null = null;
const context = (over: Partial<JobContext<null>> = {}): JobContext<null> => {
  const startedAt = Date.now();
  lastContext = { cursor: null, save: vi.fn(), hasBudget: () => Date.now() - startedAt < 70_000, deadlineAt: startedAt + 70_000, log: vi.fn(),
    lease: { name: "product-audit", token: "owned", requestedVersion: 1 }, ...over };
  return lastContext;
};
/** 한 틱을 끝까지 — 러너 예산(70초)을 흘려 보낸다 */
async function tick(ctx = context()) {
  const running = auditPublishedProducts(ctx).then((value) => ({ value }), (error: Error) => ({ error }));
  await vi.advanceTimersByTimeAsync(70_000);
  return running;
}
const recorded = () => mocks.record.mock.calls.map(([call]) => call);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(reviewWithQwenDirect).mockImplementation(mocks.realReview!);
  vi.useFakeTimers();
  resetQwenAuditBackoff();
  vi.stubEnv("AUDIT_SECOND_OPINION_URL", QWEN_URL);
  vi.stubEnv("AUDIT_SECOND_OPINION_MODEL", "some-other-model");
  vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "");
  mocks.campaign.mockResolvedValue(switched);
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewConcurrency: 1 });
  mocks.candidates.mockResolvedValue([]);
  // 틱마다 새 목록 — 잡이 줄을 앞에서부터 꺼낸다
  mocks.pending.mockImplementation(async (_campaign: number, limit: number) =>
    Array.from({ length: Math.min(limit, 500) }, (_, index) => ({ id: 100 + index, slug: `p${index}` })));
  mocks.input.mockImplementation(async () => reviewInput());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("바꾼 감사는 Qwen 에게 묻는다", () => {
  it("감사 행의 Qwen 모델로 게이트웨이 없이 묻고, 시도에 제공자·모델·글 판을 적는다 — 보류 설정도 넘긴다", async () => {
    const { state, fetcher } = endpoint();
    mocks.pending.mockResolvedValue([{ id: 7, slug: "app" }]);
    const { value } = await tick() as { value: unknown };
    expect(value).toEqual({ done: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.urls).toEqual([`${QWEN_URL}/chat/completions`]);
    expect(state.heads[0].has("authorization")).toBe(false);
    // 모델은 환경변수(some-other-model)가 아니라 바꿀 때 굳힌 감사 행의 것이다
    expect(JSON.parse(String(fetcher.mock.calls[0][1].body)).model).toBe(QWEN_MODEL);
    expect(recorded()).toEqual([expect.objectContaining({ itemId: 7, ok: true, provider: "qwen-direct", model: QWEN_MODEL,
      promptVersion: QWEN_V2_PROMPT_VERSION, outcome: expect.objectContaining({ decision: "reject", confidence: 1 }) })]);
    expect(mocks.record.mock.calls[0][2]).toEqual(DEFAULT_CRAWL_SETTINGS.auditHold);
  });

  it("새 후보가 기다려도 Qwen 으로 바꾼 감사는 양보하지 않는다 — 게이트웨이 자리를 쓰지 않는다", async () => {
    const { fetcher } = endpoint();
    mocks.candidates.mockResolvedValue([{ id: 1 }]);
    mocks.pending.mockResolvedValue([{ id: 7, slug: "app" }]);
    const ctx = context();
    await tick(ctx);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ctx.log).not.toHaveBeenCalledWith("product_audit.yielded", expect.anything());
    expect(mocks.candidates).not.toHaveBeenCalled();
  });

  it("바꾸지 않은 감사는 새 후보가 기다리면 지금처럼 양보한다", async () => {
    const { fetcher } = endpoint();
    mocks.campaign.mockResolvedValue({ ...switched, currentProvider: null, currentModel: null });
    mocks.candidates.mockResolvedValue([{ id: 1 }]);
    const ctx = context();
    await tick(ctx);
    expect(ctx.log).toHaveBeenCalledWith("product_audit.yielded", { campaign: 4 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
  });

  it("바꾸지 않은 감사는 지금처럼 게이트웨이로 묻는다 — Qwen 을 부르지 않는다", async () => {
    const { fetcher } = endpoint();
    mocks.campaign.mockResolvedValue({ ...switched, currentProvider: null, currentModel: null });
    mocks.pending.mockResolvedValue([]);
    mocks.finish.mockResolvedValue(false);
    await tick();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("주소를 고칠 수 없으면 묻지도 적지도 않고 잡을 실패로 남긴다", async () => {
    const { fetcher } = endpoint();
    vi.stubEnv("AUDIT_SECOND_OPINION_URL", "ftp://qwen.test/v1");
    const result = await tick() as { error: Error };
    expect(result.error.message).toBe("product_audit_reviewer_unavailable:qwen_not_configured");
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe("동시 호출과 틱 예산", () => {
  it("자리 둘(기본)이 틱이 끝날 때까지 잇달아 묻는다 — 3초 호출이면 한 틱에 34건, 틱 끝까지 15초가 안 남으면 새로 시작하지 않는다", async () => {
    const { state } = endpoint({ ms: 3_000 });
    const t0 = Date.now();
    await tick();
    expect(state.maxInFlight).toBe(2);
    expect(recorded().filter((call) => call.ok)).toHaveLength(34);
    // 틱 끝 = 65초. 새 호출은 50초(= 65 - 15)까지만
    expect(Math.max(...state.starts) - t0).toBeLessThanOrEqual(50_000);
    expect(state.aborted).toBe(0);
    expect([QWEN_CALL_TIMEOUT_MS, QWEN_MIN_START_MS]).toEqual([45_000, 15_000]);
    // 틱의 호출 시간·시간 초과 수를 남긴다
    const log = vi.mocked(lastContext!.log).mock.calls.find(([event]) => event === "product_audit.reviewed")?.[1];
    expect(log).toMatchObject({ reviewed: 34, timeouts: 0, cutoff: 0, latency: { count: 34, avgMs: 3_000, p90Ms: 3_000, maxMs: 3_000 } });
  });

  it("AUDIT_QWEN_CONCURRENCY 는 4 까지만 — 그보다 크게 적어도 넷만 동시에 띄운다", async () => {
    vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "9");
    const { state } = endpoint({ ms: 3_000 });
    await tick();
    expect(state.maxInFlight).toBe(4);
    expect(recorded()).toHaveLength(68);
    expect(mocks.pending).toHaveBeenCalledWith(4, 160);
  });

  it("틱 끝이 가까우면 줄인 제한 시간으로 부른다 — 끝에 걸리지 않은 답은 그대로 적는다", async () => {
    const { state, fetcher } = endpoint({ ms: 8_000 });
    const t0 = Date.now();
    await tick();
    // 자리마다 0·8·…·48초에 시작(48초에 남은 17초 ≥ 15초 — 제한 시간 15초로, 56초에는 9초라 시작하지 않는다)
    expect(state.starts).toHaveLength(14);
    expect(Math.max(...state.starts) - t0).toBeLessThanOrEqual(50_000);
    expect(state.aborted).toBe(0);
    expect(recorded()).toHaveLength(14);
    expect(recorded().every((call) => call.ok)).toBe(true);
    expect(qwenEndpointBackingOff()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(14);
    const timeouts = vi.mocked(reviewWithQwenDirect).mock.calls.map(([, options]) => options?.timeoutMs);
    expect(timeouts.slice(0, 2)).toEqual([45_000, 45_000]);
    expect(timeouts.slice(-2)).toEqual([15_000, 15_000]);
  });

  it("틱 끝까지 16초 남았으면 시작하고 제한 시간은 min(45초, 남은 시간 − 저장 여유)=14초 — 그 끝에 걸린 것은 아무것도 세지 않는다", async () => {
    // 첫 호출은 줄인 제한 시간(14초)에 제공자가 끊고, 둘째는 틱 끝(남은 시간 0)에 잡이 끊는다 — 어느 쪽이든 틱 끝 때문이다
    const { state } = endpoint({ ms: (call) => (call === 0 ? 13_900 : 20_000), respond: () => new DOMException("deadline", "TimeoutError") });
    const startedAt = Date.now();
    const result = await tick(context({ deadlineAt: startedAt + 16_000 }));
    expect(result).toEqual({ value: { done: false } });
    expect(state.starts).toHaveLength(2);
    expect(vi.mocked(reviewWithQwenDirect).mock.calls.map(([, options]) => options?.timeoutMs)).toEqual([14_000, 14_000]);
    // 서버 탈도 항목의 시도도 아니다 — 적지 않고 물러나지 않는다
    expect(recorded()).toHaveLength(0);
    expect(qwenEndpointBackingOff()).toBe(false);
    expect(qwenSoftFailures.streak).toBe(0);
    const log = vi.mocked(lastContext!.log).mock.calls.find(([event]) => event === "product_audit.reviewed")?.[1];
    expect(log).toMatchObject({ reviewed: 0, timeouts: 0, cutoff: 2 });
  });

  it("틱 끝까지 15초가 안 남으면 시작하지 않는다", async () => {
    const { fetcher } = endpoint({ ms: 3_000 });
    const startedAt = Date.now();
    expect(await tick(context({ deadlineAt: startedAt + 14_000 }))).toEqual({ value: { done: false } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("러너 예산이 먼저 끝나 끊긴 호출은 적지 않고 서버 탈로도 세지 않는다", async () => {
    const { state } = endpoint({ ms: 8_000 });
    const startedAt = Date.now();
    const result = await tick(context({ hasBudget: () => Date.now() - startedAt < 5_000 }));
    expect(result).toEqual({ value: { done: false } });
    expect(state.aborted).toBe(2);
    expect(recorded()).toHaveLength(0);
    expect(qwenEndpointBackingOff()).toBe(false);
  });

  it("입력을 만들다 실패한 항목은 그 항목의 실패로 적고 넘어간다 — 잡을 실패시키지 않고 다음 항목을 묻는다", async () => {
    endpoint({ ms: 3_000 });
    vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "1");
    mocks.input.mockImplementation(async (slug: string) => {
      if (slug === "p0") throw new Error("review_input_too_large");
      if (slug === "p1") throw new Error("Unexpected token < in JSON");
      return reviewInput();
    });
    expect(await tick()).toEqual({ value: { done: false } });
    expect(mocks.inputFailed.mock.calls.map(([itemId, code]) => [itemId, code])).toEqual([[100, "review_input_too_large"], [101, "input_error"]]);
    expect(recorded()[0]).toEqual(expect.objectContaining({ itemId: 102, ok: true }));
  });

  it("한 자리가 서버 탈을 만나면 같은 틱의 다른 자리도 바로 멈춘다 — 물러나기는 틱이 끝나기 전에 걸린다", async () => {
    const starts: number[] = [];
    let backingOffWhileOtherInFlight: boolean | null = null;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const call = starts.push(Date.now()) - 1;
      // 첫 호출은 0.1초 만에 503, 둘째 호출은 3초 걸려 답한다
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, call === 0 ? 100 : 3_000);
        init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      });
      if (call === 0) return new Response("{}", { status: 503 });
      if (call === 1) backingOffWhileOtherInFlight = qwenEndpointBackingOff();
      return new Response(body(JSON.stringify(outcome)), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await tick() as { error?: Error };
    expect(result.error?.message).toBe("product_audit_endpoint_error:qwen_http_503");
    // 둘째 자리는 띄운 호출의 답만 적고 새 호출을 시작하지 않는다
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(backingOffWhileOtherInFlight).toBe(true);
    expect(recorded().map((call) => [call.itemId, call.ok])).toEqual([[100, false], [101, true]]);
  });

  it("틱 도중 감사가 중단되면 새 호출을 시작하지 않는다(5초마다 다시 본다)", async () => {
    const { state } = endpoint({ ms: 3_000 });
    const t0 = Date.now();
    mocks.campaign.mockImplementation(async () => (Date.now() - t0 < 10_000 ? switched : null));
    await tick();
    expect(state.starts.length).toBeGreaterThan(0);
    expect(Math.max(...state.starts) - t0).toBeLessThan(15_000);
    expect(state.starts.length).toBeLessThan(12);
  });

  it("틱 도중 수집 스위치가 꺼지면 새 호출을 시작하지 않는다", async () => {
    const { state } = endpoint({ ms: 3_000 });
    const t0 = Date.now();
    mocks.settings.mockImplementation(async () => ({ ...DEFAULT_CRAWL_SETTINGS, enabled: Date.now() - t0 < 10_000, reviewConcurrency: 1 }));
    await tick();
    expect(Math.max(...state.starts) - t0).toBeLessThan(15_000);
  });

  it("동시 호출 수 읽기 — 없거나 잘못 적으면 2, 4 를 넘으면 4", () => {
    expect(qwenAuditConcurrency({})).toBe(2);
    expect(qwenAuditConcurrency({ AUDIT_QWEN_CONCURRENCY: "abc" })).toBe(2);
    expect(qwenAuditConcurrency({ AUDIT_QWEN_CONCURRENCY: "0" })).toBe(2);
    expect(qwenAuditConcurrency({ AUDIT_QWEN_CONCURRENCY: "1" })).toBe(1);
    expect(qwenAuditConcurrency({ AUDIT_QWEN_CONCURRENCY: "3" })).toBe(3);
    expect(qwenAuditConcurrency({ AUDIT_QWEN_CONCURRENCY: "16" })).toBe(4);
  });
});

describe("부르는 곳의 탈에서 물러나기", () => {
  /** 짧게 끝나는 틱(실패·물러나기) — 시계를 ms 만큼만 흘린다 */
  async function run(ms = 1_000) {
    const running = auditPublishedProducts(context()).then((value) => ({ value }), (error: Error) => ({ error }));
    await vi.advanceTimersByTimeAsync(ms);
    return running as Promise<{ value?: unknown; error?: Error }>;
  }

  it("닿지 않으면 그 틱의 새 호출을 멈추고 1분·2분… 묻지 않는다 — 닿지 않음은 항목의 시도로 세지 않고, 답을 받으면 처음부터", async () => {
    let down = true;
    const { fetcher } = endpoint({ ms: 100, respond: () => (down ? new TypeError("fetch failed") : new Response(body(JSON.stringify(outcome)))) });
    expect((await run()).error?.message).toBe("product_audit_endpoint_error:qwen_unreachable");
    // 두 자리가 함께 띄운 것까지만 — 그 뒤로는 시작하지 않는다
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorded()).toEqual([expect.objectContaining({ ok: false, error: "qwen_unreachable", counted: false }),
      expect.objectContaining({ ok: false, error: "qwen_unreachable", counted: false })]);

    // 1분 안에는 묻지 않고 실패로 남는다(운영센터에 보이게)
    expect((await run(10)).error?.message).toBe("product_audit_endpoint_backoff:qwen_unreachable");
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await run(10)).error?.message).toBe("product_audit_endpoint_backoff:qwen_unreachable");
    expect(fetcher).toHaveBeenCalledTimes(2);

    // 1분 뒤 다시 물어보고 또 닿지 않으면 2분
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await run()).error?.message).toBe("product_audit_endpoint_error:qwen_unreachable");
    expect(fetcher).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await run(10)).error?.message).toBe("product_audit_endpoint_backoff:qwen_unreachable");
    expect(fetcher).toHaveBeenCalledTimes(4);

    // 2분이 지나 살아나면 답을 적고 물러나기를 지운다 — 다음 틱은 바로 묻는다
    down = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await run(70_000)).toEqual({ value: { done: false } });
    const calls = fetcher.mock.calls.length;
    expect(calls).toBeGreaterThan(4);
    expect(await run(70_000)).toEqual({ value: { done: false } });
    expect(fetcher.mock.calls.length).toBeGreaterThan(calls);
  });

  it("물러나는 시간은 1분에서 두 배씩 15분까지", () => {
    expect([1, 2, 3, 4, 5, 9].map(qwenAuditBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
  });

  it("한 번의 진짜 시간 초과(45초를 다 썼다)는 그 항목의 시도로 세고 물러나지 않는다 — 잡도 실패로 남지 않고 다음 항목을 묻는다", async () => {
    // 첫 호출만 45초를 넘겨 제공자가 시간 초과로 끊는다(가짜는 45초에 TimeoutError 를 던진다)
    endpoint({ ms: (call) => (call === 0 ? 45_000 : 3_000), respond: (call) => (call === 0 ? new DOMException("deadline", "TimeoutError")
      : new Response(body(JSON.stringify(outcome)))) });
    vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "1");
    expect(await run(70_000)).toEqual({ value: { done: false } });
    expect(recorded()[0]).toEqual(expect.objectContaining({ itemId: 100, ok: false, error: "qwen_timeout", counted: true }));
    expect(recorded().slice(1).every((call) => call.ok)).toBe(true);
    expect(recorded().length).toBeGreaterThan(1);
    expect(qwenEndpointBackingOff()).toBe(false);
    // 그 뒤 답을 받아 붐빔 연속은 처음부터
    expect(qwenSoftFailures.streak).toBe(0);
  });

  it("진짜 시간 초과가 성공 없이 세 번 잇달면 서버 탈이다 — 모두 물러나고 잡을 실패로 남긴다", async () => {
    endpoint({ ms: 45_000, respond: () => new DOMException("deadline", "TimeoutError") });
    vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "3");
    expect((await run(70_000)).error?.message).toBe("product_audit_endpoint_error:qwen_timeout");
    expect(recorded().map((call) => [call.error, call.counted])).toEqual([["qwen_timeout", true], ["qwen_timeout", true], ["qwen_timeout", true]]);
    expect(qwenEndpointBackingOff()).toBe(true);
    expect(qwenEndpointBackoff).toMatchObject({ failures: 1, lastError: "qwen_timeout" });
  });

  it("멀쩡하던 중의 5xx 는 그 항목의 시도로 세고, 이미 탈 난 동안의 5xx 는 세지 않는다", async () => {
    const { fetcher } = endpoint({ ms: 100, respond: () => new Response("{}", { status: 503 }) });
    vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "1");
    expect((await run()).error?.message).toBe("product_audit_endpoint_error:qwen_http_503");
    expect(recorded()).toEqual([expect.objectContaining({ itemId: 100, error: "qwen_http_503", counted: true })]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await run()).error?.message).toBe("product_audit_endpoint_error:qwen_http_503");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorded()[1]).toEqual(expect.objectContaining({ error: "qwen_http_503", counted: false }));
  });

  it("형식이 틀린 답은 그 항목의 실패로 세고 다음 것으로 넘어간다 — 물러나지 않는다", async () => {
    endpoint({ ms: 3_000, respond: (call) => new Response(body(call === 0 ? "not json at all" : JSON.stringify(outcome))) });
    vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "1");
    expect(await run(70_000)).toEqual({ value: { done: false } });
    expect(recorded()[0]).toEqual(expect.objectContaining({ itemId: 100, ok: false, error: "qwen_invalid_json", counted: true }));
    expect(recorded().slice(1).every((call) => call.ok)).toBe(true);
    expect(recorded().length).toBeGreaterThan(10);
  });
});

describe("틱의 호출 시간", () => {
  it("수·평균·p90·최대를 ms 로 — 없으면 비운다", () => {
    expect(latencyStats([])).toEqual({ count: 0, avgMs: null, p90Ms: null, maxMs: null });
    expect(latencyStats([12_000, 2_500, 19_800, 11_000, 9_000, 10_000, 13_000, 14_000, 15_000, 16_000]))
      .toEqual({ count: 10, avgMs: 12_230, p90Ms: 16_000, maxMs: 19_800 });
  });
});
