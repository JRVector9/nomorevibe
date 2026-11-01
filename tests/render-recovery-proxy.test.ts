import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { renderRecoveryCookie } from "@/lib/web/recovery-cache";

afterEach(() => vi.unstubAllEnvs());

describe("short recovery cache hint", () => {
  it("expires in twenty seconds and has no domain/auth payload", () => {
    expect(renderRecoveryCookie(true)).toBe("nmv_render_recovery=1; Path=/; Max-Age=20; SameSite=Lax; Secure");
    expect(renderRecoveryCookie(false)).toBe("nmv_render_recovery=1; Path=/; Max-Age=20; SameSite=Lax");
  });

  it.each(["/", "/en/popular", "/p/project?_rsc=probe", "/zh-Hans/c/dev"])(
    "marks recovery HTML/RSC reads private without changing locale routing: %s", async path => {
      const normal = await proxy(new NextRequest(`https://nomorevibe.com${path}`));
      const recovery = await proxy(new NextRequest(`https://nomorevibe.com${path}`, {
        headers: { cookie: "nmv_render_recovery=1", RSC: "1" },
      }));
      expect(recovery.headers.get("cache-control")).toBe("private, no-store");
      expect(recovery.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
      expect(recovery.status).toBe(normal.status);
      expect(recovery.headers.get("x-middleware-rewrite")).toBe(normal.headers.get("x-middleware-rewrite"));
      expect(normal.headers.get("cloudflare-cdn-cache-control")).toBeNull();
    },
  );

  it("requires the exact cookie value and does not turn a POST into a recovery request", async () => {
    const wrong = await proxy(new NextRequest("https://nomorevibe.com/", { headers: { cookie: "nmv_render_recovery=10" } }));
    const post = await proxy(new NextRequest("https://nomorevibe.com/", { method: "POST", headers: { cookie: "nmv_render_recovery=1" } }));
    expect(wrong.headers.get("cache-control")).toBeNull();
    expect(post.headers.get("cache-control")).toBeNull();
  });

  it("confers no administrator ingress/session authorization", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_ORIGIN", "");
    vi.stubEnv("ADMIN_INGRESS_SECRET", "");
    vi.stubEnv("ADMIN_LOCAL_LOGIN", "0");
    const response = await proxy(new NextRequest("https://nomorevibe.com/admin/status", {
      headers: { cookie: "nmv_render_recovery=1" },
    }));
    expect(response.status).toBe(404);
  });
});
