import type { SecondOpinionView } from '@/lib/crawl/audit-second-opinions';

const SECOND_LABELS = { approve: '승인', reject: '거절', needs_review: '판단 보류' } as const;

/** 'grok-4-fast' → 'grok' — 배지에는 모델 갈래만, 전체 이름은 마우스를 올리면 */
export const modelFamily = (model: string) => model.split(/[-\s/:]/)[0] || model;

/** 두 번째 의견 한 줄 — 'grok: 거절 0.90', 'grok: 승인'(승인은 확신을 적지 않는다). 줄 배지와 묶어 내리기 확인 창이 같이 쓴다 */
export function secondOpinionLabel(opinion: SecondOpinionView): string {
  const confidence = opinion.decision !== 'approve' && typeof opinion.confidence === 'number' ? ` ${opinion.confidence.toFixed(2)}` : '';
  return `${modelFamily(opinion.model)}: ${SECOND_LABELS[opinion.decision] ?? opinion.decision}${confidence}`;
}
