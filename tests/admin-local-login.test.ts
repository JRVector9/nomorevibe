import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { currentAdmin, isAdminLogin } from "@/lib/auth/admin";
import { proxy } from "@/proxy";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

describe("GitHub 없이 로컬 어드민 로그인", () => {
  const saved = {
    local: process.env.ADMIN_LOCAL_LOGIN,
    secret: process.env.AUTH_SECRET,
    logins: process.env.ADMIN_GITHUB_LOGINS,
  };

  beforeEach(() => {
    delete process.env.ADMIN_LOCAL_LOGIN;
    delete process.env.ADMIN_GITHUB_LOGINS;
    process.env.AUTH_SECRET = "x".repeat(32);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restore("ADMIN_LOCAL_LOGIN", saved.local);
    restore("AUTH_SECRET", saved.secret);
    restore("ADMIN_GITHUB_LOGINS", saved.logins);
  });

  it("스위치가 꺼져 있으면 local 계정은 어드민이 아니다", () => {
    expect(isAdminLogin("local")).toBe(false);
  });

  it("스위치가 켜져 있으면 local 계정은 어드민이다", () => {
    process.env.ADMIN_LOCAL_LOGIN = "1";
    expect(isAdminLogin("local")).toBe(true);
    expect(isAdminLogin("someone-else")).toBe(false);
  });

  it("스위치가 켜져 있으면 쿠키 없이 어드민 세션이다", async () => {
    process.env.ADMIN_LOCAL_LOGIN = "1";
    const admin = await currentAdmin();
    expect(admin?.login).toBe("local");
  });

  it("스위치가 꺼져 있으면 세션 없이 /admin을 로그인으로 보낸다", async () => {
    const res = await proxy(new NextRequest("http://localhost:3200/admin"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  it("스위치가 켜져 있으면 세션 없이 /admin을 연다", async () => {
    process.env.ADMIN_LOCAL_LOGIN = "1";
    const res = await proxy(new NextRequest("http://localhost:3200/admin"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("production에서는 local=1과 위조 내부 헤더로 관리자 경계를 열 수 없다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_LOCAL_LOGIN", "1");
    vi.stubEnv("ADMIN_ORIGIN", "");
    vi.stubEnv("ADMIN_INGRESS_SECRET", "");
    expect(isAdminLogin("local")).toBe(false);
    const res = await proxy(new NextRequest("https://public.example/admin/login", {
      headers: { host: "internal.example", "x-forwarded-for": "100.64.0.1", "x-nmv-admin-ingress-token": "forged" },
    }));
    expect(res.status).toBe(404);
  });

  it("설정된 private ingress 증명만 통과하고 언어 접두사는 관리자 별칭이 되지 않는다", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_ORIGIN", "https://internal.example");
    vi.stubEnv("ADMIN_INGRESS_SECRET", "private-ingress-fixture-key-at-least-32-bytes");
    const headers = { "x-nmv-admin-ingress-token": process.env.ADMIN_INGRESS_SECRET! };
    expect((await proxy(new NextRequest("https://public.example/admin/status"))).status).toBe(404);
    const res = await proxy(new NextRequest("https://internal.example/admin/status", { headers }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://internal.example/admin/login");
    expect((await proxy(new NextRequest("https://internal.example/en/admin/status", { headers }))).status).toBe(404);
  });
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
