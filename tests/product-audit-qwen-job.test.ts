import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { auditPublishedProducts, qwenAuditBackoffMs, qwenAuditConcurrency, resetQwenAuditBackoff } from "@/lib/crawl/jobs/product-audit";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";

/**
 * 남은 감사 모델 바꾸기(0112) 뒤의 감사 틱 — Qwen 직접 심사(qwen-direct-review.ts)는 진짜로 돌고 HTTP 끝(gpu3090 vLLM)만 가짜다.
 * 감사 행·일감·기록은 이 파일이 흉내 낸다(DB 를 여는 쪽은 tests/integration/product-audit-qwen.test.ts).
 */
const mocks = vi.hoisted(() => ({ campaign: vi.fn(), settings: vi.fn(), candidates: vi.fn(), pending: vi.fn(),
  input: vi.fn(), record: vi.fn(), noSource: vi.fn(), finish: vi.fn(), gateway: vi.fn() }));
// Qwen-v2 두 번째 의견 단계(감사 잡 틱 안에서 나란히 돈다)는 tests/integration/audit-second-opinion-auto.test.ts 가 본다 — 여기 가짜 서버의 호출 수는 감사 묻기만
vi.mock("@/lib/crawl/audit-second-opinion-auto", () => ({ runQwenSecondOpinions: async () => null }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ listReviewCandidates: mocks.candidates }));
vi.mock("@/lib/crawl/product-audit-hold", () => ({ sweepAuditHolds: async () => 0 }));
vi.mock("@/lib/crawl/product-audit", () => ({ runningAuditCampaign: mocks.campaign, pendingAuditItems: mocks.pending,
  loadAuditInput: mocks.input, recordAuditResult: mocks.record, markAuditNoSource: mocks.noSource, finishAuditCampaign: mocks.finish }));
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

/** 가짜 vLLM — 부를 때마다 ms 만큼 걸린다. 몇 개가 동시에 떠 있었는지, 언제 시작했는지 센다. 끊으면 AbortError */
function endpoint(options: { ms?: number; respond?: (call: number) => Response | Error } = {}) {
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
        const timer = setTimeout(resolve, options.ms ?? 3_000);
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

const context = (over: Partial<JobContext<null>> = {}): JobContext<null> => {
  const startedAt = Date.now();
  return { cursor: null, save: vi.fn(), hasBudget: () => Date.now() - startedAt < 70_000, deadlineAt: startedAt + 70_000, log: vi.fn(),
    lease: { name: "product-audit", token: "owned", requestedVersion: 1 }, ...over };
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
  it("자리 둘(기본)이 틱이 끝날 때까지 잇달아 묻는다 — 3초 호출이면 한 틱에 40건, 남은 시간이 6초 아래면 새로 시작하지 않는다", async () => {
    const { state } = endpoint({ ms: 3_000 });
    const t0 = Date.now();
    await tick();
    expect(state.maxInFlight).toBe(2);
    expect(recorded().filter((call) => call.ok)).toHaveLength(40);
    // 틱 끝 = 65초 - 저장 여유 2초 = 63초. 새 호출은 57초까지만
    expect(Math.max(...state.starts) - t0).toBeLessThanOrEqual(57_000);
    expect(state.aborted).toBe(0);
  });

  it("AUDIT_QWEN_CONCURRENCY 는 4 까지만 — 그보다 크게 적어도 넷만 동시에 띄운다", async () => {
    vi.stubEnv("AUDIT_QWEN_CONCURRENCY", "9");
    const { state } = endpoint({ ms: 3_000 });
    await tick();
    expect(state.maxInFlight).toBe(4);
    expect(recorded()).toHaveLength(80);
    expect(mocks.pending).toHaveBeenCalledWith(4, 160);
  });

  it("틱 끝에 걸린 호출은 끊고 적지 않는다 — 시도를 쓰지 않는다", async () => {
    const { state } = endpoint({ ms: 8_000 });
    await tick();
    // 자리마다 0·8·…·56초에 시작(56초에 남은 7초 ≥ 6초), 56초 것은 64초에 끝나 63초 끝에 걸린다
    expect(state.starts).toHaveLength(16);
    expect(state.aborted).toBe(2);
    expect(recorded()).toHaveLength(14);
    expect(recorded().every((call) => call.ok)).toBe(true);
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
