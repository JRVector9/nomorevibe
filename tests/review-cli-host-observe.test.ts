import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";

/*
 * 2026-11-07 운영 증거: 1차 1순위 OpenCode(DB 계약 있음, 호스트 브리지 살아 있음)가 매 틱 provider_contract_unavailable 로 미뤄지고
 * cli_host.prepare_unavailable 도 남기지 않았다 — 예약 전 계약 확인(reviewCliServingContract → dbLookup)이 이 워커가 60초 안에 본 호스트 버전을
 * 요구하는데, 워커가 버전을 보는 길(readCliHostCatalog)은 예약 뒤의 원격 prepare 뿐이었다. 여기서는 실제 계약·순위 스냅숏·cli-host-client 를 쓰고
 * 네트워크(fetch)만 바꾼다. 모듈 상태(관측 버전·실패 대기)는 시험마다 새로 읽는다.
 */
const model = "opencode-go/deepseek-v4.1-flash", connectionId = "0d0e0f10-0000-4000-8000-000000000001";
const apiKey = "test-only-bridge-secret-32-characters-long", baseUrl = "http://cli-host.test:3031/v1";
const warn = vi.fn(), control = vi.fn(), hostTarget = vi.fn();
vi.mock("@/lib/observability/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: (...args: unknown[]) => warn(...args), error: vi.fn() } }));
// 소개 검수·감사(backgroundCliPath)의 장부 control 읽기와 연결 키 열기만 경계 mock 이다
vi.mock("@/lib/llm/capacity-repository", async original => ({ ...await original<typeof import("@/lib/llm/capacity-repository")>(),
  readModelCapacityCallerControl: () => control() }));
vi.mock("@/lib/operations/cli-host-target", async original => ({ ...await original<typeof import("@/lib/operations/cli-host-target")>(),
  readCliHostTarget: (id: string) => hostTarget(id) }));

function opencodeRank(task: string, slot = 1, rank = 1): AiTaskModelSnapshotRow {
  return Object.freeze({ task, slot, rank, model, enabled: true, options: {}, connection: Object.freeze({ id: connectionId, label: "m3-opencode-host",
    kind: "cli" as const, baseUrl, cliTool: "opencode", deviceId: "m3-opencode-host", enabled: true, models: null, contextTokens: null,
    apiKey, keyUnreadable: false }) });
}
const catalog = (observedAt = new Date()) => ({ version: 1, bootId: randomUUID(), cliVersion: "1.19.5", observedAt: observedAt.toISOString(),
  models: [{ id: model, label: "DeepSeek", variants: ["low", "high"], maxModelLen: null }] });
const fetchMock = vi.fn();

async function load() {
  vi.resetModules();
  const [store, ranks, contracts, dbContracts, review, observe, observation] = await Promise.all([
    import("@/lib/llm/serving-contract-store"), import("@/lib/llm/ai-task-models-snapshot"), import("@/lib/llm/cli-serving-contract"),
    import("@/lib/llm/cli-db-contracts"), import("@/lib/crawl/review-cli-call"), import("@/lib/crawl/review-cli-host-observe"),
    import("@/lib/operations/cli-host-observation")]);
  const row = (routeId: string) => ({ routeId: contracts.cliContractRouteId("opencode-cli", routeId), model, auth: "none" as const, apiKey: null,
    contract: { ...dbContracts.cliDbContract(routeId, "opencode-cli", model, "1.19.5")!, routeId: contracts.cliContractRouteId("opencode-cli", routeId) } });
  // 순위 저장이 OpenCode 연결로 만든 DB 계약 행(운영: route_id cli:opencode-cli:crawl-agent-review, 켜짐)과 1차·2차 OpenCode 순위
  store.setServingContractSnapshotForTest([row("crawl-agent-review"), row("second-review"), row("product-audit")]);
  ranks.setAiTaskModelsForTest([opencodeRank("first-review"), opencodeRank("second-review")]);
  observation.resetCliHostObservationForTest();
  return { review, observe, contracts,
    preCheck: (routeId: "crawl-agent-review" | "second-review" = "crawl-agent-review") => review.reviewCliServingContract(routeId, "opencode-cli", model) };
}
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); warn.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("관측이 없으면 예약 전 계약 확인은 늘 null(provider_contract_unavailable)이고, 그 확인은 호스트를 부르지 않는다 — 고치기 전의 교착", async () => {
  const { preCheck, contracts } = await load();
  for (let tick = 0; tick < 3; tick++) expect(preCheck()).toBeNull();
  expect(contracts.cliServingContractStatus("crawl-agent-review", "opencode-cli", model)).toBe("probe_pending");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("TX 밖 관측 갱신이 신선한 카탈로그를 읽으면 사전 확인을 지나고, 새로운 동안은 다시 부르지 않는다", async () => {
  const { preCheck, observe } = await load();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(catalog())));
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(`${baseUrl}/rpc`);
  expect(JSON.parse(init.body)).toEqual({ version: 1, action: "catalog", data: {} });
  // 계약의 버전은 관측한 호스트 버전이다 — 예약 뒤 prepare 가 catalog.cliVersion 과 다시 정확히 견준다
  expect(preCheck()).toMatchObject({ routeId: "crawl-agent-review", provider: "opencode-cli", model, cliVersion: "1.19.5" });
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});

