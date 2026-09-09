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
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
