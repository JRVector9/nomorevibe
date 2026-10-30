import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Installs setModelRoutePolicyOverlay(() => runtimeSettings().routes), the path a worker process uses.
import "@/lib/llm/serving-contract-store";
import { DEFAULT_RUNTIME_SETTINGS } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings, setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { REVIEW_GATEWAY_LADDER, reviewGatewayLadder } from "@/lib/llm/deadline-ladder";
import { REVIEW_GATEWAY_TIMEOUT_MS, reviewGatewayTimeoutMs } from "@/lib/crawl/agent-review-gateway";
import { REVIEW_CLI_TIMEOUT_MS, reviewCliMaxOutputTokens, reviewCliTimeoutMs } from "@/lib/crawl/agent-review";
import { GROK_REVIEW_TIMEOUT_MS, grokReviewTimeoutMs } from "@/lib/crawl/agent-review-grok";
import { secondReviewTransportTimeoutMs } from "@/lib/crawl/second-review-transport";
import { DEEPSEEK_REVIEW_TIMEOUT_MS, deepseekReviewTimeoutMs } from "@/lib/crawl/deepseek-review-policy";
import { grokSessionTimeoutMs } from "@/lib/crawl/jobs/grok-session";
import { QWEN_CALL_TIMEOUT_MS, qwenCallTimeoutMs } from "@/lib/crawl/jobs/product-audit";
import { QWEN_AUTO_CALL_TIMEOUT_MS, qwenAutoCallTimeoutMs } from "@/lib/crawl/audit-second-opinion-auto";
import { heldQwenCallTimeoutMs } from "@/lib/crawl/held-qwen-retry";
import { SPLIT_CONFIRM_TIMEOUT_MS, splitConfirmTimeoutMs } from "@/lib/crawl/gate-split-confirm";
import { screenModelTimeoutMs } from "@/lib/screen-review/job";
import { packBatch, reasonTranslateKnobs } from "@/lib/crawl/jobs/translate-reasons";
import { packTaglineBatch } from "@/lib/jobs/products/korean-tagline";
import { SLOW_CALL_MS } from "@/lib/jobs/products/search-profile";
import { packProductTranslationBatch, productTranslationPolicy, PRODUCT_TRANSLATION_BATCH_CHARS,
  PRODUCT_TRANSLATION_MAX_ATTEMPTS } from "@/lib/domain/products/translation-policy";
import { TICK_WRITE_MARGIN_MS, tickRemaining } from "@/lib/jobs/tick-deadline";

/**
 * 실시간 한도 D4 의 지킴 테스트 — 모듈이 등록부·번역·묶음 값을 import 시점에 붙들지 않는다.
 *
 * 정규식으로 소스를 훑지 않는다. 대신 각 모듈이 실제로 쓰는 읽기 함수를 기본값으로 한 번 부른 뒤 runtime_settings 를 바꾸고(setRuntimeSettingsForTest)
 * 다시 불러, 두 번째 값이 바뀐 판을 따르는지 본다. 어떤 모듈이 `const X = modelTimeoutMs(...)` 처럼 로드 시점에 값을 잡아 그것을 쓰면 두 번째 호출이
 * 옛 값을 돌려줘 여기서 빨갛게 뜬다. 로드 시점 상수(REVIEW_GATEWAY_TIMEOUT_MS 등)는 테스트·문서용으로 남아 있고 바뀌지 않는다는 것도 함께 고정한다.
 */

/** 기본값보다 낮은 값만 쓴다 — 올리는 쪽은 모델 자체 상한(min)에 걸릴 수 있다 */
const CHANGED = {
  version: 1,
  routes: {
    deadlines: { "review-gateway": { engineMs: 20_000, relayMs: null, gatewayMs: 30_000, clientMs: 35_000 } },
    limits: { "review-cli": { timeoutMs: 12_000, maxTokens: 900 }, "human-review": { timeoutMs: 40_000 } },
    timeouts: { "grok-review": 70_000, "grok-session": 30_000, "product-audit": 30_000, "audit-second-opinion": 25_000,
      "held-review-retry": 9_000, "split-confirm": 22_000, "screen-review": 50_000 },
  },
  translation: { product: { batchChars: 20_000, maxAttempts: 6, demandLimit: 10 } },
  jobs: { "reason-translate": { batch: 2, batchChars: 100, soloAttempts: 2 }, "product-tagline-ko": { batch: 3, batchChars: 1_000 },
    "product-search-profile": { slowCallMs: 9_000 } },
  budgets: { "reason-translate": 90_000 },
};

