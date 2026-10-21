/**
 * 다시 읽은 목록(자동 갱신·새로고침·처리 뒤) 위에서 사람이 고른 것을 지키는 규칙 — 결정하는 화면(심사 큐·내려달라는 요청)이 함께 쓴다.
 *
 * 고른 줄이 빠지면 같은 자리의 다른 줄로 말없이 바꾸지 않는다: 그대로 결정 단축키를 누르면 읽지 않은 것을 결정하게 된다.
 * 일괄로 고른 줄은 고른 때의 판(해시)을 들고 있다가 그대로 보낸다 — 다시 읽은 판을 보내면 서버의 "본 뒤에 바뀜" 검사가 헛돈다.
 */

/** 고른 것이 다시 읽은 목록에 있는가. 처음 열 때(active null)만 첫 줄로 선다 — 빠졌으면 current 없이 lost */
export function resolveSelection<T>(order: readonly T[], active: string | number | null, keyOf: (item: T) => string | number):
  { current: T | null; lost: boolean } {
  if (active === null) return { current: order[0] ?? null, lost: false };
  const current = order.find((item) => keyOf(item) === active) ?? null;
  return { current, lost: current === null && order.length > 0 };
}

/**
 * 일괄로 고른 것과 다시 읽은 목록을 맞춘다. snapshots 는 고른 때의 줄(판 포함), entries 는 지금 목록.
 * - send: 지금도 목록에 있고 판이 같은 것 — 고른 때의 줄을 그대로 보낸다
 * - changed: 목록에 있는데 판이 바뀐 것 — 고른 것을 풀어(체크 해제로 보이고) 다시 고르게 한다
 * - gone: 목록에서 빠진 수(처리됐거나 구간이 바뀜)
 */
export function reconcileSnapshots<T>(snapshots: ReadonlyMap<number, T>, entries: readonly T[],
  keyOf: (item: T) => number, versionOf: (item: T) => string, allowed: (item: T) => boolean = () => true):
  { send: T[]; changed: Set<number>; gone: number } {
  const current = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const send: T[] = [];
  const changed = new Set<number>();
  let gone = 0;
  for (const [id, snapshot] of snapshots) {
    const now = current.get(id);
    if (!now || !allowed(now)) { gone++; continue; }
    if (versionOf(now) !== versionOf(snapshot)) changed.add(id);
    else send.push(snapshot);
  }
  return { send, changed, gone };
}
