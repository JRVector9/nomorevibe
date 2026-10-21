import type { SplitTiebreakView } from '@/lib/crawl/gate-split-tiebreak-read';

/** 판가름 결정 기록의 actor — lib/crawl/qwen-direct-review.ts QWEN_V2_AUTO_SOURCE 와 같은 값(그 파일은 서버 전용이라 여기 적고 시험이 견준다) */
export const SPLIT_TIEBREAK_ACTOR = 'qwen-v2-auto';

/** 갈림 보류에 Qwen-v2 도 승인한 것 — 목록 맨 앞에 서고 이 배지를 단다(lib/crawl/gate-split-tiebreak.ts). 발행은 사람이 승인해야 한다 */
export const TIEBREAK_APPROVE_BADGE = 'Qwen-v2 승인 — 발행 후보';

/** 지금 관문 세대에 붙은 승인인가 — 지난 입력의 답에는 배지를 달지 않는다 */
export const tiebreakApproved = (view: SplitTiebreakView | null | undefined): boolean =>
  Boolean(view?.current && view.decision === 'approve');

/** 상세 칸의 한 줄 — 무엇을 답했고 그 답으로 무엇을 했나 */
export function tiebreakSummary(view: SplitTiebreakView): string {
  const answer = view.decision === 'approve' ? '승인' : view.decision === 'reject' ? '거부' : view.decision === 'needs_review' ? '보류' : '답 없음';
  const applied: Record<string, string> = {
    rejected: '세 번째 표로 거부했습니다',
    kept_human: view.decision === 'approve' ? '발행하지 않고 사람 확인을 기다립니다' : '사람 확인으로 남겼습니다',
    held_minority: '다수가 아니어서 사람 확인으로 남겼습니다',
    held_catalog: '카탈로그·디렉터리 거부는 세지 않아 사람 확인으로 남겼습니다',
    switch_off: '답을 받는 사이 판가름이 꺼져 반영하지 않았습니다',
    superseded: '답을 받는 사이 후보가 바뀌어 반영하지 않았습니다',
  };
  return `${answer}${view.applied && applied[view.applied] ? ` · ${applied[view.applied]}` : ''}${view.current ? '' : ' · 지난 입력의 답'}`;
}
