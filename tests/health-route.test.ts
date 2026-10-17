import { afterEach, describe, expect, it, vi } from "vitest";

/** 웹 health 는 경로 이름(lan/tailscale)만 더한다 — 대신 주소를 설정하지 않은 곳(Oracle·로컬)은 지금과 같은 응답 */
const state = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => { if (state.fail) throw new Error("down"); return []; }) } }));
// migration 확인(schemaReadiness)은 별도 테스트(health-schema)가 맡는다 — 여기서는 적용된 상태로 둔다
vi.mock("@/lib/operations/health", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/operations/health")>(), schemaReadiness: vi.fn(async () => "ok" as const) }));

afterEach(() => {
  (globalThis as { nomorevibeNetworkRoutes?: unknown }).nomorevibeNetworkRoutes = undefined;
  state.fail = false;
});

describe("GET /api/health", () => {
  it("대신 주소가 없으면 networkRoutes 를 내지 않는다", async () => {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET()).json();
    expect(Object.keys(body).sort()).toEqual(["db", "dbLatencyMs", "instanceId", "release", "status"]);
  });

  it("설정한 연결의 경로 이름만 낸다(주소 없음), DB 가 안 될 때도", async () => {
    const { registerRoute } = await import("@/lib/db/network-route");
    registerRoute("primary", () => "tailscale");
    registerRoute("valkey", () => null);
    const { GET } = await import("@/app/api/health/route");
    expect((await (await GET()).json()).networkRoutes).toEqual({ primary: "tailscale", valkey: null });
    state.fail = true;
    const failed = await GET();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
