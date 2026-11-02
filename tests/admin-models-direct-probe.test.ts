import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
// 실행기(readbackServingEndpoint)가 사는 모듈은 DB 저장 함수도 함께 들인다 — 이 테스트는 DB 를 쓰지 않는다
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (fn: () => unknown) => fn() }));
import { claimDirectProbes, DIRECT_PROBE_DETAIL, DIRECT_PROBE_INTERVAL_MS, directProbeDue, directProbeTargets, runDirectProbes,
  type DirectProbeTarget } from "@/lib/operations/admin-models-direct-probe";
import { PROBE_LIST_FAILED_MESSAGE, probeObservationKey, probeObservationValue } from "@/lib/operations/admin-models-probe";
import { buildModelCards, modelContractLinks, type ModelCard } from "@/lib/operations/admin-models-view";
import { readbackServingEndpoint } from "@/lib/operations/admin-serving-contracts";
import { TEXT_ROUTE_BLOCK_DETAIL, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import type { ModelDefinition } from "@/lib/llm/model-registry";

/**
 * 엔진 직접 연결 모델의 자동 연결 확인(2026-11-01) — 대상 고르기·중복 제거·건너뛰기, 1분 간격, 관측 값에 비밀이 없음.
 * HTTP 는 목(fetch)만 — 실제 엔진을 부르지 않는다.
 */
const KEY = "sk-live-test-secret-0123456789", HOST = "100.77.43.63:8090", M3 = "100.92.77.66:8010";
const endpoint = (host: string) => `http://${host}/v1/chat/completions`;
const row = (over: Partial<StoredServingContract> & { routeId: string; model: string }, contract: Record<string, unknown> = {}): StoredServingContract =>
  ({ auth: "none", apiKey: null, transport: "direct", ...over,
    contract: { provider: "abcllm", model: over.model, endpoint: endpoint(HOST), ...contract } });
const card = (provider: string, model: string, rows: readonly StoredServingContract[], definition?: Partial<ModelDefinition>): ModelCard => ({
  id: definition?.key ?? JSON.stringify([provider, model]), name: model, equipment: "gpu3090", equipmentSource: null, hosts: [],
  definition: definition as ModelDefinition | undefined, rows: [], requests: [], stages: [],
  contracts: modelContractLinks(rows).filter(link => link.model === model) });

describe("자동 확인 대상 고르기", () => {
  it("활성 직접 계약(transport direct)과 local-direct 계약만 고르고, 게이트웨이 전송 행·계약 없는 카드는 고르지 않는다", () => {
    const direct = row({ routeId: "product-translate", model: "gemma", auth: "stored", apiKey: KEY });
    const local = row({ routeId: "crawl-agent-review", model: "qwen3.8-flash-next", transport: "gateway", auth: "gateway" }, { provider: "local-direct" });
    const gateway = row({ routeId: "search-profile", model: "old-gateway", transport: "gateway", auth: "gateway" });
    const rows = [direct, local, gateway];
    const targets = directProbeTargets([card("abcllm", "gemma", rows), card("local-direct", "qwen3.8-flash-next", rows), card("abcllm", "old-gateway", rows),
      card("claude-cli", "sonnet", rows)], rows);
    expect(targets.map(target => target.identity)).toEqual([
      { routeId: "product-translate", provider: "abcllm", model: "gemma" },
      { routeId: "crawl-agent-review", provider: "local-direct", model: "qwen3.8-flash-next" }]);
    expect(targets[0]).toMatchObject({ bearer: KEY, blocked: null, names: ["gemma"] });
    expect(targets[1]).toMatchObject({ bearer: null, blocked: null });
  });
  it("꺼진 계약은 스냅숏(enabled 행만)에 없으므로 그 카드는 대상이 아니다", () => {
    const disabled = row({ routeId: "product-translate", model: "gemma" });
    expect(directProbeTargets([card("abcllm", "gemma", [disabled])], [])).toEqual([]);
  });
  it("저장한 키를 열 수 없으면 부르지 않고 기존 키 오류 문구만 남길 대상으로 둔다 — 같은 슬롯에 열리는 계약이 있으면 그쪽을 부른다", () => {
    const broken = row({ routeId: "korean-tagline", model: "gpt-oss-120b", auth: "stored", apiKey: null });
    expect(directProbeTargets([card("abcllm", "gpt-oss-120b", [broken])], [broken])).toEqual([expect.objectContaining({
      endpoint: null, bearer: null, blocked: TEXT_ROUTE_BLOCK_DETAIL.stored_key_unreadable })]);
    const good = row({ routeId: "search-profile", model: "gpt-oss-120b", auth: "stored", apiKey: KEY });
    expect(directProbeTargets([card("abcllm", "gpt-oss-120b", [broken, good])], [broken, good])).toEqual([expect.objectContaining({
      identity: { routeId: "search-profile", provider: "abcllm", model: "gpt-oss-120b" }, bearer: KEY, blocked: null })]);
  });
  it("여러 경로가 쓰는 한 모델은 슬롯 키 하나로 한 번만, 표가 읽는 키(probeIdentityOf — 등록부 key)와 같은 키로 고른다", () => {
    const rows = ["korean-tagline", "search-profile", "search-verify"].map(routeId => row({ routeId, model: "gpt-oss-120b" }, { endpoint: endpoint(M3) }));
    const definition = { key: "m3:text", provider: "abcllm", model: "gpt-oss-120b" };
    const observation = { rows: ["korean-tagline", "search-profile"].map(routeId => ({ routeId, provider: "abcllm", model: "gpt-oss-120b", groupId: "m3" })),
      requests: [] } as unknown as AdminModelsObservation;
    const cards = buildModelCards(observation, [definition as ModelDefinition], [], modelContractLinks(rows));
    const targets = directProbeTargets([...cards, ...cards], rows);
    expect(targets).toHaveLength(1);
    expect(targets[0].key).toBe(probeObservationKey({ provider: "abcllm", model: "m3:text" }));
    expect(targets[0].identity.routeId).toBe("korean-tagline");
  });
});

describe("1분 간격", () => {
  const target = (model: string): DirectProbeTarget => ({ key: probeObservationKey({ provider: "abcllm", model }), identity: { routeId: "r", provider: "abcllm", model },
    names: [model], endpoint: endpoint(HOST), bearer: null, blocked: null });
  const now = Date.parse("2026-11-01T03:00:00.000Z"), ago = (ms: number) => ({ observedAt: new Date(now - ms).toISOString() });
  it("저장된 관측이 수동이든 자동이든 간격 안이면 건너뛰고, 없거나 오래됐거나 시각을 못 읽으면 부른다", () => {
    expect(directProbeDue(undefined, now)).toBe(true);
    expect(directProbeDue(ago(10_000), now)).toBe(false);
    expect(directProbeDue(ago(DIRECT_PROBE_INTERVAL_MS), now)).toBe(true);
    expect(directProbeDue({ observedAt: "not-a-time" }, now)).toBe(true);
  });
  it("방금 누른 수동 결과는 덮지 않고, 같은 프로세스의 두 번째 렌더(30초 새로고침·다른 탭)는 엔진을 다시 부르지 않는다", () => {
    const gate = new Map<string, number>();
    const fresh = target("manual-fresh"), stale = target("stale"), never = target("never");
    const saved = { [fresh.key]: ago(5_000), [stale.key]: ago(5 * 60_000) };
    expect(claimDirectProbes([fresh, stale, never], saved, now, gate).map(row => row.identity.model)).toEqual(["stale", "never"]);
    // DB 를 못 읽어 저장된 관측이 비어도 프로세스 안의 시도 시각으로 거른다
    expect(claimDirectProbes([fresh, stale, never], {}, now + 30_000, gate).map(row => row.identity.model)).toEqual(["manual-fresh"]);
    expect(claimDirectProbes([stale, never], {}, now + DIRECT_PROBE_INTERVAL_MS, gate).map(row => row.identity.model)).toEqual(["stale", "never"]);
  });
});

describe("GET /models 실행과 관측 값", () => {
  const target = (model: string, over: Partial<DirectProbeTarget> = {}): DirectProbeTarget => ({ key: probeObservationKey({ provider: "abcllm", model }),
    identity: { routeId: "product-translate", provider: "abcllm", model }, names: [model], endpoint: endpoint(M3), bearer: KEY, blocked: null, ...over });
  it("같은 /models 주소·같은 인증은 한 번만 부르고, 목록 유무·소요를 슬롯마다 나눈다. 생성 요청(POST)은 보내지 않는다", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-oss-120b" }] })));
    const read = (url: string, key: string | null) => readbackServingEndpoint(url, key, request as unknown as typeof fetch);
    let tick = 0;
    const entries = await runDirectProbes([target("gpt-oss-120b"), target("deepseek")], read, () => (tick += 40));
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = (request.mock.calls[0] as unknown as [string, RequestInit]);
    expect(url).toBe(`http://${M3}/v1/models`);
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${KEY}` } });
    expect(entries.map(entry => entry.result)).toEqual([{ listed: true, listMs: 40, error: null }, { listed: false, listMs: 40, error: null }]);
    expect(entries.every(entry => entry.detail === DIRECT_PROBE_DETAIL)).toBe(true);
  });
  it("못 읽으면 수동 버튼과 같은 문구 + 이유 코드, 모양이 다른 이유는 버리고, 막힌 대상은 부르지 않는다", async () => {
    const read = vi.fn(async (url: string) => url.includes("8010") ? { ok: false as const, reason: "http_401" } : { ok: false as const, reason: `failed at ${url}` });
    const entries = await runDirectProbes([target("a"), target("b", { endpoint: endpoint(HOST) }),
      target("c", { endpoint: null, bearer: null, blocked: TEXT_ROUTE_BLOCK_DETAIL.stored_key_unreadable })], read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(entries[0].result).toMatchObject({ listed: null, error: `${PROBE_LIST_FAILED_MESSAGE} · http_401` });
    expect(entries[1].result).toMatchObject({ listed: null, error: `${PROBE_LIST_FAILED_MESSAGE} · unreachable` });
    expect(entries[2].result).toEqual({ listed: null, error: TEXT_ROUTE_BLOCK_DETAIL.stored_key_unreadable });
    const thrown = await runDirectProbes([target("d")], async () => { throw new Error(`boom ${KEY}`); });
    expect(thrown[0].result.error).toBe(`${PROBE_LIST_FAILED_MESSAGE} · unreachable`);
  });
  it("관측 값에는 주소·호스트·키·헤더가 없다 — 성공·목록 없음·실패·막힘 모두", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-oss-120b" }] })));
    const down = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const rows = [
      ...await runDirectProbes([target("gpt-oss-120b"), target("missing")], (url, key) => readbackServingEndpoint(url, key, ok as unknown as typeof fetch)),
      ...await runDirectProbes([target("down", { endpoint: endpoint(HOST) })], (url, key) => readbackServingEndpoint(url, key, down as unknown as typeof fetch)),
      ...await runDirectProbes([target("blocked", { endpoint: null, bearer: null, blocked: TEXT_ROUTE_BLOCK_DETAIL.stored_key_unreadable })], ok as never),
    ];
    expect(rows).toHaveLength(4);
    for (const entry of rows) {
      const stored = JSON.stringify(probeObservationValue(entry.identity, entry.result, "auto", entry.detail));
      for (const secret of [KEY, "Bearer", "authorization", HOST, M3, "100.77.43.63", "100.92.77.66", "http://", "/v1/chat"]) expect(stored).not.toContain(secret);
      expect(JSON.parse(stored)).toMatchObject({ kind: "model-probe", source: "auto", provider: "abcllm" });
    }
  });
});

const repo = vi.hoisted(() => ({ writable: vi.fn(), observe: vi.fn(), saved: [] as { key: string; value: unknown; observedAt: string }[] }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWritable: repo.writable }));
vi.mock("@/lib/operations/observations", () => ({ observe: repo.observe }));
vi.mock("@/lib/db/schema", () => ({ operationsObservations: { key: "key", value: "value", observedAt: "observed_at" } }));
describe("autoProbeDirectEngines(저장소)", () => {
  const rowAt = (model: string) => row({ routeId: "product-translate", model, auth: "stored", apiKey: KEY });
  async function load() {
    const db = await import("@/lib/db") as unknown as { db: Record<string, unknown> };
    db.db.select = () => ({ from: () => ({ where: async () => repo.saved }) });
    const { directProbeGate } = await import("@/lib/operations/admin-models-direct-probe");
    directProbeGate().clear();
    return import("@/lib/operations/admin-models-probe-repository");
  }
  it("쓰기가 막힌 사이트에서는 엔진을 부르지 않는다", async () => {
    const { autoProbeDirectEngines } = await load();
    repo.writable.mockResolvedValue(false); const read = vi.fn();
    expect(await autoProbeDirectEngines([card("abcllm", "gemma", [rowAt("gemma")])], [rowAt("gemma")], read)).toBe(0);
    expect(read).not.toHaveBeenCalled(); expect(repo.observe).not.toHaveBeenCalled();
  });
  it("1분 안의 수동 결과는 덮지 않고, 오래된 슬롯만 불러 자동(auto) 출처로 남긴다", async () => {
    const { autoProbeDirectEngines } = await load();
    repo.writable.mockResolvedValue(true); repo.observe.mockReset().mockResolvedValue(undefined);
    const now = Date.now(), manual = { provider: "abcllm", model: "fresh" }, stale = { provider: "abcllm", model: "stale" };
    repo.saved = [
      { key: probeObservationKey(manual), value: probeObservationValue({ routeId: "product-translate", ...manual }, { listed: false }, "manual"), observedAt: new Date(now - 10_000).toISOString() },
      { key: probeObservationKey(stale), value: probeObservationValue({ routeId: "product-translate", ...stale }, { listed: true }, "auto"), observedAt: new Date(now - 120_000).toISOString() }];
    const rows = [rowAt("fresh"), rowAt("stale")];
    const read = vi.fn(async () => ({ ok: true as const, models: [{ id: "stale" }] }));
    expect(await autoProbeDirectEngines([card("abcllm", "fresh", rows), card("abcllm", "stale", rows)], rows, read, now)).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(repo.observe).toHaveBeenCalledTimes(1);
    const [key, value] = repo.observe.mock.calls[0];
    expect(key).toBe(probeObservationKey(stale));
    expect(value).toMatchObject({ source: "auto", listed: true, model: "stale", detail: DIRECT_PROBE_DETAIL });
    expect(JSON.stringify(value)).not.toContain(KEY);
  });
});
