import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { probeObservationKey } from "@/lib/operations/admin-models-probe";
import { autoProbeDirectEngines, readProbeObservations, recordAutoProbes, saveProbeObservation } from "@/lib/operations/admin-models-probe-repository";
import { directProbeGate } from "@/lib/operations/admin-models-direct-probe";
import type { ModelCard } from "@/lib/operations/admin-models-view";
import type { StoredServingContract } from "@/lib/llm/serving-contract-store";
import { ensureSchema } from "./setup";

/**
 * 연결 확인 관측(2026-10-31 한 화면) — 서버 액션의 수동 결과와 렌더의 자동 결과가 operations_observations 의 probe:<provider>:<model> 키에 upsert 되고,
 * 화면이 같은 키로 읽는다. 사설 테스트 DB 한 대에서 실제 저장·읽기 한 바퀴를 확인한다(운영 DB 아님).
 */
const identity = { routeId: "crawl-agent-review", provider: "local-direct", model: `probe-test:${Date.now().toString(36)}` };
const key = probeObservationKey(identity);

beforeAll(() => { ensureSchema(); });
afterAll(async () => { await db.execute(sql`DELETE FROM operations_observations WHERE key LIKE 'probe:local-direct:probe-test:%' OR key LIKE 'probe:search-server:it-%' OR key LIKE 'probe:abcllm:it-direct-%'`); });

describe("연결 확인 관측 저장·읽기", () => {
  it("수동 결과를 슬롯 키에 저장하고 같은 키로 다시 읽으며, 두 번째 저장은 같은 행을 덮어쓴다(upsert)", async () => {
    const first = await saveProbeObservation(identity, { listed: true, listMs: 48, callBlocked: "짧은 시험 호출 차단" }, "manual");
    expect(first.key).toBe(key);
    let probes = await readProbeObservations();
    expect(probes[key]).toMatchObject({ key, kind: "model-probe", provider: identity.provider, model: identity.model, routeId: identity.routeId, source: "manual", listed: true, listMs: 48, callBlocked: "짧은 시험 호출 차단", error: null });
    expect(Number.isFinite(Date.parse(probes[key].observedAt))).toBe(true);
    await saveProbeObservation({ ...identity, routeId: "second-review" }, { listed: false, listMs: 1200, error: "모델 목록에 없음" }, "manual");
    probes = await readProbeObservations();
    expect(probes[key]).toMatchObject({ routeId: "second-review", listed: false, listMs: 1200, error: "모델 목록에 없음" });
    const [{ count }] = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM operations_observations WHERE key = ${key}`);
    expect(Number(count)).toBe(1);
  });
  it("자동 결과는 DR 쓰기 관문이 열린 사이트에서만 남고 막힌 사이트에서는 건너뛴다", async () => {
    const [fence] = await db.execute<{ state: string | null }>(sql`SELECT state FROM dr_writer_fence WHERE id = 1`).catch(() => [{ state: null }]);
    const entry = { identity: { routeId: null, provider: "search-server", model: `it-${Date.now().toString(36)}` }, result: { listed: true, listMs: 12 }, detail: "검색 모델 서버 · GET /health" };
    const saved = await recordAutoProbes([entry]);
    const probes = await readProbeObservations(), stored = probes[probeObservationKey(entry.identity)];
    if (fence?.state === "active") { expect(saved).toBe(1); expect(stored).toMatchObject({ source: "auto", listed: true, listMs: 12, detail: "검색 모델 서버 · GET /health" }); }
    else { expect(saved).toBe(0); expect(stored).toBeUndefined(); }
  });
  it("엔진 직접 연결 자동 확인 — 1분 안의 수동 결과는 덮지 않고, 오래되면 GET /models 결과를 자동(auto)으로 덮으며 값에 키·주소가 없다", async () => {
    const [fence] = await db.execute<{ state: string | null }>(sql`SELECT state FROM dr_writer_fence WHERE id = 1`).catch(() => [{ state: null }]);
    const model = `it-direct-${Date.now().toString(36)}`, slot = { provider: "abcllm", model }, slotKey = probeObservationKey(slot), apiKey = "sk-it-secret-direct";
    const contract: StoredServingContract = { routeId: "product-translate", model, auth: "stored", apiKey, transport: "direct",
      contract: { provider: "abcllm", model, endpoint: "http://100.77.43.63:8090/v1/chat/completions" } };
    const card = { id: JSON.stringify([slot.provider, slot.model]), name: model, equipment: "gpu3090", equipmentSource: null, hosts: [], rows: [], requests: [], stages: [],
      contracts: [{ routeId: contract.routeId, model, host: "100.77.43.63:8090", transport: "direct" }] } satisfies ModelCard;
    const read = vi.fn(async () => ({ ok: true as const, models: [{ id: model }] }));
    directProbeGate().clear();
    await saveProbeObservation({ routeId: contract.routeId, ...slot }, { listed: false, listMs: 30, error: "모델 목록에 없음" }, "manual");
    expect(await autoProbeDirectEngines([card], [contract], read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect((await readProbeObservations())[slotKey]).toMatchObject({ source: "manual", listed: false });
    await db.execute(sql`UPDATE operations_observations SET observed_at = now() - interval '5 minutes' WHERE key = ${slotKey}`);
    const saved = await autoProbeDirectEngines([card], [contract], read);
    const [{ value }] = await db.execute<{ value: unknown }>(sql`SELECT value FROM operations_observations WHERE key = ${slotKey}`);
    if (fence?.state === "active") {
      expect(saved).toBe(1); expect(read).toHaveBeenCalledWith(contract.contract && (contract.contract as { endpoint: string }).endpoint, apiKey);
      expect(value).toMatchObject({ source: "auto", listed: true, routeId: "product-translate", detail: "엔진 직접 연결 · GET /models" });
      expect(JSON.stringify(value)).not.toMatch(/sk-it-secret|Bearer|100\.77\.43\.63|http:/);
    } else { expect(saved).toBe(0); expect(read).not.toHaveBeenCalled(); expect(value).toMatchObject({ source: "manual" }); }
  });
});
