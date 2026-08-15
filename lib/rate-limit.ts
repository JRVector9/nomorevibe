// 단순 인메모리 rate limit — 단일 인스턴스 MVP 전제
const buckets = new Map<string, { count: number; resetAt: number }>();
const SWEEP_THRESHOLD = 10_000;

/** 만료된 버킷 정리 — Map 무한 증가 방지 */
function sweepExpired(now: number) {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweepExpired(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
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
 */
export function clientIp(req: Request): string {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? "0");
  if (!Number.isFinite(hops) || hops < 1) return "direct";

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
