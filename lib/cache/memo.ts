/**
 * 웹 프로세스 안의 짧은 읽기 캐시(2026-10-06 동시 접속 작업 P1).
 *
 * 홈 한 번이 개수 3종(각 20~50ms)과 목록을, 상세 한 번이 제품별 쿼리 약 17개를 돌린다. 같은 값을 여러 방문자가
 * 동시에 물으므로 짧게 들고 있으면 DB 일이 크게 준다.
 * - 같은 열쇠를 동시에 부르면 한 번만 읽는다.
 * - 만료되면 지난 값을 주지 않고 다시 읽는다. 내린 제품은 Cloudflare 가 60초 뒤 한 번 더 지우는데(cdn-purge),
 *   그때 원 서버가 새 값을 주려면 여기 수명이 그보다 짧고 지난 값을 내놓지 않아야 한다.
 * - 실패는 담지 않는다. 열쇠 수는 max 로 묶는다(오래된 것부터 버린다).
 */

type Entry<T> = { value: T; expiresAt: number };

export type Memo<T> = {
  get: (key: string, load: () => Promise<T>) => Promise<T>;
  clear: () => void;
};

const registry = new Set<Memo<unknown>>();

export function createMemo<T>(options: { ttlMs: number; max: number; now?: () => number }): Memo<T> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<T>>();
  const pending = new Map<string, Promise<T>>();

  const memo: Memo<T> = {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value);
      const inflight = pending.get(key);
      if (inflight) return inflight;
      const loading = load().then((value) => {
        entries.delete(key);
        entries.set(key, { value, expiresAt: now() + options.ttlMs });
        while (entries.size > options.max) entries.delete(entries.keys().next().value!);
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, loading);
      return loading;
    },
    clear() {
      entries.clear();
      pending.clear();
    },
  };
  registry.add(memo as Memo<unknown>);
  return memo;
}

/** 테스트가 모듈에 남은 값을 다음 테스트로 넘기지 않게 */
export function clearAllMemos(): void {
  for (const memo of registry) memo.clear();
}

/** 인자를 열쇠로 — Date 는 ISO, undefined 는 빠진다 */
export function memoKey(...parts: unknown[]): string {
  return JSON.stringify(parts);
}
