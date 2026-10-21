import { sql } from "drizzle-orm";
import type { SharedStore } from "@/lib/cache/shared";
import { readReplicaOrHold, type ReplicaRead } from "./replica-hold";

type ReplicaDb = Parameters<Parameters<typeof readReplicaOrHold>[1]>[0];

/** 복제본의 DB 시계(UTC ISO) — 새 숫자 옆에 "기준 08:44:02 (DB)"로 단다. 인스턴스 시계가 아니다 */
export const DB_CLOCK_SQL = sql`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** 보류(읽지 못함)를 담아 두는 시간 — 그동안 렌더마다 복제본을 다시 두드리지 않는다. 새로고침은 건너뛸 수 있다 */
const HOLD_TTL_MS = 15_000;
const MINUTE_MS = 60_000;

export type ReplicaCacheOptions = {
  /** 읽다 던진 오류를 남길 로그 이벤트 */
  event: string;
  ttlMs: number;
  /** 새로고침(ops_fresh)이 이 캐시를 건너뛰는가 — 흐름 15초·근거 20초·60초 집계(분당 상한과 함께). 10분(7일) 캐시는 건너뛰지 않는다 */
  bypass: boolean;
  /** 인스턴스당 1분 안의 읽기 상한(새로고침 포함). 넘으면 담긴 값을 그대로 준다(기준 시각이 보인다) */
  perMinute?: number;
  /**
   * 웹 여러 대가 함께 쓰는 층(Valkey, lib/cache/shared.ts) — 주면 읽을 때마다 먼저 묻고, DB 시각이 같거나 늦은 값이면 그 만료를 따른다.
   * 성공한 읽기만 나눈다(보류는 이 인스턴스의 일이다). 없거나 닿지 않으면 인스턴스 캐시만 쓴다.
   */
  shared?: { store: SharedStore | null; namespace: string };
  now?: () => number;
};

/**
 * 운영센터 v8 새 숫자의 인스턴스 캐시 — 복제본에서만 읽는다(readReplicaOrHold, 주 DB 로 넘기지 않는다).
 *
 * 값은 DB 시각(at)을 지닌다. 새로고침이 캐시를 건너뛰면 그 결과를 캐시에 다시 쓰고 만료를 그 시각부터 센다 —
 * 10초 뒤 자동 갱신이 더 오래된 값을 보이지 않게(v8 검토 L3). 담긴 값보다 DB 시각이 이른 결과로는 덮지 않는다.
 * 보류는 이 렌더에만 보이고, 아직 유효한 값을 지우지 않는다. 열쇠가 바뀌면(이번 시 범위 등) 새로 센다. 같은 열쇠는 동시에 한 번만 읽는다.
 * shared 를 주면 웹 여러 대가 같은 값을 보인다 — 인스턴스마다 따로 담으면 요청이 닿는 웹마다 숫자가 앞뒤로 흔들렸다.
 */
export function replicaCache<T extends { at: string }>(options: ReplicaCacheOptions) {
  const clock = options.now ?? (() => Date.now());
  let entry: { key: string; expiresAt: number; result: ReplicaRead<T> } | null = null;
  let inflight: { key: string; promise: Promise<ReplicaRead<T>> } | null = null;
  const starts: number[] = [];
  const shared = options.shared?.store ? { store: options.shared.store, key: (key: string) => `${options.shared!.namespace}:${key}` } : null;

  /** 나눠 쓰는 층의 값 — 담긴 값보다 DB 시각이 이르면 받지 않는다(숫자가 뒤로 가지 않게) */
  async function adoptShared(key: string): Promise<ReplicaRead<T> | null> {
    const remote = shared ? await shared.store.get<T>(shared.key(key)) : null;
    if (!remote || remote.expiresAt <= clock() || !Number.isFinite(Date.parse(remote.value?.at))) return null;
    const current = entry?.key === key ? entry : null;
    if (current?.result.ok && Date.parse(current.result.value.at) > Date.parse(remote.value.at)) return null;
    entry = { key, expiresAt: remote.expiresAt, result: { ok: true, value: remote.value } };
    return entry.result;
  }

  return function read(key: string, load: (replica: ReplicaDb) => Promise<T>, fresh = false): Promise<ReplicaRead<T>> {
    const now = clock();
    while (starts.length && now - starts[0] >= MINUTE_MS) starts.shift();
    const budget = options.perMinute === undefined || starts.length < options.perMinute;
    const skip = fresh && options.bypass && budget;
    if (inflight?.key === key && (shared || skip)) return inflight.promise;
    if (shared && !skip) return adoptShared(key).then((adopted) => adopted ?? local(key, load, false));
    return local(key, load, skip);
  };

  /** 이 인스턴스의 값 또는 새로 읽기 — skip 이면 담긴 값을 건너뛴다(새로고침) */
  function local(key: string, load: (replica: ReplicaDb) => Promise<T>, skip: boolean): Promise<ReplicaRead<T>> {
    const now = clock();
    while (starts.length && now - starts[0] >= MINUTE_MS) starts.shift();
    const budget = options.perMinute === undefined || starts.length < options.perMinute;
    const cached = entry?.key === key ? entry : null;
    if (cached && now < cached.expiresAt && !skip) return Promise.resolve(cached.result);
    if (inflight?.key === key) return inflight.promise;
    if (cached && !budget) return Promise.resolve(cached.result);
    starts.push(now);
    const promise = readReplicaOrHold(options.event, load).then((result) => {
      const settled = clock();
      const current = entry?.key === key ? entry : null;
      if (!result.ok) {
        if (!current?.result.ok || settled >= current.expiresAt) entry = { key, expiresAt: settled + Math.min(options.ttlMs, HOLD_TTL_MS), result };
        return result;
      }
      if (current?.result.ok && Date.parse(current.result.value.at) > Date.parse(result.value.at)) return current.result;
      entry = { key, expiresAt: settled + options.ttlMs, result };
      shared?.store.set(shared.key(key), result.value, entry.expiresAt);
      return result;
    }).finally(() => { if (inflight?.promise === promise) inflight = null; });
    inflight = { key, promise };
    return promise;
  }
}