beforeEach(() => { vi.stubEnv("MODEL_REGISTRY_CONFIG", ""); setRuntimeSettingsForTest(null); });
afterEach(() => { setRuntimeSettingsForTest(null); vi.unstubAllEnvs(); });

/** 기본값 → 바뀐 판 → 기본값: 세 번 읽어 모듈이 어느 쪽도 붙들지 않는지 본다 */
function expectLive<T>(read: () => T, atDefault: T, changed: T) {
  expect(read()).toEqual(atDefault);
  setRuntimeSettingsForTest(CHANGED);
  expect(read()).toEqual(changed);
  setRuntimeSettingsForTest(null);
  expect(read()).toEqual(atDefault);
}

describe("registry route limits are read per call (not captured at import)", () => {
  it("review-gateway client deadline: gateway, item lifecycle ladder and second-review transport", () => {
    expectLive(() => reviewGatewayTimeoutMs(), 60_000, 35_000);
    expectLive(() => reviewGatewayLadder().clientMs, 60_000, 35_000);
    expectLive(() => secondReviewTransportTimeoutMs("abcllm"), 60_000, 35_000);
    expectLive(() => secondReviewTransportTimeoutMs("local-direct"), 60_000, 35_000);
  });
  it("review-cli timeout and output tokens: CLI reviewer, CLI call preparation, second-review transport", () => {
    expectLive(() => reviewCliTimeoutMs(), 20_000, 12_000);
    expectLive(() => reviewCliMaxOutputTokens(), 2_000, 900);
    expectLive(() => secondReviewTransportTimeoutMs("claude-cli"), 20_000, 12_000);
  });
  it("grok review and session, DeepSeek human review", () => {
    expectLive(() => grokReviewTimeoutMs(), 90_000, 70_000);
    expectLive(() => secondReviewTransportTimeoutMs("grok-cli"), 90_000, 70_000);
    expectLive(() => grokSessionTimeoutMs(), 60_000, 30_000);
    expectLive(() => deepseekReviewTimeoutMs(), 60_000, 40_000);
  });
  it("Qwen direct audit, second opinion, held retry, split confirm and screen review ceilings", () => {
    expectLive(() => qwenCallTimeoutMs(), 45_000, 30_000);
    expectLive(() => qwenAutoCallTimeoutMs(), 45_000, 25_000);
    expectLive(() => heldQwenCallTimeoutMs(), 15_000, 9_000);
    expectLive(() => splitConfirmTimeoutMs(), 45_000, 22_000);
    expectLive(() => screenModelTimeoutMs(), 90_000, 50_000);
  });
  it("load-time constants stay as documented defaults and do not move with the saved document", () => {
    setRuntimeSettingsForTest(CHANGED);
    expect([REVIEW_GATEWAY_TIMEOUT_MS, REVIEW_GATEWAY_LADDER.clientMs, REVIEW_CLI_TIMEOUT_MS, GROK_REVIEW_TIMEOUT_MS, DEEPSEEK_REVIEW_TIMEOUT_MS,
      QWEN_CALL_TIMEOUT_MS, QWEN_AUTO_CALL_TIMEOUT_MS, SPLIT_CONFIRM_TIMEOUT_MS]).toEqual([60_000, 60_000, 20_000, 90_000, 60_000, 45_000, 45_000, 45_000]);
    expect([SLOW_CALL_MS, PRODUCT_TRANSLATION_BATCH_CHARS, PRODUCT_TRANSLATION_MAX_ATTEMPTS]).toEqual([20_000, 8_000, 4]);
    // and the live reads disagree with them while the document is changed
    expect(reviewGatewayTimeoutMs()).not.toBe(REVIEW_GATEWAY_TIMEOUT_MS);
    expect(reviewCliTimeoutMs()).not.toBe(REVIEW_CLI_TIMEOUT_MS);
  });
});

