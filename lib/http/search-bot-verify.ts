import { lookup, reverse } from "node:dns/promises";
import { verifiableSearchHosts } from "./agents";

/**
 * 검색 봇 확인 — 이름만으로는 허용하지 않는다(가짜 Googlebot).
 *
 * 검색 엔진들이 안내하는 방법 그대로: IP 의 역방향 DNS 이름이 그 회사 도메인으로 끝나고, 그 이름을 다시 찾으면
 * 같은 IP 가 나와야 한다. DNS 를 매번 부르지 않도록 결과를 프로세스 메모리에 담아 둔다(확인됨 하루, 아님 한 시간).
 * 읽기 한도를 넘었을 때만 부른다 — 보통 요청은 DNS 를 기다리지 않는다.
 */
const POSITIVE_TTL_MS = 24 * 60 * 60_000;
const NEGATIVE_TTL_MS = 60 * 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;
const CACHE_LIMIT = 2_000;

type Resolver = { reverse(ip: string): Promise<string[]>; lookup(host: string): Promise<string[]> };

const systemResolver: Resolver = {
  reverse: (ip) => reverse(ip),
  lookup: async (host) => (await lookup(host, { all: true })).map((entry) => entry.address),
};

const cache = new Map<string, { verified: boolean; until: number }>();
let resolver: Resolver = systemResolver;

/** 시험이 DNS 를 바꿔 끼운다 */
export function setSearchBotResolverForTest(next: Resolver | null): void {
  resolver = next ?? systemResolver;
  cache.clear();
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("dns_timeout")), LOOKUP_TIMEOUT_MS).unref?.()),
  ]);
}

function hostMatches(host: string, suffixes: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return suffixes.some((suffix) => name.endsWith(`.${suffix}`));
}

export async function verifiedSearchBot(userAgent: string | null | undefined, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const suffixes = verifiableSearchHosts(userAgent);
  if (!suffixes) return false;
  const key = `${suffixes[0]}|${ip}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.until > now) return cached.verified;

  let verified = false;
  try {
    const names = (await withTimeout(resolver.reverse(ip))).filter((name) => hostMatches(name, suffixes));
    for (const name of names.slice(0, 3)) {
      const addresses = await withTimeout(resolver.lookup(name));
      if (addresses.includes(ip)) { verified = true; break; }
    }
  } catch {
    verified = false;
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, { verified, until: now + (verified ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return verified;
}
