import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isPrivateIp, isPrivateHostname, assertPublicUrl } from "@/lib/net/ssrf";
import { safeFetch } from "@/lib/net/fetch";

describe("isPrivateIp — SSRF 차단 대상 판정", () => {
  it("사설·루프백·메타데이터 대역을 차단한다", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // 클라우드 메타데이터 — 가장 위험한 대상
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it("공인 IP는 통과시킨다", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "2606:4700::1"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("사설 호스트명을 차단한다", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("db.internal")).toBe(true);
    expect(isPrivateHostname("printer.local")).toBe(true);
    expect(isPrivateHostname("example.com")).toBe(false);
  });
});

describe("assertPublicUrl — 프로덕션 모드", () => {
  const saved = process.env.ALLOW_PRIVATE_URLS;
  beforeEach(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ALLOW_PRIVATE_URLS = saved;
  });

  it("사설 IP 리터럴을 차단한다", async () => {
    expect((await assertPublicUrl("http://169.254.169.254/latest/meta-data/")).ok).toBe(false);
    expect((await assertPublicUrl("http://127.0.0.1:8899/")).ok).toBe(false);
  });

  it("localhost를 차단한다", async () => {
    expect((await assertPublicUrl("http://localhost:3000/")).ok).toBe(false);
  });

  it("사설 IP로 해석되는 공인 도메인도 차단한다 (DNS 기반 우회 방지)", async () => {
    // nip.io는 호스트명에 박힌 IP를 그대로 해석해준다 — 공인 DNS명 → 127.0.0.1
    const result = await assertPublicUrl("http://127.0.0.1.nip.io/");
    expect(result.ok).toBe(false);
    // DNS 조회 실패가 아니라 "사설 대역"으로 차단돼야 의미가 있다
    if (!result.ok) expect(result.reason).toContain("사설 IP 대역");
  }, 15_000);

  it("ALLOW_PRIVATE_URLS=1이면 로컬 개발용으로 통과시킨다", async () => {
    process.env.ALLOW_PRIVATE_URLS = "1";
    expect((await assertPublicUrl("http://localhost:3000/")).ok).toBe(true);
  });
});

describe("safeFetch — undici lookup 콜백 형태 (2차 리뷰 F1 회귀)", () => {
  const saved = process.env.ALLOW_PRIVATE_URLS;
  beforeEach(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ALLOW_PRIVATE_URLS = saved;
  });

  it("가드가 켜진 상태에서도 정상 공인 URL을 가져온다", async () => {
    // lookup이 options.all을 무시하면 ERR_INVALID_IP_ADDRESS로 전부 실패한다
    const result = await safeFetch("https://example.com");
    expect(result).not.toBeNull();
    expect(result!.response.status).toBe(200);
  }, 20_000);

  it("사설 대상은 null을 반환한다", async () => {
    expect(await safeFetch("http://169.254.169.254/")).toBeNull();
  }, 15_000);
});