describe("job knobs and translation policy are read per call", () => {
  const reason = (hash: string, chars: number, attempts = 0) => ({ hash, body: "r".repeat(chars), attempts });
  it("reason-translate packing follows jobs.reason-translate (batch, batchChars, soloAttempts)", () => {
    expectLive(() => reasonTranslateKnobs(), { batch: 4, batchChars: 1_600, minCallMs: 30_000, soloAttempts: 3 },
      { batch: 2, batchChars: 100, minCallMs: 30_000, soloAttempts: 2 });
    // 50자 다섯 건: 기본은 4건(batch 4 · 1,600자 안), 바뀐 판은 2건(batch 2 · 100자)
    const items = [reason("a", 50), reason("b", 50), reason("c", 50), reason("d", 50), reason("e", 50)];
    expectLive(() => packBatch(items).map(item => item.hash), ["a", "b", "c", "d"], ["a", "b"]);
    // 시도 2회인 글은 기본(soloAttempts 3)에서는 묶이고, 바뀐 판(2)에서는 혼자 간다
    expectLive(() => packBatch([reason("x", 50, 2), reason("y", 50)]).map(item => item.hash), ["x", "y"], ["x"]);
    // 부르는 쪽이 손잡이를 명시하면 그것을 쓴다(틱이 한 번 읽은 판으로 묶는다)
    expect(packBatch(items, { batch: 1, batchChars: 1_600, soloAttempts: 3 }).map(item => item.hash)).toEqual(["a"]);
  });
  it("Korean tagline packing follows jobs.product-tagline-ko (batch, legacy batchChars)", () => {
    const task = (productId: number, chars: number) => ({ productId, name: `p${productId}`, tagline: "x".repeat(chars), repoUrl: null, attempts: 0 });
    const tasks = Array.from({ length: 12 }, (_, i) => task(i, 300));
    // 기본: 8건·3,600자 → 8건; 바뀐 판: 3건·1,000자 → 3건(900자)
    expectLive(() => packTaglineBatch(tasks).length, 8, 3);
    // native 경로의 1,200자는 인자로 고정 — 글자 수는 그대로, 건수(batch)만 판을 따른다
    expectLive(() => packTaglineBatch(tasks, 1_200).length, 4, 3);
  });
  it("product translation packing and policy follow translation.product", () => {
    const task = (id: number, chars: number) => ({ source: { id, name: `p${id}`, tagline: "t", description: "d".repeat(chars) }, field: "description" as const });
    const tasks = [task(1, 3_000), task(2, 3_000), task(3, 3_000), task(4, 3_000)];
    expectLive(() => packProductTranslationBatch(tasks).map(t => t.source.id), [1, 2], [1, 2, 3, 4]);
    expectLive(() => [productTranslationPolicy().maxAttempts, productTranslationPolicy().demandLimit], [4, 80], [6, 10]);
    expectLive(() => productTranslationPolicy().batchChars, 8_000, 20_000);
  });
  it("search-profile slow-call threshold is a knob of the current document", () => {
    expectLive(() => runtimeSettings().jobs["product-search-profile"]?.slowCallMs, 20_000, 9_000);
  });
});

describe("tick remaining time comes from the runner's deadlineAt, not a job-local TICK_MS", () => {
  const now = 1_000_000;
  it("with deadlineAt the window is deadlineAt − write margin, whatever the document says", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const remaining = tickRemaining({ deadlineAt: now + 55_000 }, "reason-translate", now);
    expect(remaining()).toBe(55_000 - TICK_WRITE_MARGIN_MS);
    setRuntimeSettingsForTest(CHANGED);
    expect(remaining()).toBe(54_000);
    expect(tickRemaining({ deadlineAt: now + 55_000 }, "reason-translate", now)()).toBe(54_000);
  });
  it("without deadlineAt (direct callers, tests) the job's effective budget stands in — and follows budgets.<job>", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    // 예산 줄이 있는 잡은 그 예산(55초), 예산 줄이 없는 crawl-tagline 은 runner 기본 25초 — 예전 TICK_MS 54초는 실제 예산이 아니었다
    expectLive(() => tickRemaining({}, "reason-translate", now)(), 54_000, 89_000);
    expect(tickRemaining({}, "crawl-tagline", now)()).toBe(DEFAULT_RUNTIME_SETTINGS.budgets["crawl-tagline"] === undefined ? 24_000 : -1);
    expect(tickRemaining({}, "product-search-verify", now)()).toBe(109_000);
    expect(tickRemaining({}, "product-intro-check", now)()).toBe(109_000);
  });
});
