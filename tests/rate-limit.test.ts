import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clientIp } from "@/lib/rate-limit";

const req = (xff?: string) =>
  new Request("https://nomorevibe.app/api/products", {
    headers: xff ? { "x-forwarded-for": xff } : {},
  });

describe("clientIp — XFF 신뢰 hop (2차 리뷰 F4 회귀)", () => {
  const saved = process.env.TRUSTED_PROXY_HOPS;
  beforeEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.TRUSTED_PROXY_HOPS = saved;
    else delete process.env.TRUSTED_PROXY_HOPS;
  });

  it("기본(hops=0)에서는 헤더를 신뢰하지 않아 스푸핑으로 버킷을 회전할 수 없다", () => {
    expect(clientIp(req("1.1.1.1"))).toBe("direct");
    expect(clientIp(req("2.2.2.2"))).toBe("direct");
    expect(clientIp(req("evil, spoof"))).toBe("direct");
  });

  it("hops=1이면 마지막 항목(프록시가 덧붙인 실제 피어)을 쓴다", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(req("spoofed, 203.0.113.9"))).toBe("203.0.113.9");
  });

  it("hops=2(CDN+프록시)면 뒤에서 두 번째를 쓴다", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req("spoofed, 203.0.113.9, 10.0.0.5"))).toBe("203.0.113.9");
  });

  it("체인이 예상보다 짧으면 가장 왼쪽 값으로 안전하게 떨어진다", () => {
    process.env.TRUSTED_PROXY_HOPS = "3";
    expect(clientIp(req("203.0.113.9"))).toBe("203.0.113.9");
  });
});
