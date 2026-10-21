import type { SplitTiebreakView } from '@/lib/crawl/gate-split-tiebreak-read';

/** 판가름 결정 기록의 actor — lib/crawl/qwen-direct-review.ts QWEN_V2_AUTO_SOURCE 와 같은 값(그 파일은 서버 전용이라 여기 적고 시험이 견준다) */
export const SPLIT_TIEBREAK_ACTOR = 'qwen-v2-auto';

/** 갈림 보류에 Qwen-v2 도 승인한 것 — 목록 맨 앞에 서고 이 배지를 단다(lib/crawl/gate-split-tiebreak.ts). 발행은 사람이 승인해야 한다 */
export const TIEBREAK_APPROVE_BADGE = 'Qwen-v2 승인 — 발행 후보';

/** Qwen-v2 는 거부했지만 DeepSeek 이 거부로 확인하지 않았다(승인·판단 보류·문턱 아래·실패) — 사람이 두 판단의 엇갈림을 본다 */
export const TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE = 'Qwen 거부 · DeepSeek 확인 안 됨';
/** Qwen-v2 거부 — DeepSeek 확인을 기다린다(사람 검토 잡이 M3 를 쓰는 차례에 묻는다) */
export const TIEBREAK_AWAITING_BADGE = 'Qwen 거부 · DeepSeek 확인 대기';
/** 두 모델이 따로 거부했지만 오늘(KST) 자동 거부 상한에 닿아 사람에게 남겼다 */
export const TIEBREAK_DAILY_CAP_BADGE = 'Qwen·DeepSeek 거부 · 하루 상한';

/** 지금 관문 세대에 붙은 승인인가 — 지난 입력의 답에는 배지를 달지 않는다 */
export const tiebreakApproved = (view: SplitTiebreakView | null | undefined): boolean =>
  Boolean(view?.current && view.decision === 'approve');

export type TiebreakBadge = { label: string; tone: 'up' | 'warn' | 'neutral'; title: string };

/** 목록의 배지 — 지금 관문 세대의 판가름에만. 승인 · DeepSeek 확인 대기 · DeepSeek 확인 안 됨 · 하루 상한 */
export function tiebreakBadge(view: SplitTiebreakView | null | undefined): TiebreakBadge | null {
  if (!view?.current) return null;
  const qwen = `${view.model}${typeof view.confidence === 'number' ? ` · 확신 ${view.confidence.toFixed(2)}` : ''}`;
  const deepseek = view.deepseek
    ? ` · DeepSeek ${view.deepseek.decision ? `${view.deepseek.decision}${typeof view.deepseek.confidence === 'number' ? ` ${view.deepseek.confidence.toFixed(2)}` : ''}`
      : view.deepseek.errorCode ? `실패 ${view.deepseek.errorCode}` : '대기'}` : '';
  const title = `갈림 판가름(관문 2차 반대 뒤 세 번째 표) · ${qwen}${deepseek}`;
  if (view.decision === 'approve') return { label: TIEBREAK_APPROVE_BADGE, tone: 'up', title };
  if (view.decision !== 'reject') return null;
  if (view.applied === 'held_daily_cap') return { label: TIEBREAK_DAILY_CAP_BADGE, tone: 'warn', title };
  if (view.applied === 'held_deepseek' || view.applied === 'held_deepseek_error') return { label: TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE, tone: 'warn', title };
  if (view.applied === 'awaiting_deepseek') {
    return view.deepseek?.errorCode ? { label: TIEBREAK_DEEPSEEK_UNCONFIRMED_BADGE, tone: 'warn', title } : { label: TIEBREAK_AWAITING_BADGE, tone: 'neutral', title };
  }
  return null;
}

/** 상세 칸의 한 줄 — 무엇을 답했고 그 답으로 무엇을 했나 */
export function tiebreakSummary(view: SplitTiebreakView): string {
  const answer = view.decision === 'approve' ? '승인' : view.decision === 'reject' ? '거부' : view.decision === 'needs_review' ? '보류' : '답 없음';
  const applied: Record<string, string> = {
    rejected: '두 모델(Qwen-v2·DeepSeek)이 따로 거부해 닫았습니다',
    awaiting_deepseek: view.deepseek?.errorCode ? `DeepSeek 확인이 실패해(${view.deepseek.errorCode}) 다시 묻습니다 — 그동안 사람이 정해도 됩니다`
      : 'DeepSeek 확인을 기다립니다 — 둘 다 거부해야 닫습니다',
    held_deepseek: 'DeepSeek 이 거부로 확인하지 않아 사람 확인으로 남겼습니다',
    held_deepseek_error: 'DeepSeek 확인을 받지 못해 사람 확인으로 남겼습니다',
    held_daily_cap: '두 모델이 거부했지만 오늘(KST) 하루 자동 거부 상한에 닿아 사람 확인으로 남겼습니다',
    held_low_confidence: '확신이 0.90 아래라 사람 확인으로 남겼습니다',
    held_not_enforce: '적용 모드가 아니라 사람 확인으로 남겼습니다',
    kept_human: view.decision === 'approve' ? '발행하지 않고 사람 확인을 기다립니다' : '사람 확인으로 남겼습니다',
    held_minority: '다수가 아니어서 사람 확인으로 남겼습니다',
    held_catalog: '카탈로그·디렉터리 거부는 세지 않아 사람 확인으로 남겼습니다',
    switch_off: '답을 받는 사이 판가름이 꺼져 반영하지 않았습니다',
    superseded: '답을 받는 사이 후보가 바뀌어 반영하지 않았습니다',
  };
  return `${answer}${view.applied && applied[view.applied] ? ` · ${applied[view.applied]}` : ''}${view.current ? '' : ' · 지난 입력의 답'}`;
}

/** 상세 칸의 DeepSeek 확인 한 줄 — 없으면 null */
export function tiebreakDeepseekLine(view: SplitTiebreakView): string | null {
  const deepseek = view.deepseek;
  if (!deepseek) return null;
  if (!deepseek.decision) return deepseek.errorCode ? `DeepSeek 확인 실패 · ${deepseek.errorCode}` : 'DeepSeek 확인 대기';
  const answer = deepseek.decision === 'approve' ? '승인' : deepseek.decision === 'reject' ? '거부' : '보류';
  return `DeepSeek ${answer}${typeof deepseek.confidence === 'number' ? ` · 확신 ${deepseek.confidence.toFixed(2)}` : ''}${deepseek.model ? ` · ${deepseek.model}` : ''}`;
}
