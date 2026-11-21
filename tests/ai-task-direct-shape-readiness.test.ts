import { describe, expect, it } from "vitest";
import { aiTask, aiTaskAliasIdentity } from "@/lib/llm/ai-tasks";
import { aiRankReadiness, aiRanksReadiness, type AiConnectionView, type AiReadinessInput } from "@/lib/operations/admin-ai-tasks";
import { TOTAL_BOUND_PROTOCOL_NAME } from "@/lib/operations/engine-contract-shape";

/**
 * 2026-11-21 abcllm 이름표 정리 2단계 — 「작업 ↔ 모델」 순위 저장의 준비 확인이 새 계약을 엔진 직접 총량 상한(local-direct)으로 만들고 그 정책 route 를
 * (경로, local-direct, 장부 이름)으로 덧붙인다. 계약 읽기 관문이 닫혀 있으면 예전 abcllm 형이고 그 까닭을 알린다. 이미 있는 계약은 그 provider 그대로다.
 */
const GPU = "11111111-1111-4111-8111-111111111111", SUPA = "22222222-2222-4222-8222-222222222222";
const connection = (patch: Partial<AiConnectionView> & Pick<AiConnectionView, "id" | "label">): AiConnectionView => ({ kind: "api", baseUrl: null, host: null, hasKey: false,
  cliTool: null, cliModels: [], models: null, modelsReadAt: null, modelsError: null, deviceId: patch.label, capacitySlots: 2, contextTokens: null, enabled: true,
  version: 1, note: null, updatedBy: "t", updatedAt: "2026-11-21T00:00:00.000Z", cliVersion: null, ...patch });
const gpu = connection({ id: GPU, label: "gpu", baseUrl: "http://gpu.test:8090/v1", host: "gpu.test:8090", deviceId: "dev-gpu",
  models: [{ id: "qwen-next", maxModelLen: 131072 }] });
const supa = connection({ id: SUPA, label: "supa", baseUrl: "http://supa.test:8000/v1", host: "supa.test:8000", deviceId: "dev-supa",
  models: [{ id: "qwen-next", maxModelLen: 65536 }] });
const routes = [
  { routeId: "crawl-tagline", provider: "abcllm", model: "other-model", providerBudgetId: "budget-gpu", groupId: "dev-gpu" },
  { routeId: "crawl-tagline", provider: "local-direct", model: "third-model", providerBudgetId: "budget-supa", groupId: "dev-supa" },
];
const open = { open: true, text: "모든 프로세스가 새 판입니다." }, closed = { open: false, text: "옛 판 프로세스 1개: text:text-mini" };
const input = (patch: Partial<AiReadinessInput> = {}): AiReadinessInput => ({ contracts: [], localContract: () => null,
  engineRoutes: ["crawl-agent-review", "crawl-tagline", "reason-translate", "second-review"], policy: { mode: "open", routes, groupLimits: {} },
  devices: new Map([["dev-gpu", { enabled: true, limitSlots: 4 }], ["dev-supa", { enabled: true, limitSlots: 3 }]]), directShape: open, ...patch });

