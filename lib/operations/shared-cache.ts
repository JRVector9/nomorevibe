import type { SharedStore } from "@/lib/cache/shared";

const MINUTE_MS = 60_000;

/**
 * 새로고침(ops_fresh)이 캐시를 건너뛰는 횟수 — 인스턴스당 1분에 limit 번(근거 판정의 분당 3번과 같은 방식).
 * 넘으면 새로고침도 담긴 값을 쓴다(값마다 센 시각이 보인다).
 */
export function freshBudget(limit: number, now: () => number = Date.now) {
  const starts: number[] = [];
  return () => {
    const at = now();
    while (starts.length && at - starts[0] >= MINUTE_MS) starts.shift();
    if (starts.length >= limit) return false;
    starts.push(at);
    return true;
  };
}

export type SharedLoaderOptions = {
  /** Valkey 열쇠 이름 칸(릴리스는 lib/cache/shared.ts 가 붙인다) */
  namespace: string;
  ttlMs: number;
  /** 웹 여러 대가 함께 쓰는 층 — 없으면(시험) 인스턴스 캐시만 */
  store?: SharedStore | null;
  /** 새로고침이 두 층을 건너뛰는 인스턴스당 1분 상한 */
  freshPerMinute?: number;
  /** 인스턴스 층에 남기는 열쇠 수 */
  max?: number;
  now?: () => number;
};

/**
 * 운영 화면의 1분 집계 캐시 — 웹 여러 대가 같은 값을 보이게 Valkey 를 먼저 본다(lib/cache/shared.ts, 번역 진행과 같은 층).
 *
 * 전에는 인스턴스마다 따로 60초 담아(dashboard.ts cachedLoader), 요청이 m3·mini 웹에 번갈아 닿으면 숫자가 60초마다 계단처럼
 * 바뀌고 앞뒤로 흔들렸다. 지금은 렌더마다 Valkey 를 한 번 묻고(150ms 안에 못 받으면 버린다), 거기 값이 있으면 그 만료를 따른다.
 * Valkey 가 없거나 닿지 않으면 지금처럼 인스턴스 값을 쓴다.
 *
 * fresh(수동 새로고침)는 1분에 freshPerMinute 번까지 두 층을 건너뛰고 새로 세어 두 층에 다시 쓴다 — 다른 웹도 그 값을 본다.
 * 같은 열쇠를 동시에 부르면 한 번만 센다(이미 세는 중인 값은 새로고침에도 충분히 새것이다). 실패는 담지 않는다.
 */
export function sharedLoader<T>(options: SharedLoaderOptions) {
  const clock = options.now ?? Date.now;
  const max = options.max ?? 4;
  const local = new Map<string, { value: T; expiresAt: number }>();
  const pending = new Map<string, Promise<T>>();
  const budget = freshBudget(options.freshPerMinute ?? 3, clock);
  const remember = (key: string, value: T, expiresAt: number) => {
    local.delete(key);
    local.set(key, { value, expiresAt });
    while (local.size > max) local.delete(local.keys().next().value!);
  };
  const remoteKey = (key: string) => `${options.namespace}:${key}`;

  return async function get(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const bypass = fresh && budget();
    if (!bypass) {
      const remote = options.store ? await options.store.get<T>(remoteKey(key)) : null;
      if (remote && remote.expiresAt > clock()) {
        remember(key, remote.value, remote.expiresAt);
        return remote.value;
      }
      const hit = local.get(key);
      if (hit && hit.expiresAt > clock()) return hit.value;
      // Valkey 를 묻는 사이 다른 렌더가 세기 시작했으면 그것을 기다린다
      const started = pending.get(key);
      if (started) return started;
    }
    const loading: Promise<T> = (async () => {
      const value = await load();
      const expiresAt = clock() + options.ttlMs;
      remember(key, value, expiresAt);
      options.store?.set(remoteKey(key), value, expiresAt);
      return value;
    })().finally(() => { if (pending.get(key) === loading) pending.delete(key); });
    pending.set(key, loading);
    return loading;
  };
}
