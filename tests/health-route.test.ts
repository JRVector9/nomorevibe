import { afterEach, describe, expect, it, vi } from "vitest";

/** 웹 health 는 경로 이름(lan/tailscale)만 더한다 — 대신 주소를 설정하지 않은 곳(Oracle·로컬)은 지금과 같은 응답 */
const state = vi.hoisted(() => ({ fail: false, schema: "ok" as "ok" | "pending" | "unverified" }));
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => { if (state.fail) throw new Error("down"); return []; }) } }));
// migration 확인(schemaReadiness)의 실제 판정은 별도 테스트(health-schema)가 맡는다 — 여기서는 결과만 고른다
vi.mock("@/lib/operations/health", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/operations/health")>(), schemaReadiness: vi.fn(async () => state.schema) }));

/** Next 16 standalone 서버가 바로 붙은 요청에 채우는 모양(16.4.1 에서 node fetch 로 확인) — 배포 도구의 docker exec fetch 와 같다 */
const DIRECT = {
  host: "a1b2c3d4e5f6:3000",
  "x-forwarded-for": "10.0.1.15",
  "x-forwarded-host": "a1b2c3d4e5f6:3000",
  "x-forwarded-port": "3000",
  "x-forwarded-proto": "http",
};
/** Cloudflare Tunnel → Traefik → 웹: Traefik 이 X-Real-Ip·X-Forwarded-Server 를 붙이고, Cloudflare 가 CF-* 를 붙인다 */
const PUBLIC = {
  host: "nomorevibe.com",
  "x-forwarded-for": "203.0.113.7, 172.18.0.4",
  "x-forwarded-host": "nomorevibe.com",
  "x-forwarded-port": "443",
  "x-forwarded-proto": "https",
  "x-forwarded-server": "traefik-m3",
  "x-real-ip": "172.18.0.4",
  "cf-connecting-ip": "203.0.113.7",
  "cf-ray": "8f0000000000abcd-ICN",
  "cdn-loop": "cloudflare",
};
const request = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/health", { headers });

afterEach(() => {
  (globalThis as { nomorevibeNetworkRoutes?: unknown }).nomorevibeNetworkRoutes = undefined;
  state.fail = false;
  state.schema = "ok";
  vi.unstubAllEnvs();
});

describe("GET /api/health — 공개 요청은 상태만", () => {
  it("정상: 200 과 status ok 만 — release·instanceId·dbLatencyMs·networkRoutes 없음", async () => {
    vi.stubEnv("RELEASE_TAG", "f".repeat(40));
    vi.stubEnv("SERVICE_INSTANCE_ID", "m3-web");
    const { registerRoute } = await import("@/lib/db/network-route");
    registerRoute("primary", () => "tailscale");
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(request(PUBLIC));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "ok" });
    expect(text).not.toMatch(/f{40}|m3-web|tailscale/);
  });

  it("DB 불통: 503 과 status error 만", async () => {
    state.fail = true;
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(request(PUBLIC));
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "error" });
  });

  it("migration 미적용: 503 과 status error 만 — schema·expectedMigration 은 서버 로그에만", async () => {
    state.schema = "pending";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { GET } = await import("@/app/api/health/route");
      const res = await GET(request(PUBLIC));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: "error" });
      const lines = stderr.mock.calls.map(([line]) => String(line)).filter(line => line.includes("health.schema_not_ready"));
      expect(JSON.parse(lines[0])).toMatchObject({ event: "health.schema_not_ready", schema: "pending" });
    } finally { stderr.mockRestore(); }
  });

  it("Cloudflare 없이 Traefik 에 바로 온 요청(사설망)도 공개다 — Traefik 은 X-Real-Ip·X-Forwarded-Server 를 늘 붙인다", async () => {
    const { GET } = await import("@/app/api/health/route");
    const lan = { host: "nomorevibe.com", "x-forwarded-for": "192.168.50.10", "x-forwarded-host": "nomorevibe.com",
      "x-forwarded-port": "80", "x-forwarded-proto": "http", "x-forwarded-server": "traefik-mini", "x-real-ip": "192.168.50.10" };
    expect(await (await GET(request(lan))).json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/health — 컨테이너에 바로 붙은 요청은 전체 본문", () => {
  it("대신 주소가 없으면 networkRoutes 를 내지 않는다", async () => {
    const { GET } = await import("@/app/api/health/route");
    const body = await (await GET(request(DIRECT))).json();
    expect(Object.keys(body).sort()).toEqual(["db", "dbLatencyMs", "instanceId", "release", "status"]);
  });

  it("배포 도구가 읽는 status·db·release·instanceId 를 그대로 낸다", async () => {
    vi.stubEnv("RELEASE_TAG", "a".repeat(40));
    vi.stubEnv("SERVICE_INSTANCE_ID", "mini-web");
    const { GET } = await import("@/app/api/health/route");
    for (const headers of [DIRECT, { ...DIRECT, host: "127.0.0.1:3000", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1" },
      { ...DIRECT, host: "[::1]:3000", "x-forwarded-host": "[::1]:3000", "x-forwarded-for": "::1" },
      // emergency-web 은 HOSTNAME=0.0.0.0 으로 듣는다(Dockerfile)
      { ...DIRECT, host: "0.0.0.0:3000", "x-forwarded-host": "0.0.0.0:3000", "x-forwarded-for": "127.0.0.1" },
      { ...DIRECT, host: "127.0.0.1:3200", "x-forwarded-host": "127.0.0.1:3200", "x-forwarded-for": "::ffff:172.18.0.1" }]) {
      const res = await GET(request(headers));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", db: "ok", release: "a".repeat(40), instanceId: "mini-web", dbLatencyMs: expect.any(Number) });
    }
  });

  it("설정한 연결의 경로 이름만 낸다(주소 없음), DB 가 안 될 때도", async () => {
    const { registerRoute } = await import("@/lib/db/network-route");
    registerRoute("primary", () => "tailscale");
    registerRoute("valkey", () => null);
    const { GET } = await import("@/app/api/health/route");
    expect((await (await GET(request(DIRECT))).json()).networkRoutes).toEqual({ primary: "tailscale", valkey: null });
    state.fail = true;
    const failed = await GET(request(DIRECT));
    expect(failed.status).toBe(503);
    const body = await failed.json();
    expect(body).toMatchObject({ status: "error", db: "unavailable", networkRoutes: { primary: "tailscale", valkey: null } });
    expect(JSON.stringify(body)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("migration 미적용이면 schema·expectedMigration 까지 — 배포 helper 가 롤아웃을 멈춘다", async () => {
    state.schema = "unverified";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { GET } = await import("@/app/api/health/route");
      const { EXPECTED_MIGRATION } = await import("@/lib/operations/health");
      const res = await GET(request(DIRECT));
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ status: "error", db: "ok", schema: "unverified", expectedMigration: EXPECTED_MIGRATION.tag });
    } finally { stderr.mockRestore(); }
  });
});

describe("GET /api/health — 모양이 하나라도 다르면 상태만(꾸밈·불확실)", () => {
  const cases: [string, Record<string, string>][] = [
    ["전달 머리가 아예 없다(Next 를 거치지 않은 모양)", {}],
    ["Host 만 있다", { host: "a1b2c3d4e5f6:3000" }],
    ["x-real-ip 하나만 더했다", { ...DIRECT, "x-real-ip": "10.0.1.15" }],
    ["x-forwarded-server 하나만 더했다", { ...DIRECT, "x-forwarded-server": "traefik" }],
    ["forwarded(RFC 7239) 하나만 더했다", { ...DIRECT, forwarded: "for=10.0.1.15" }],
    ["via 하나만 더했다", { ...DIRECT, via: "1.1 proxy" }],
    ["cf-ray 하나만 더했다", { ...DIRECT, "cf-ray": "8f00-ICN" }],
    ["cf-connecting-ip 하나만 더했다", { ...DIRECT, "cf-connecting-ip": "203.0.113.7" }],
    ["cdn-loop 하나만 더했다", { ...DIRECT, "cdn-loop": "cloudflare" }],
    ["true-client-ip 하나만 더했다", { ...DIRECT, "true-client-ip": "203.0.113.7" }],
    ["x-forwarded-for 가 여러 hop", { ...DIRECT, "x-forwarded-for": "203.0.113.7, 10.0.1.15" }],
    ["x-forwarded-for 가 IP 가 아니다", { ...DIRECT, "x-forwarded-for": "unknown" }],
    ["x-forwarded-for 가 없다", Object.fromEntries(Object.entries(DIRECT).filter(([key]) => key !== "x-forwarded-for"))],
    ["x-forwarded-proto 가 https(TLS 를 푼 프록시)", { ...DIRECT, "x-forwarded-proto": "https" }],
    ["x-forwarded-proto 가 없다", Object.fromEntries(Object.entries(DIRECT).filter(([key]) => key !== "x-forwarded-proto"))],
    ["x-forwarded-host 가 Host 와 다르다", { ...DIRECT, "x-forwarded-host": "nomorevibe.com" }],
    ["Host 에 포트가 없다(공개 주소)", { ...DIRECT, host: "nomorevibe.com", "x-forwarded-host": "nomorevibe.com" }],
  ];
  for (const [name, headers] of cases) {
    it(name, async () => {
      vi.stubEnv("RELEASE_TAG", "c".repeat(40));
      const { GET } = await import("@/app/api/health/route");
      const ok = await GET(request(headers));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: "ok" });
      state.fail = true;
      const failed = await GET(request(headers));
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ status: "error" });
    });
  }
});
