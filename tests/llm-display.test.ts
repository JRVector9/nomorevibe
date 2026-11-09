import { describe, expect, it } from "vitest";
import type { ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { buildAdminModelsObservation, unavailableAdminModels, type AdminModelMetrics } from "@/lib/operations/admin-models-observation";
import { buildDashboardView, buildLlmOpsView, routeTaskLabel } from "@/lib/operations/llm-ops-view";
import { deviceDisplay, deviceDisplayMap, deviceModelsText, helperRouteOf, isOrphanDevice, isStalePolicyRoute, modelDisplayNames, routeDisplayLabel, routeGroupOf } from "@/lib/operations/llm-display";

// 2026-11-09 운영 사실(연결 이름표 → 장비 id, 주소, 모델)을 닮은 고정값 — 운영 DB 를 읽지 않는다
const NOW = "2026-11-09T00:00:00.000Z";
const conn = (id: string, label: string, deviceId: string, models: string[] | null, patch: Partial<AiConnectionView> = {}): AiConnectionView => ({
  id, label, kind: "api", deviceId, baseUrl: null, host: null, hasKey: false, cliTool: null, cliModels: [], models: models && models.map(model => ({ id: model, maxModelLen: null })),
  modelsReadAt: null, modelsError: null, capacitySlots: 1, contextTokens: null, enabled: true, version: 1, note: null, updatedBy: "fixture", updatedAt: NOW, cliVersion: null, ...patch });
const CONNECTIONS: AiConnectionView[] = [
  conn("c1", "gpu3090-qwen", "gpu3090-qwen", ["qwen3.8-flash-next"]),
  conn("c2", "m1-gemma", "m1-qwen", ["m1-gemma"]),
  conn("c3", "m3-deepseek", "m3-mlx", ["deepseek-v4.1-flash-1017"]),
  conn("c4", "m3-gpt-oss", "m3-mlx", ["gpt-oss-120b"]),
  conn("c5", "supa-direct", "supa-direct", ["supa", "Inferact/Qwen3.8-27B-NVFP4"]),
  conn("c6", "Claude CLI", "anthropic-cli", null, { kind: "cli", cliTool: "claude", cliModels: ["sonnet"] }),
  conn("c7", "M3 OpenCode", "m3-opencode-host", null, { kind: "cli", cliTool: "opencode", cliModels: ["deepseek/deepseek-v4.1-flash"] }),
];
const route = (routeId: string, groupId: string, model: string, provider = "abcllm") => ({ routeId, provider, model, groupId, providerBudgetId: "acct" });
const ROUTES = [
  route("crawl-agent-review", "gpu3090-qwen", "qwen3.8-flash-next", "local-direct"), route("local-held-qwen", "gpu3090-qwen", "qwen3.8-flash-next", "local-direct"),
  route("second-review", "supa-direct", "supa"), route("second-review", "m3-mlx", "gpt-oss-120b"), route("product-translate", "m1-qwen", "m1-gemma"),
  route("crawl-tagline", "m3-mlx", "[MLX] gpt-oss-120b"), route("product-translate", "m1-qwen", "mlx-community--gemma-4-26b-a4b-it-4bit"),
  route("local-held-qwen", "supa", "[supa] Qwen3.8-27B-NVFP4"), route("second-review", "supa", "Inferact/Qwen3.8-27B-NVFP4"),
  route("product-tagline-ko-qwen-legacy", "gpu3090-qwen", "qwen3.8-flash-next"),
  route("local-assist-uptime-gpu3090-qwen", "gpu3090-qwen", "qwen3.8-flash-next", "local-direct"),
  route("local-assist-decision_audit-m3-deepseek", "m3-mlx", "deepseek-v4.1-flash-1017", "local-direct"),
  route("product-intro-check", "anthropic-cli", "sonnet", "claude-cli"), route("crawl-publish-classify", "openai-cli", "gpt-5.6-terra", "codex-cli"),
];
const DEVICE_IDS = ["anthropic-cli", "gpu3090-qwen", "m1-qwen", "m3-mlx", "m3-opencode-host", "openai-cli", "supa", "supa-direct"];
const device = (deviceId: string, patch: Partial<ModelCapacityDeviceState> = {}): ModelCapacityDeviceState => ({ deviceId, source: "table", limitSlots: deviceId === "supa" ? 20 : 2,
  secondaryCap: 2, idleMs: 60_000, reserveSlots: 0, active: 0, secondaryActive: 0, secondaryBound: 2, primaryBusy: false, lending: false, waiting: 0, waitingPrimary: 0,
  version: 3, updatedAt: NOW, helpers: [], lendIdle: true, routes: [], ...patch });
const metric = (routeId: string, groupId: string, patch: Partial<AdminModelMetrics>): AdminModelMetrics => ({ ...route(routeId, groupId, "m"), succeeded1h: 0, failed1h: 0,
  withdrawn1h: 0, unclassified1h: 0, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, lastSuccessAt: null, ...patch });
const POLICY: ModelCapacityPolicy = { version: 1, groupLimits: Object.fromEntries(DEVICE_IDS.map(id => [id, 2])), providerLimits: { acct: 8 }, maxWaiting: 50, queueTtlMs: 60_000,
  reservationTtlMs: 30_000, routes: ROUTES };
const observation = (metrics: AdminModelMetrics[] = [metric("crawl-agent-review", "gpu3090-qwen", { succeeded1h: 10 })]) => buildAdminModelsObservation({ observedAt: NOW,
  control: { mode: "open", epoch: 1, revision: 1, policy: POLICY, policyHash: modelCapacityPolicyHash(POLICY), updatedAt: NOW }, metrics, requests: [],
  devices: DEVICE_IDS.map(id => device(id)) });

describe("장비 이름 — 연결 이름표가 정한다(deviceDisplay)", () => {
  it("운영 장비 8개: 연결 이름(정렬 · 로 잇기) + 모델(같은 엔진 별칭은 하나로), 연결이 없으면 CLI 도구 이름, 그것도 없으면 장비 id", () => {
    const names = deviceDisplayMap(CONNECTIONS, observation());
    expect(DEVICE_IDS.map(id => [id, names.get(id)?.name, names.get(id)?.models, names.get(id)?.source])).toEqual([
      ["anthropic-cli", "Claude CLI", ["sonnet"], "connection"],
      ["gpu3090-qwen", "gpu3090-qwen", ["qwen3.8-flash-next"], "connection"],
      // 「m1-qwen 안 쓰기로 했다, m1-gemma 잖아」
      ["m1-qwen", "m1-gemma", ["Gemma 4 26B"], "connection"],
      // 두 서버처럼 보이던 「m3-mlx · m3-mlx (2)」 — 연결 이름표 그대로
      ["m3-mlx", "m3-deepseek · m3-gpt-oss", ["deepseek-v4.1-flash-1017", "gpt-oss-120b"], "connection"],
      ["m3-opencode-host", "M3 OpenCode(OpenCode CLI)", ["deepseek/deepseek-v4.1-flash"], "connection"],
      ["openai-cli", "Codex CLI", [], "cli"],
      ["supa", "supa", [], "id"],
      // supa · Inferact/… 는 같은 모델의 두 이름 — 한 줄
      ["supa-direct", "supa-direct", ["Inferact/Qwen3.8-27B-NVFP4"], "connection"],
    ]);
  });
  it("켜진 연결이 없으면 꺼진 연결 이름, 모델은 켜진 연결만 — 연결을 못 읽으면 장비 id", () => {
    const off = [conn("x", "m1-gemma", "m1-qwen", ["m1-gemma"], { enabled: false })];
    expect(deviceDisplay("m1-qwen", off)).toMatchObject({ name: "m1-gemma", models: [], source: "connection" });
    expect(deviceDisplay("m1-qwen", null)).toMatchObject({ name: "m1-qwen", source: "id" });
    // 켜진 연결이 있으면 꺼진 연결 이름은 빼고 보인다
    expect(deviceDisplay("m3-mlx", [...CONNECTIONS, conn("y", "m3-old", "m3-mlx", [], { enabled: false })]).name).toBe("m3-deepseek · m3-gpt-oss");
  });
  it("모델 별칭은 증명된 것만 묶는다 — Gemma 옛·새 이름, 정식 이름과 함께 있을 때의 supa", () => {
    expect(modelDisplayNames(["m1-gemma", "mlx-community--gemma-4-26b-a4b-it-4bit", "auto"])).toEqual(["Gemma 4 26B", "auto"]);
    expect(modelDisplayNames(["supa", "Inferact/Qwen3.8-27B-NVFP4"])).toEqual(["Inferact/Qwen3.8-27B-NVFP4"]);
    expect(modelDisplayNames(["supa"])).toEqual(["supa"]);
    // 이름 아래 한 줄은 셋까지
    expect(deviceModelsText(["a", "b", "c", "d", "e"])).toBe("a · b · c 외 2");
    expect(deviceModelsText(["a", "b"])).toBe("a · b");
  });
});

describe("손댈 것이 없는 장비(isOrphanDevice)", () => {
  it("연결도 CLI 도구도 쓰임도 없는 supa 만 — 연결이 있거나 CLI 장비거나 장부에 쓰임이 있으면 아니다", () => {
    const seen = observation();
    expect(DEVICE_IDS.filter(id => isOrphanDevice(id, CONNECTIONS, seen))).toEqual(["supa"]);
    // 장부에 쓰임(대기·정산)이 있으면 연결이 없어도 숨기지 않는다
    expect(isOrphanDevice("supa", CONNECTIONS, observation([metric("second-review", "supa", { waiting: 1 })]))).toBe(false);
    // 못 읽은 것은 숨기지 않는다
    expect(isOrphanDevice("supa", null, seen)).toBe(false);
    expect(isOrphanDevice("supa", CONNECTIONS, unavailableAdminModels())).toBe(false);
  });
});

describe("용량 경로 이름(routeDisplayLabel)", () => {
  it.each([
    ["local-assist-uptime-gpu3090-qwen", "보조 · 연결 확인"], ["local-assist-repo_move-gpu3090-qwen", "보조 · 저장소 이동"],
    ["local-assist-intro_recheck-gpu3090-qwen", "보조 · 소개 재검수"], ["local-assist-decision_audit-m3-deepseek", "보조 · 판정 감사"],
    ["local-assist-semantic_exception-m3-deepseek", "보조 · 의미 예외"], ["local-assist-news-gpu3090-qwen", "보조 · 소식"],
    ["local-held-qwen", "보류 재심사"], ["local-qwen-tiebreak", "2차 갈림 판가름"], ["local-published-filter", "공개분 추가 검수"], ["local-audit", "발행분 감사 · 직접 모델"],
    ["local-screen", "화면 판별"], ["local-second-opinion", "감사 두 번째 의견"], ["local-deepseek-confirm", "2차 갈림 재확인"], ["local-human-deepseek", "사람 몫 위임 검수"],
    ["product-tagline-ko-qwen-legacy", "옛 경로 · 한국어 소개 번역"], ["brand-new-route", "brand-new-route"], ["local-assist-unknown-gpu3090-qwen", "local-assist-unknown-gpu3090-qwen"],
  ])("%s → %s", (routeId, label) => {
    expect(routeDisplayLabel(routeId)).toBe(label);
    expect(routeTaskLabel(routeId)).toBe(label);
  });
  it("보조 경로는 작업·백엔드를 읽고 helper 갈래로 묶는다", () => {
    expect(helperRouteOf("local-assist-decision_audit-m3-deepseek")).toEqual({ task: "decision_audit", backendId: "m3-deepseek", label: "보조 · 판정 감사" });
    expect(routeGroupOf("local-assist-news-gpu3090-qwen")).toBe("helper");
    expect(routeGroupOf("local-held-qwen")).toBe("task");
  });
});

describe("낡은 정책 경로(isStalePolicyRoute) — 숨김 판단만, 데이터는 그대로", () => {
  const refs = new Set(["qwen3.8-flash-next"]);
  it("옛 경로 id, 그 장비 연결이 내놓지 않는 별칭 이름(순위·분산도 안 씀)은 낡음", () => {
    expect(isStalePolicyRoute(route("product-tagline-ko-qwen-legacy", "gpu3090-qwen", "qwen3.8-flash-next"), CONNECTIONS, refs)).toBe(true);
    expect(isStalePolicyRoute(route("crawl-tagline", "m3-mlx", "[MLX] gpt-oss-120b"), CONNECTIONS, refs)).toBe(true);
    expect(isStalePolicyRoute(route("product-translate", "m1-qwen", "mlx-community--gemma-4-26b-a4b-it-4bit"), CONNECTIONS, refs)).toBe(true);
  });
  it("연결이 내놓는 모델(「@연결 8자」 장부 이름 포함)·순위가 쓰는 모델·CLI 경로·판정할 수 없는 장비는 낡지 않음", () => {
    expect(isStalePolicyRoute(route("second-review", "m3-mlx", "gpt-oss-120b"), CONNECTIONS, refs)).toBe(false);
    expect(isStalePolicyRoute(route("second-review", "m3-mlx", "gpt-oss-120b@c4c4c4c4"), CONNECTIONS, refs)).toBe(false);
    expect(isStalePolicyRoute(route("crawl-tagline", "m3-mlx", "[MLX] gpt-oss-120b"), CONNECTIONS, new Set(["[MLX] gpt-oss-120b"]))).toBe(false);
    expect(isStalePolicyRoute(route("crawl-publish-classify", "openai-cli", "gpt-5.6-terra", "codex-cli"), CONNECTIONS, refs)).toBe(false);
    // 연결이 없는 장비(supa)는 isOrphanDevice 가 다룬다 — 모델로 판정하지 않는다
    expect(isStalePolicyRoute(route("second-review", "supa", "Inferact/Qwen3.8-27B-NVFP4"), CONNECTIONS, refs)).toBe(false);
    // 모델 목록을 못 읽은 연결의 장비, 연결을 못 읽은 경우
    expect(isStalePolicyRoute(route("x", "m1-qwen", "anything"), [conn("z", "m1-gemma", "m1-qwen", null)], refs)).toBe(false);
    expect(isStalePolicyRoute(route("x", "m1-qwen", "anything"), null, refs)).toBe(false);
  });
});

describe("대시보드·LLM 운영의 장비 이름", () => {
  it("대시보드 장비 점유: 연결 이름 + 모델 줄, 연결도 쓰임도 없는 supa 는 빠진다, 실패 할 일의 장비도 연결 이름", () => {
    const failing = observation([metric("product-translate", "m1-qwen", { failed1h: 3 })]);
    const view = buildDashboardView({ now: NOW, observation: failing, conveyor: null, jobs: [], connections: CONNECTIONS });
    expect(view.devices.map(entry => entry.deviceId)).not.toContain("supa");
    expect(view.devices.find(entry => entry.deviceId === "m1-qwen")).toMatchObject({ label: "m1-gemma", models: ["Gemma 4 26B"] });
    expect(view.devices.find(entry => entry.deviceId === "m3-mlx")).toMatchObject({ label: "m3-deepseek · m3-gpt-oss" });
    expect(view.todos.find(entry => entry.id.startsWith("fail-"))?.detail).toContain("(장비 m1-gemma)");
    // 연결을 못 읽으면 아무것도 숨기지 않고 장비 id 를 쓴다
    const blind = buildDashboardView({ now: NOW, observation: failing, conveyor: null, jobs: [], connections: null });
    expect(blind.devices.find(entry => entry.deviceId === "supa")).toMatchObject({ label: "supa" });
  });
  it("LLM 운영 연결 행: 그 연결이 쓰는 장비의 이름(같은 장비를 쓰는 연결들)", () => {
    const view = buildLlmOpsView({ now: NOW, observation: observation(), connections: CONNECTIONS, rows: [], executions: [], runtime: {}, jobs: [], cliContracts: [], classifier: null });
    const row = (label: string) => view.rows.find(entry => entry.label === label)!;
    expect(row("m3-gpt-oss").deviceName).toBe("m3-deepseek · m3-gpt-oss");
    expect(row("m1-gemma").deviceName).toBe("m1-gemma");
    expect(view.rows.filter(entry => entry.source === "cli-tool").every(entry => entry.deviceName === null)).toBe(true);
  });
});
