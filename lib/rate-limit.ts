import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";

/**
 * rate limit — 인스턴스가 늘어도 한도가 하나로 유지되도록 DB에 둔다.
 *
 * 인메모리로 두면 인스턴스마다 버킷이 따로 생겨 2대로 늘리는 순간 실제 한도가 2배가 된다.
 * Redis를 들이는 대신 이미 있는 Postgres를 쓴다 — 한도를 거는 세 경로(등록·검증·수정)는
 * 어차피 그 요청 안에서 DB를 타므로 왕복이 늘지 않는다.
 */

/** 창 갱신과 증가를 한 문장에서 처리한다. 읽고 쓰기를 나누면 동시 요청이 한도를 넘긴다 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  return (await rateLimitWindow(key, limit, windowMs)).allowed;
}

export type RateLimitResult = { allowed: boolean; count: number; retryAfterSeconds: number };

/** rateLimit 과 같은 한 문장 — 막혔을 때 Retry-After 로 알려 줄 남은 창 길이(초)를 함께 돌려준다 */
export async function rateLimitWindow(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const window = sql.raw(`interval '${Math.max(1, Math.round(windowMs / 1000))} seconds'`);

  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt: sql`now() + ${window}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        // 창이 지났으면 1부터 다시 센다
        count: sql`case when ${rateLimits.resetAt} < now() then 1 else ${rateLimits.count} + 1 end`,
        resetAt: sql`case when ${rateLimits.resetAt} < now() then now() + ${window} else ${rateLimits.resetAt} end`,
      },
    })
    .returning({
      count: rateLimits.count,
      retryAfter: sql<number>`greatest(1, ceil(extract(epoch from (${rateLimits.resetAt} - now()))))::int`,
    });

  const count = row?.count ?? 1;
  return { allowed: count <= limit, count, retryAfterSeconds: Math.max(1, Number(row?.retryAfter ?? 1)) };
}

/**
 * 키를 지금부터 durationMs 동안 한도 밖으로 만든다(함정 경로를 부른 IP).
 * 따로 차단 표를 두지 않고 같은 키의 count 를 크게 올린다 — 그래서 막는 쪽은 평소처럼 rateLimitWindow 한 번만 부르고
 * 남은 차단 시간이 그대로 Retry-After 가 된다. 이미 더 긴 창이면 줄이지 않는다.
 */
export async function blockRateLimitKey(key: string, durationMs: number): Promise<void> {
  const window = sql.raw(`interval '${Math.max(1, Math.round(durationMs / 1000))} seconds'`);
  await db
    .insert(rateLimits)
    .values({ key, count: RATE_LIMIT_BLOCKED_COUNT, resetAt: sql`now() + ${window}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`${RATE_LIMIT_BLOCKED_COUNT}`,
        resetAt: sql`greatest(${rateLimits.resetAt}, now() + ${window})`,
      },
    });
}

/** 어떤 한도보다도 큰 값 — integer 열이라 2^31 아래로 둔다 */
export const RATE_LIMIT_BLOCKED_COUNT = 1_000_000_000;

/**
 * 지난 창의 행 청소.
 *
 * 행은 키마다 하나씩 갱신되므로 요청 수만큼 늘지는 않지만, 지나간 클라이언트의 행은 계속
 * 남는다. 특히 클릭 중복 제거가 (제품 × 방문자)마다 키를 하나씩 만들어 여기가 제일 빨리 큰다.
 *
 * 예전에는 rateLimit 안에서 1% 확률로 같이 지웠다. 그러면 등록·검증·수정·클릭 요청 백 번에
 * 한 번은 사용자가 기다리는 동안 DELETE가 돌고, 트래픽이 없으면 아예 청소가 안 된다.
 * 시간마다 도는 click-rollup이 부른다.
 */
export async function pruneExpiredRateLimits(lease?: JobLease): Promise<number> {
  const deleted = await withJobLeaseWrite(lease, tx => tx
    .delete(rateLimits)
    .where(sql`${rateLimits.resetAt} < now() - interval '1 day'`)
    .returning({ key: rateLimits.key }));
  return deleted.length;
}