it("카탈로그가 실패하면 오늘처럼 미루고(null), 진단 한 줄에 키·주소를 싣지 않으며, 실패 대기 동안 다시 부르지 않는다", async () => {
  const { preCheck, observe } = await load();
  fetchMock.mockResolvedValue(new Response("down", { status: 502 }));
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  expect(preCheck()).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledExactlyOnceWith("cli_host.observe_unavailable", { connectionId, code: "cli_host_request_failed" });
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|cli-host\.test/);
});

it("낡은 카탈로그(observedAt 2분 전)는 관측이 아니다 — 사전 확인은 그대로 미룬다", async () => {
  const { preCheck, observe } = await load();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(catalog(new Date(Date.now() - 120_000)))));
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  expect(preCheck()).toBeNull();
  expect(warn).toHaveBeenCalledExactlyOnceWith("cli_host.observe_unavailable", { connectionId, code: "cli_host_catalog_stale" });
});

it("실패 대기가 지나면 다시 읽고, 관측이 60초를 넘겨 낡으면 사전 확인은 다시 닫힌다(갱신이 다시 연다)", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { preCheck, observe } = await load();
  fetchMock.mockResolvedValueOnce(new Response("down", { status: 502 }));
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  expect(preCheck()).toBeNull();
  vi.setSystemTime(Date.now() + 31_000);
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(catalog())));
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  expect(preCheck()).not.toBeNull();
  vi.setSystemTime(Date.now() + 61_000);
  expect(preCheck()).toBeNull();
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model });
  expect(preCheck()).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("같은 연결의 동시 갱신은 한 번만 부른다(single-flight)", async () => {
  const { preCheck, observe } = await load();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  fetchMock.mockImplementation(async () => { await gate; return new Response(JSON.stringify(catalog())); });
  const lanes = Array.from({ length: 4 }, () => observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model }));
  release();
  await Promise.all(lanes);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(preCheck()).not.toBeNull();
});

it("OpenCode 가 아닌 심사자·다른 모델은 호스트를 부르지 않는다", async () => {
  const { observe } = await load();
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "claude-cli", model: "sonnet" });
  await observe.observeReviewCliHost("crawl-agent-review", { provider: "opencode-cli", model: "opencode-go/other" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("2차 소비자(심사자를 claim 안에서야 앎)는 2차 OpenCode 순위 연결로 관측해 투표 사전 확인을 연다", async () => {
  const { preCheck, observe } = await load();
  expect(preCheck("second-review")).toBeNull();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(catalog())));
  await observe.observeReviewCliHost("second-review");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(preCheck("second-review")).toMatchObject({ routeId: "second-review", provider: "opencode-cli", model, cliVersion: "1.19.5" });
});

it("감사·소개 검수의 OpenCode 사전 확인(backgroundCliPath)도 연결 id 가 있으면 관측을 먼저 채우고, 실패하면 그대로 provider_contract_unavailable", async () => {
  await load();
  const { backgroundCliPath } = await import("@/lib/llm/cli-model-capacity");
  control.mockResolvedValue({ mode: "open", policy: { routes: [{ routeId: "product-audit", provider: "opencode-cli", model }] } });
  hostTarget.mockResolvedValue({ connectionId, baseUrl, apiKey });
  fetchMock.mockResolvedValueOnce(new Response("down", { status: 502 }));
  await expect(backgroundCliPath("product-audit", model, "opencode-cli", connectionId)).rejects.toMatchObject({ reason: "provider_contract_unavailable" });
  expect(warn).toHaveBeenCalledExactlyOnceWith("cli_host.observe_unavailable", { connectionId, code: "cli_host_request_failed" });
  const { resetCliHostObservationForTest } = await import("@/lib/operations/cli-host-observation");
  resetCliHostObservationForTest();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(catalog())));
  expect(await backgroundCliPath("product-audit", model, "opencode-cli", connectionId)).toBe("native");
  expect(hostTarget).toHaveBeenCalledWith(connectionId);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
