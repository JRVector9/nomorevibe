import type { SharedStore } from "@/lib/cache/shared";

const MINUTE_MS = 60_000;

/**
 * 새로고침(ops_fresh)이 캐시를 건너뛰는 횟수 — 인스턴스당 1분에 limit 번(근거 판정의 분당 3번과 같은 방식).
 * 넘으면 새로고침도 담긴 값을 쓴다(값마다 센 시각이 보인다).
 */
export function freshBudget(limit: number, now: () => number = () => Date.now()) {
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
  const clock = options.now ?? (() => Date.now());
  const max = options.max ?? 4;
  /** measuredAt — 센 시각. 나눠 쓰는 층의 값이 이 인스턴스가 쥔 값보다 이르면 받지 않는다(숫자가 뒤로 가지 않게) */
  const local = new Map<string, { value: T; expiresAt: number; measuredAt: number }>();
  const pending = new Map<string, Promise<T>>();
  const budget = freshBudget(options.freshPerMinute ?? 3, clock);
  const remember = (key: string, value: T, expiresAt: number, measuredAt: number) => {
    local.delete(key);
    local.set(key, { value, expiresAt, measuredAt });
    while (local.size > max) local.delete(local.keys().next().value!);
  };
  const remoteKey = (key: string) => `${options.namespace}:${key}`;

  return async function get(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const bypass = fresh && budget();
    if (!bypass) {
      const remote = options.store ? await options.store.get<{ v: T; measuredAt: number }>(remoteKey(key)) : null;
      const hit = local.get(key);
      const remoteAt = remote && Number.isFinite(remote.value?.measuredAt) ? remote.value.measuredAt : null;
      if (remote && remoteAt !== null && remote.expiresAt > clock() && (!hit || remoteAt >= hit.measuredAt)) {
        remember(key, remote.value.v, remote.expiresAt, remoteAt);
        return remote.value.v;
      }
      if (hit && hit.expiresAt > clock()) return hit.value;
      // Valkey 를 묻는 사이 다른 렌더가 세기 시작했으면 그것을 기다린다
      const started = pending.get(key);
      if (started) return started;
    }
    const loading: Promise<T> = (async () => {
      const measuredAt = clock();
      const value = await load();
      const expiresAt = clock() + options.ttlMs;
      remember(key, value, expiresAt, measuredAt);
      options.store?.set(remoteKey(key), { v: value, measuredAt }, expiresAt);
      return value;
    })().finally(() => { if (pending.get(key) === loading) pending.delete(key); });
    pending.set(key, loading);
    return loading;
  };
}

export type SharedStaleOptions = {
  namespace: string;
  /** 이만큼 지나면 뒤에서 다시 센다(웹 여러 대 중 한 대만, 이 시간에 한 번) */
  ttlMs: number;
  /** 이만큼 지난 값은 버린다(배지 없음 — 0 이 아니라 모름) */
  staleMs: number;
  store?: SharedStore | null;
  now?: () => number;
};

/**
 * 기다리지 않는 공유 값(메뉴 배지처럼 모든 관리자 화면 앞에 서는 수) — 담긴 값을 곧바로 주고, ttl 이 지났으면 뒤에서 다시 센다.
 * 웹 여러 대가 Valkey 로 같은 값을 보고, 다시 세기도 나눠 쓰는 표시(":computing", ttl 동안)로 한 대만 한다 — 화면을 몇 개 열어 두든
 * 다시 세기는 ttl 에 한 번이다. Valkey 가 없으면 인스턴스 값으로(프로세스 안에서 한 번만 센다). 센 시각이 늦은 값을 쓴다.
 * 세기에 실패하면 값을 바꾸지 않는다(표시가 풀릴 때까지 다시 세지 않는다).
 */
export function sharedStale<T>(options: SharedStaleOptions) {
  const clock = options.now ?? (() => Date.now());
  const local = new Map<string, { value: T; at: number }>();
  const running = new Map<string, Promise<void>>();
  const remoteKey = (key: string) => `${options.namespace}:${key}`;

  async function newest(key: string): Promise<{ value: T; at: number } | null> {
    const remote = options.store ? await options.store.get<{ v: T; at: number }>(remoteKey(key)) : null;
    const mine = local.get(key) ?? null;
    const theirs = remote && Number.isFinite(remote.value?.at) ? { value: remote.value.v, at: remote.value.at } : null;
    const best = !mine ? theirs : !theirs ? mine : theirs.at >= mine.at ? theirs : mine;
    if (best && best !== mine) local.set(key, best);
    return best;
  }
  async function claim(key: string): Promise<boolean> {
    if (!options.store) return true;
    const mark = `${remoteKey(key)}:computing`;
    if (await options.store.get<boolean>(mark)) return false;
    options.store.set(mark, true, clock() + options.ttlMs);
    return true;
  }
  function put(key: string, value: T): void {
    const at = clock();
    local.set(key, { value, at });
    options.store?.set(remoteKey(key), { v: value, at }, at + options.staleMs);
  }
  return {
    async get(key: string, load: () => Promise<T>): Promise<T | null> {
      const entry = await newest(key);
      const age = entry ? clock() - entry.at : Infinity;
      if (age >= options.ttlMs && !running.has(key)) {
        const job = (async () => { if (await claim(key)) put(key, await load()); })()
          .catch(() => undefined).finally(() => running.delete(key));
        running.set(key, job);
      }
      return entry && age < options.staleMs ? entry.value : null;
    },
    /** 다른 곳에서 막 센 값(운영센터가 그릴 때 센 긴급 수 등)을 넣는다 */
    put,
    /** 시험 — 뒤에서 세는 것이 끝나기를 기다린다 */
    settled: (key: string) => running.get(key) ?? Promise.resolve(),
  };
}