/**
 * 클라이언트 IP 추출.
 *
 * X-Forwarded-For는 신뢰 프록시가 실제 피어를 오른쪽에 덧붙이는 구조라, 신뢰 hop 수를 알아야
 * 올바른 항목을 고를 수 있다. TRUSTED_PROXY_HOPS로 명시한다.
 *  - 0(기본): 프록시 없음 → 헤더를 아예 신뢰하지 않는다 (스푸핑으로 버킷 회전 불가)
 *  - 1: 앞단 프록시 1개 (Traefik 단독 등) → 마지막 항목
 *  - 2: CDN + 프록시 (Cloudflare + Traefik 등) → 뒤에서 두 번째 항목
 * 헤더 항목 수가 부족하면 가장 왼쪽 값을 쓴다(체인이 예상보다 짧은 경우).
 *
 * Cloudflare Tunnel(cloudflared → Traefik → 웹)에서는 Traefik 이 들어온 X-Forwarded-For 를 버리고 자기 피어
 * (같은 기계의 cloudflared, 사설 주소)만 남기는 일이 흔하다. 그러면 hop 으로 고른 값이 모든 방문자에게 같다.
 * 그때의 실제 방문자는 Cloudflare 가 덮어써 보내는 CF-Connecting-IP 에 있다. 위조 방지 조건:
 *  - TRUST_CF_CONNECTING_IP=1 로 명시했을 때만 본다(기본 꺼짐).
 *  - TRUSTED_PROXY_HOPS ≥ 1 이어야 한다 — 우리 프록시가 기록한 피어를 봐야 Cloudflare 경유인지 가릴 수 있다.
 *  - 그 피어(hop 으로 고른 값)가 루프백·사설(RFC1918)·링크로컬·ULA 주소일 때만 믿는다. 즉 같은 기계/사설망의
 *    cloudflared 가 넘겨준 요청이다. 공인 주소에서 Traefik 에 바로 들어온 요청이 머리를 꾸며도 무시된다.
 *  - 값이 IP 문자열이 아니면 무시한다.
 * 운영은 원 서버가 Tunnel 로만 공개되어 있어야 한다(Traefik 의 80/443 이 인터넷에 직접 열려 있으면 안 된다).
 */
/** 머리만 본다 — 서버 액션은 Request 없이 next/headers 의 머리만 받는다 */
type WithHeaders = { headers: Pick<Headers, "get"> };

function trustedHops(): number {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? "0");
  return Number.isFinite(hops) && hops >= 1 ? Math.floor(hops) : 0;
}

function proxyPeer(req: WithHeaders, hops: number): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (!fwd) return "direct";
  const parts = fwd
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return "direct";

  const index = parts.length - hops;
  return parts[Math.max(0, index)];
}

export function clientIp(req: WithHeaders): string {
  const hops = trustedHops();
  if (hops < 1) return "direct";
  const peer = proxyPeer(req, hops);
  const cloudflare = cloudflareClientIp(req, peer);
  return cloudflare ?? peer;
}

/** CF-Connecting-IP 를 믿어도 되는 요청이면 그 값, 아니면 null — 조건은 clientIp 설명 */
function cloudflareClientIp(req: WithHeaders, peer: string): string | null {
  if (process.env.TRUST_CF_CONNECTING_IP !== "1") return null;
  if (!isPrivateAddress(peer)) return null;
  const value = req.headers.get("cf-connecting-ip")?.trim();
  if (!value || isIP(value) === 0) return null;
  return value;
}

/** 신뢰 프록시가 없으면 모든 사용자를 하나의 `direct` 버킷으로 합치지 않는다. */
export function trustedClientIp(req: WithHeaders): string | null {
  if (trustedHops() < 1) return null;
  const value = clientIp(req);
  return value === "direct" ? null : value;
}

/**
 * 방문자 한 명을 가리키는 공인 IP — 아니면 null.
 * 사설 주소는 프록시 자신이거나 설정이 덜 된 상태라 모든 방문자가 같은 값을 나눈다. 그 값으로 읽기를 막으면
 * 한 명의 수집기 때문에 모두가 429 를 받으므로, 읽기 한도와 함정 차단은 이 값이 있을 때만 건다.
 */
export function publicClientIp(req: WithHeaders): string | null {
  const value = trustedClientIp(req);
  if (!value || isIP(value) === 0 || isPrivateAddress(value)) return null;
  return value;
}

/** 루프백·사설·링크로컬·ULA·미지정 주소. IP 문자열이 아니면 false */
export function isPrivateAddress(value: string): boolean {
  const ip = value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower === "::"
      || /^f[cd][0-9a-f]{2}:/.test(lower)
      || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}
