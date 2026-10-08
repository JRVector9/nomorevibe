import { afterEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ compared: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spies.compared += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { bearerMatches } from "@/lib/auth/bearer";
import { DELETE } from "@/app/api/admin/products/[slug]/route";

afterEach(() => { vi.unstubAllEnvs(); spies.compared = 0; });

describe("Bearer 비밀값 비교", () => {
  it("같은 값만 통과시키고, 비교는 길이와 무관하게 상수 시간 비교로 한다", () => {
    expect(bearerMatches("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(bearerMatches("Bearer s3cret-valuX", "s3cret-value")).toBe(false);
    // 길이가 달라도 같은 경로를 탄다 — 길이 차이로 일찍 빠지면 비밀값 길이가 샌다
    expect(bearerMatches("Bearer s", "s3cret-value")).toBe(false);
    expect(spies.compared).toBe(3);
  });

  it("비밀값이 설정되지 않았거나 헤더가 없으면 거부한다", () => {
    expect(bearerMatches("Bearer ", "")).toBe(false);
    expect(bearerMatches("Bearer undefined", undefined)).toBe(false);
    expect(bearerMatches(null, "s3cret-value")).toBe(false);
  });

  it("관리자 토큰 라우트가 이 비교를 쓴다", async () => {
    vi.stubEnv("ADMIN_TOKEN", "admin-token-value");
    const response = await DELETE(new Request("http://localhost/api/admin/products/x", {
      method: "DELETE", headers: { authorization: "Bearer wrong-token-value" },
    }), { params: Promise.resolve({ slug: "x" }) });
    expect(response.status).toBe(403);
    expect(spies.compared).toBe(1);
  });
});
