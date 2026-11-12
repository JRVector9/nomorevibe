import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/tasks/execution-actions", () => ({ saveTaskExecutionAction: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/tasks/actions", () => ({ saveAiTaskRanksAction: vi.fn() }));

import { TaskExecutionForm } from "@/app/(operator)/admin/models/tasks/TaskExecutionForm";
import { PoolHelpContent } from "@/app/(operator)/admin/models/tasks/PoolHelp";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import type { AiConnectionView, AiRankOption } from "@/lib/operations/admin-ai-tasks";
import { buildPoolHelp, hasFinalConsonant, objectParticle, overBoundWarning, poolBaseText, poolCapsText, poolHelpWarnings, TWIN_WARNING,
  type PoolHelpContext, type PoolHelpDevice } from "@/lib/operations/pool-help";
import { poolHelpBases, poolHelpDevicesFromRows } from "@/lib/operations/pool-help-read";
import { resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { PRODUCT_TRANSLATION_SELECTION_ROUNDS } from "@/lib/jobs/products/translation-rounds";

vi.mock("server-only", () => ({}));

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

/** 운영과 같은 모양의 연결 — 이름 하나(label) · 장비 id · 서버 모델 */
function connection(id: string, label: string, deviceId: string, models: string[], capacitySlots = 2): AiConnectionView {
  return { id, label, kind: "api", baseUrl: null, host: null, hasKey: true, cliTool: null, cliModels: [], models: models.map(model => ({ id: model, maxModelLen: null })),
    modelsReadAt: null, modelsError: null, deviceId, capacitySlots, contextTokens: null, enabled: true, version: 1, note: null, updatedBy: "jr",
    updatedAt: "2026-11-12T00:00:00.000Z", cliVersion: null } as unknown as AiConnectionView;
}
const GPT = connection("11111111-1111-4111-8111-111111111111", "m3-gpt-oss", "m3-mlx", ["gpt-oss-120b"]);
const GEMMA = connection("22222222-2222-4222-8222-222222222222", "m1-gemma", "m1-qwen", ["m1-gemma"]);
const QWEN = connection("33333333-3333-4333-8333-333333333333", "gpu3090-qwen", "gpu3090-qwen", ["qwen3.8-flash-next"], 5);
const DEEPSEEK = connection("44444444-4444-4444-8444-444444444444", "m3-deepseek", "m3-mlx", ["deepseek-v4.1-flash-1017"], 1);
const CONNECTIONS = [GPT, GEMMA, QWEN, DEEPSEEK];
/** model_capacity_devices 의 jsonb 그대로(max_slots) — 읽기 함수가 바꾸는 모양까지 본다 */
const DEVICES: PoolHelpDevice[] = poolHelpDevicesFromRows([
  { deviceId: "m3-mlx", limitSlots: "3", enabled: true, modelLimits: [{ model: "gpt-oss-120b", max_slots: 2, engine_max: 4 }, { model: "deepseek-v4.1-flash-1017", max_slots: 1 }] },
  { deviceId: "m1-qwen", limitSlots: 2, enabled: true, modelLimits: [] },
  { deviceId: "gpu3090-qwen", limitSlots: 5, enabled: true, modelLimits: null },
]);
const settings = resolveRuntimeSettings({ routes: { limits: { "product-translate": { maxTokens: 4096, concurrency: 2 } } }, jobs: { "second-review": { consumerConcurrency: 3 } } }).settings;
const CONTEXT: PoolHelpContext = { devices: DEVICES, bases: poolHelpBases(settings, 2) };
const gpt = { provider: GPT.id, model: "gpt-oss-120b" }, gemma = { provider: GEMMA.id, model: "m1-gemma" }, qwen = { provider: QWEN.id, model: "qwen3.8-flash-next" };
const help = (members: Parameters<typeof buildPoolHelp>[0]["members"], slots: string[], task = "product-translate", context: PoolHelpContext | null = CONTEXT) =>
  buildPoolHelp({ task, slot: 1, taskLabel: task === "product-translate" ? "공개 번역" : task === "reason-translate" ? "사유 번역" : task === "first-review" ? "1차 AI 검수" : "2차 AI 검수",
    members, slots, connections: CONNECTIONS, context });

describe("「동시에」 도움말 — 권장 칸 수(모델이 동시에 받는 수 — 서버 한도 · 그 서버의 모델 상한 중 좁은 쪽)", () => {
  it("근거는 모델의 한도로만 말한다(서버 이름·장비를 적지 않는다)", () => {
    const view = help([gpt, gemma], ["", ""]);
    expect(view.rows.map(row => [row.order, row.name, row.recommended, row.bound, row.reason])).toEqual([
      [1, "m3-gpt-oss", 2, "model", "m3-gpt-oss는 동시에 2개까지"],
      [2, "m1-gemma", 2, "device", "m1-gemma는 동시에 2개까지"],
    ]);
    expect(view.example).toBe("2개를 동시에 쓰는 방법: m3-gpt-oss를 한 줄만 넣고 「칸 수」에 2를 적으면 됩니다.");
    expect(help([qwen], [""]).rows[0]).toMatchObject({ recommended: 5, bound: "device", reason: "gpu3090-qwen은 동시에 5개까지" });
    const html = renderToStaticMarkup(<PoolHelpContent view={view} />);
    for (const word of ["m3-mlx", "m1-qwen", "장비"]) expect(text(html)).not.toContain(word);
    // 서버 한도가 칸 수 상한(8)보다 크면 칸 수는 8까지
    const big = poolHelpDevicesFromRows([{ deviceId: "gpu3090-qwen", limitSlots: 10, enabled: true, modelLimits: [] }]);
    expect(help([qwen], [""], "product-translate", { devices: big, bases: CONTEXT.bases }).rows[0])
      .toMatchObject({ recommended: 8, bound: "slots-max", reason: "gpu3090-qwen은 동시에 10개까지 · 칸 수는 8까지" });
  });

  it("같은 서버의 모델 한도를 합치면 서버 전체를 넘을 때만 한 문장(지금 M3 는 1 + 2 = 3 이라 없음)", () => {
    expect(help([gpt], [""]).shared).toEqual([]);
    const tight = poolHelpDevicesFromRows([{ deviceId: "m3-mlx", limitSlots: "3", enabled: true,
      modelLimits: [{ model: "gpt-oss-120b", max_slots: 2 }, { model: "deepseek-v4.1-flash-1017", max_slots: 2 }] }]);
    const view = help([gpt], [""], "product-translate", { devices: tight, bases: CONTEXT.bases });
    expect(view.shared).toEqual(["m3-deepseek와 함께 쓰는 서버라 둘을 합쳐 3개까지입니다."]);
    expect(text(renderToStaticMarkup(<PoolHelpContent view={view} />))).toContain("m3-deepseek와 함께 쓰는 서버라 둘을 합쳐 3개까지입니다.");
  });

  it("장부 모델 글자 「모델@연결 앞 8자」로 적힌 상한도 맞춘다", () => {
    const devices = poolHelpDevicesFromRows([{ deviceId: "m1-qwen", limitSlots: 4, enabled: true, modelLimits: [{ model: `m1-gemma@${GEMMA.id.slice(0, 8)}`, max_slots: 1 }] }]);
    expect(help([gemma], [""], "product-translate", { devices, bases: CONTEXT.bases }).rows[0]).toMatchObject({ recommended: 1, bound: "model" });
  });

  it("장비를 못 읽었으면 지어내지 않는다", () => {
    const view = help([gpt], [""], "product-translate", { devices: null, bases: CONTEXT.bases });
    expect(view.rows[0]).toMatchObject({ recommended: null, bound: "unknown", reason: "한도를 읽지 못했습니다" });
    expect(view.devicesRead).toBe(false);
    expect(view.example).toBeNull();
  });
});

describe("「동시에」 도움말 — 세 경우(같은 모델 두 줄 · 칸 수 없음 · 섞인 칸 수)", () => {
  it("같은 모델 두 줄 — 둘째 줄 옆에 경고, 도움말 표에도 「1번과 같은 모델」", () => {
    const view = help([gemma, gemma], ["", ""]);
    expect(view.rows[1]).toMatchObject({ twinOf: 1, warnings: [TWIN_WARNING] });
    expect(poolHelpWarnings(view)).toEqual([[], [TWIN_WARNING], [], []]);
    const plain = text(renderToStaticMarkup(<PoolHelpContent view={view} />));
    expect(plain).toContain("같은 모델을 두 줄 넣어도 동시에 두 배로 부르지 않습니다 — 고를 차례만 두 배가 되고 그 모델이 동시에 받는 수는 그대로입니다(같은 모델 두 줄은 함께 쉽니다).");
    expect(plain).toContain("m1-gemma · 1번과 같은 모델");
    expect(plain).toContain("2개를 동시에 쓰는 방법: m1-gemma를 한 줄만 넣고 「칸 수」에 2를 적으면 됩니다.");
  });

  it("칸 수 없음 — 이 작업 전체가 「공개 번역 동시 호출」(지금 값)을 모델끼리 나눠 쓴다", () => {
    const view = help([gpt, gemma], ["", ""]);
    expect(view.capsState).toBe("none");
    expect(view.lanes).toBeNull();
    expect(poolBaseText(view)).toBe("칸 수를 비우면 공개 번역 전체 동시 처리 수가 「공개 번역 동시 호출」 한도(지금 2)를 따릅니다 — 모델이 몇 개든 합쳐서 2개입니다.");
    const plain = text(renderToStaticMarkup(<PoolHelpContent view={view} />));
    expect(plain).toContain("모든 줄에 칸 수를 적으면 그 합(최대 16)이 공개 번역의 동시 처리 수가 되고");
    expect(plain).toContain("일부 줄에만 적으면 저장을 거절합니다.");
    expect(plain).toContain("순서 모델 칸 수 근거 1 m3-gpt-oss 2 m3-gpt-oss는 동시에 2개까지 2 m1-gemma 2 m1-gemma는 동시에 2개까지");
    expect(plain).toContain("같은 모델을 다른 단계도 쓰면 바쁠 때 이보다 적게 받을 수 있습니다.");
    expect(plain).toContain("예비: 켜면 구성원이 모두 차거나 쉴 때 순위대로(1·2·3순위)가 넘겨받습니다.");
    // 2026-11-12 검수 §4: 예비를 끈 칸 수 묶음은 장부 줄에 서지 않는다(실행 TextTaskRanks.runPool 의 idle — 다음 틱에 다시 고른다)
    expect(plain).toContain("칸 수를 적었으면 장부 줄에 서지 않고 다음 틱에 다시 고르고");
  });

  it("섞인 칸 수 — 저장 거절을 알리고, 권장을 넘는 칸 수는 줄 옆에 경고", () => {
    const view = help([gpt, gemma], ["3", ""]);
    expect(view.capsState).toBe("partial");
    expect(view.rows[0].warnings).toEqual(["이 모델은 동시에 2개까지라 넘는 칸은 쓰이지 않습니다"]);
    expect(text(renderToStaticMarkup(<PoolHelpContent view={view} />))).toContain("지금 일부 줄에만 칸 수가 있어 저장되지 않습니다");
  });

  it("모두 적음 — 칸 수 합이 동시 처리 수(실행 쪽 aiTaskPoolCappedLanes 와 같은 값)", () => {
    const view = help([gpt, gemma], ["2", "2"]);
    expect(view).toMatchObject({ capsState: "all", lanes: 4 });
    expect(poolCapsText(view)).toContain("(지금 적은 대로면 4개)");
    expect(view.rows.every(row => row.warnings.length === 0)).toBe(true);
  });
});

describe("「동시에」 도움말 — 작업마다 칸 수를 비웠을 때(실행 쪽 그대로)", () => {
  it("읽은 값 — 실시간 한도 routes.limits.<경로>.concurrency · 2차 소비자 · 1차 심사 동시 수", () => {
    expect(CONTEXT.bases["product-translate"]).toEqual({ kind: "route", label: "공개 번역 동시 호출", path: "routes.limits.product-translate.concurrency", value: 2,
      roundsMax: PRODUCT_TRANSLATION_SELECTION_ROUNDS });
    expect(CONTEXT.bases["reason-translate"]).toEqual({ kind: "one" });
    expect(CONTEXT.bases["first-review"]).toEqual({ kind: "review", value: 2, max: 16 });
    expect(CONTEXT.bases["second-review"]).toEqual({ kind: "consumer", path: "jobs.second-review.consumerConcurrency", value: 3 });
    expect(CONTEXT.bases["product-search-verify"]).toMatchObject({ kind: "route", label: "키워드 검수 동시 호출" });
    // 칸 수를 따르지 않는 작업(분산만)은 없다
    expect(CONTEXT.bases["publish-classify"]).toBeUndefined();
    expect(poolHelpBases(null, null)["product-translate"]).toMatchObject({ value: null });
  });

  it("공개 번역은 한 틱 고르기 상한(8)에서 자르고, 사유 번역은 한 줄, 1·2차는 칸 수 합이 아니다", () => {
    const wide = { devices: DEVICES, bases: poolHelpBases(resolveRuntimeSettings({ routes: { limits: { "product-translate": { maxTokens: 4096, concurrency: 12 } } } }).settings, 2) };
    expect(poolBaseText(help([gpt], [""], "product-translate", wide))).toContain("다만 한 틱에 고르는 차례가 8번까지라 8개에서 자릅니다.");
    expect(poolBaseText(help([gpt], [""], "reason-translate"))).toBe("칸 수를 비우면 사유 번역은 한 줄로 차례차례(동시 1개) 처리합니다 — 모델이 몇 개든 합쳐서 1개입니다.");
    const first = help([gpt], [""], "first-review");
    expect(poolBaseText(first)).toContain("1차 심사는 칸 수와 상관없이 한 틱에 「심사 동시 수」(수집·판정 설정, 지금 2, 16에서 자름)만큼 후보를 함께 봅니다.");
    expect(poolCapsText(first)).toBe("칸 수는 모든 줄에 적거나 모두 비워야 저장됩니다(일부만 적으면 저장을 거절합니다).");
    expect(poolBaseText(help([gpt], [""], "second-review"))).toContain("「2차 심사 소비자」, 지금 3");
    // 칸 수를 따르지 않는 작업 — 도움말은 그렇게만 적는다
    expect(text(renderToStaticMarkup(<PoolHelpContent view={help([gpt], [""], "publish-classify")} />))).toContain("이 작업은 아직 모델별 칸 수·예비를 따르지 않습니다.");
  });
});

describe("조사 — 이름·숫자에 맞는 을/를", () => {
  it.each([["m1-gemma", "를"], ["gpt-oss", "를"], ["qwen", "을"], ["사유 번역", "을"], ["공개 번역(1)", "을"], ["2", "를"], ["3", "을"], ["8", "을"], ["5", "를"]])("%s → %s",
    (word, particle) => expect(objectParticle(word)).toBe(particle));
  it("받침", () => { expect(hasFinalConsonant("모델")).toBe(true); expect(hasFinalConsonant("소스")).toBe(false); expect(overBoundWarning(3)).toBe("이 모델은 동시에 3개까지라 넘는 칸은 쓰이지 않습니다"); });
});

describe("작업 배정 실행 방식 폼 — 도움말 단추 둘과 줄 옆 경고", () => {
  const view: AiTaskExecutionAdminView = { task: "product-translate", slot: 1, mode: "workload_pool", revision: 7, updatedAt: "2026-11-12T00:00:00.000Z", reserveRanks: true,
    members: [GEMMA, GEMMA].map((row, index) => ({ memberId: `00000000-0000-4000-8000-00000000000${index}`, position: index + 1, connectionId: row.id, model: "m1-gemma", options: {},
      canonicalModel: "m1-gemma", deviceId: row.deviceId, engineKey: "e".repeat(64), maxSlots: null })) };
  const options: AiRankOption[] = CONNECTIONS.flatMap(row => (row.models ?? []).map(model => ({ provider: row.id, model: model.id, label: row.label, group: row.label, text: row.label,
    reasoningEfforts: [] })));
  const html = renderToStaticMarkup(<TaskExecutionForm view={view} label="공개 번역" options={options} connections={CONNECTIONS} help={CONTEXT} />);
  const plain = text(html);

  it("「동시에」 고르기 옆과 「칸 수」 옆에 도움말 단추 — 누르기·올리기·포커스로 여는 popover", () => {
    expect(html.match(/class="cs-help"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="「동시에」 설명"');
    expect(html).toContain('aria-label="칸 수 설명"');
    expect(html.match(/popover="manual"/g)).toHaveLength(2);
    // 단추는 label 밖 — 고르기의 이름에 단추 글자가 섞이지 않는다
    expect(html).toMatch(/<label for="mode-product-translate-1">실행 방식<\/label><button type="button" class="cs-help"/);
  });

  it("같은 모델 두 줄 — 둘째 줄 옆 경고와 도움말의 읽은 값", () => {
    expect(html).toMatch(/aria-label="함께 2 칸 수"/);
    expect(plain).toContain(`m1-gemma ${TWIN_WARNING}`);
    expect(plain).toContain("「공개 번역 동시 호출」 한도(지금 2)");
    expect(plain).toContain("m1-gemma 2 m1-gemma는 동시에 2개까지");
    expect(plain).not.toContain("m1-qwen");
  });
});
