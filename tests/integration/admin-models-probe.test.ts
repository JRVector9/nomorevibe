import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { probeObservationKey } from "@/lib/operations/admin-models-probe";
import { readProbeObservations, recordAutoProbes, saveProbeObservation } from "@/lib/operations/admin-models-probe-repository";
import { ensureSchema } from "./setup";

/**
 * 연결 확인 관측(2026-10-31 한 화면) — 서버 액션의 수동 결과와 렌더의 자동 결과가 operations_observations 의 probe:<provider>:<model> 키에 upsert 되고,
 * 화면이 같은 키로 읽는다. 사설 테스트 DB 한 대에서 실제 저장·읽기 한 바퀴를 확인한다(운영 DB 아님).
 */
const identity = { routeId: "crawl-agent-review", provider: "local-direct", model: `probe-test:${Date.now().toString(36)}` };
const key = probeObservationKey(identity);

beforeAll(() => { ensureSchema(); });
afterAll(async () => { await db.execute(sql`DELETE FROM operations_observations WHERE key LIKE 'probe:local-direct:probe-test:%' OR key LIKE 'probe:search-server:it-%'`); });

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
});
