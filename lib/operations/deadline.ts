/**
 * 운영센터의 따로 흐르는 조각 하나가 느려도 화면 전체의 다시 읽기를 붙잡지 않게 — 정한 시간 안에 오지 않으면 그 조각만
 * "미확인"으로 그린다. 자동 갱신(router.refresh)은 모든 조각이 올 때까지 끝나지 않아, 복제본 읽기 하나가 밀리면 갱신 전체가 멈췄다.
 * 읽기 자체는 끊지 않는다(문장 시간 제한은 각 읽기가 따로 건다) — 늦게 끝난 값은 캐시에 남아 다음 갱신이 쓴다.
 */
export const SLICE_DEADLINE_MS = 8_000;

export class SliceDeadlineError extends Error {
  constructor(ms: number) { super(`slice_deadline_${ms}ms`); this.name = "SliceDeadlineError"; }
}

export function withDeadline<T>(work: Promise<T>, ms = SLICE_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SliceDeadlineError(ms)), ms); });
  // 늦게 실패한 읽기가 처리되지 않은 거부로 남지 않게
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