describe("새 계약의 모양", () => {
  it("관문이 열려 있으면 엔진 직접 총량 상한 계약과 (경로, local-direct, 모델) route — 예산은 같은 장비의 route 이름, 다른 장비의 local-direct 형제와 맞추지 않는다", () => {
    const ready = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input());
    expect(ready).toMatchObject({ blocking: [], provider: "local-direct", identity: "qwen-next",
      createContract: { routeId: "crawl-tagline", replacesGateway: false, identity: "qwen-next", engineModel: null, provider: "local-direct" },
      appendRoute: { routeId: "crawl-tagline", provider: "local-direct", model: "qwen-next", providerBudgetId: "budget-gpu", groupId: "dev-gpu" } });
    expect(ready.warnings).toEqual([]);
  });

  it("관문이 닫혀 있으면 예전 abcllm 형으로 만들고 그 까닭을 알린다(칸 모양도 예전 그대로)", () => {
    const ready = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ directShape: closed }));
    expect(ready.createContract).toEqual({ routeId: "crawl-tagline", replacesGateway: false, identity: "qwen-next", engineModel: null });
    expect(ready).toMatchObject({ provider: "abcllm", appendRoute: { provider: "abcllm", providerBudgetId: "budget-gpu", groupId: "dev-gpu" } });
    expect(ready.warnings).toEqual([expect.stringContaining("새 계약은 abcllm 형으로 만듭니다 — 직접 연결(local-direct) 모양은 모든 프로세스가 새 판일 때만 만듭니다. 옛 판 프로세스 1개")]);
    // directShape 를 모르는 호출자(옛 입력)·이름 댈 옛 판 프로세스가 없는 닫힘(관측 없음·읽기 실패)은 알림 없이 abcllm 형
    for (const directShape of [undefined, { open: false, text: null }])
      expect(aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ directShape }))).toMatchObject({ provider: "abcllm", warnings: [] });
  });

  it("2차는 관문이 열려 있어도 abcllm 형 그대로다(2차 전환 전 확인이 끝날 때까지)", () => {
    const ready = aiRankReadiness(aiTask("second-review")!, 1, gpu, "qwen-next", input());
    expect(ready.createContract).toEqual({ routeId: "second-review", replacesGateway: false, identity: "qwen-next", engineModel: null });
    expect(ready).toMatchObject({ provider: "abcllm", appendRoute: { routeId: "second-review", provider: "abcllm" }, warnings: [] });
  });

  it("관문이 열려 있어도 경로가 아직 전환 전(켜진 abcllm 계약이 남음)이면 abcllm 형 — 일부만 옮긴 경로도 같다; 전환 도구가 끝낸 경로는 새 모양", () => {
    const abcllm = (model: string) => ({ routeId: "crawl-tagline", model, provider: "abcllm", protocol: "abcllm-crawl-tagline-total-bound-v1",
      endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" });
    const direct = (model: string) => ({ routeId: "crawl-tagline", model, provider: "local-direct", protocol: TOTAL_BOUND_PROTOCOL_NAME,
      endpoint: "http://supa.test:8000/v1/chat/completions", transport: "direct" });
    const unconverted = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ contracts: [abcllm("other-model")] }));
    expect(unconverted.createContract).toEqual({ routeId: "crawl-tagline", replacesGateway: false, identity: "qwen-next", engineModel: null });
    expect(unconverted).toMatchObject({ provider: "abcllm", appendRoute: { provider: "abcllm" } });
    expect(unconverted.warnings).toEqual([expect.stringContaining("crawl-tagline: 이 경로는 아직 전환 전 — abcllm 모양으로 저장합니다(켜진 abcllm 계약 1개)")]);
    const partial = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ contracts: [abcllm("other-model"), direct("third-model")] }));
    expect(partial).toMatchObject({ provider: "abcllm", createContract: { identity: "qwen-next" }, appendRoute: { provider: "abcllm" } });
    expect(partial.createContract).not.toHaveProperty("provider");
    const converted = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ contracts: [direct("other-model"), direct("third-model")] }));
    expect(converted).toMatchObject({ provider: "local-direct", createContract: { provider: "local-direct" }, appendRoute: { provider: "local-direct" }, warnings: [] });
    // 2차도 전환 도구가 끝낸 경로면 새 모양
    const ai2 = aiRankReadiness(aiTask("second-review")!, 1, gpu, "qwen-next", input({ contracts: [{ ...direct("voter"), routeId: "second-review" }] }));
    expect(ai2).toMatchObject({ provider: "local-direct", createContract: { routeId: "second-review", provider: "local-direct" } });
  });

  it("같은 모델 계약이 다른 서버에 있으면 연결로 가른 장부 이름의 새 모양 계약 — 한 줄의 뒤 순위가 앞 순위의 새 계약을 본다", () => {
    const ready = aiRanksReadiness(aiTask("crawl-tagline")!, [{ rank: 1, connection: gpu, model: "qwen-next" }, { rank: 2, connection: supa, model: "qwen-next" }], input());
    const alias = aiTaskAliasIdentity("qwen-next", SUPA)!;
    expect(ready.map(row => [row.provider, row.identity, row.createContract?.provider, row.createContract?.engineModel, row.appendRoute?.provider, row.appendRoute?.groupId]))
      .toEqual([["local-direct", "qwen-next", "local-direct", null, "local-direct", "dev-gpu"], ["local-direct", alias, "local-direct", "qwen-next", "local-direct", "dev-supa"]]);
  });

  it("이미 있는 엔진 직접 총량 상한 계약(전환 뒤)은 엔진 이름(engineModel)으로 찾아 그대로 쓰고, 빠진 route 만 덧붙인다", () => {
    const alias = aiTaskAliasIdentity("qwen-next", GPU)!;
    const contracts = [{ routeId: "crawl-tagline", model: alias, provider: "local-direct", protocol: TOTAL_BOUND_PROTOCOL_NAME,
      endpoint: "http://gpu.test:8090/v1/chat/completions", transport: "direct", engineModel: "qwen-next" }];
    // 관문이 닫혀 있어도 있는 계약은 그 provider 로 부른다
    const ready = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ contracts, directShape: closed }));
    expect(ready).toMatchObject({ blocking: [], provider: "local-direct", identity: alias, createContract: null, warnings: [],
      appendRoute: { routeId: "crawl-tagline", provider: "local-direct", model: alias, providerBudgetId: "budget-gpu", groupId: "dev-gpu" } });
    // route 가 다른 장비에 있으면 막는다(예전 규칙 그대로)
    const misplaced = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ contracts, policy: { mode: "open", groupLimits: {},
      routes: [...routes, { routeId: "crawl-tagline", provider: "local-direct", model: alias, providerBudgetId: "budget-supa", groupId: "dev-supa" }] } }));
    expect(misplaced.blocking).toEqual([expect.stringContaining(`crawl-tagline / local-direct / ${alias} 경로는 장비 dev-supa에 있습니다`)]);
    // 장비 이름 칸을 가진 옛 직접 계약(direct-openai-chat-v1)은 예전처럼 장부 이름 = 엔진 이름으로만 찾고 route 를 만들지 않는다
    const legacy = aiRankReadiness(aiTask("crawl-tagline")!, 1, gpu, "qwen-next", input({ contracts: [{ ...contracts[0], model: "qwen-next", engineModel: null,
      protocol: "direct-openai-chat-v1" }] }));
    expect(legacy).toMatchObject({ provider: "local-direct", createContract: null, appendRoute: null });
    expect(legacy.blocking).toEqual([expect.stringContaining("용량 정책에 crawl-tagline / local-direct / qwen-next 경로가 없습니다")]);
  });
});
