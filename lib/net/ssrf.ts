import { promises as dns } from "node:dns";
import net from "node:net";

/**
 * SSRF 정책 — 어떤 목적지가 금지인지만 정의한다 (I/O 없음, 판정만).
 * 실제 fetch에서 이 정책을 두 번 적용한다: 요청 전 URL 검사 + 소켓 연결 시점 DNS 검사.
 */

export function allowPrivate(): boolean {
  return process.env.ALLOW_PRIVATE_URLS === "1";
}

/** 사설·루프백·링크로컬·예약(클라우드 메타데이터 포함) IP 판정 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || // 169.254.169.254 등 메타데이터 엔드포인트
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("64:ff9b::") ||
    v6.startsWith("100:") ||
    v6.startsWith("2001:db8:") ||
    /^fe[89a-f]/.test(v6) ||
    v6.startsWith("ff") ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("::ffff:") // v4-mapped은 통째로 차단
  );
}

/** 호스트명 자체로 판정 가능한 사설 대상 */
export function isPrivateHostname(host: string): boolean {
  return host === "localhost" || host.endsWith(".local") || host.endsWith(".internal");
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * 요청 전 1차 검사 — 호스트를 DNS 조회해 사설 대역으로 향하는지 본다.
 * ALLOW_PRIVATE_URLS=1(로컬 개발)에서는 통과.
 */
export async function assertPublicUrl(url: string): Promise<GuardResult> {
  if (allowPrivate()) return { ok: true };

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, reason: "URL 형식이 올바르지 않습니다" };
  }
  if (isPrivateHostname(host)) {
    return { ok: false, reason: "사설 호스트는 등록할 수 없습니다" };
  }

  const ips: string[] = [];
  if (net.isIP(host)) {
    ips.push(host);
  } else {
    try {
      const result = await dns.lookup(host, { all: true });
      ips.push(...result.map((r) => r.address));
    } catch {
      return { ok: false, reason: "도메인을 확인할 수 없습니다" };
    }
  }
  if (ips.length === 0 || ips.some(isPrivateIp)) {
    return { ok: false, reason: "사설 IP 대역으로 향하는 URL은 등록할 수 없습니다" };
  }
  return { ok: true };
}
