import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 서버 액션은 DB 를 쓴다 — 이 시험은 줄 모양만 본다(쓰기는 tests/integration/audit-second-opinion-auto.test.ts)
vi.mock('@/app/(operator)/admin/review/actions', () => ({ resolvePublishedSecondReview: vi.fn() }));

import { PublishedSecondReviews, type PublishedSecondRow } from '@/app/(operator)/admin/review/PublishedSecondReviews';

const row = (id: number, over: Partial<PublishedSecondRow> = {}): PublishedSecondRow => ({ id, slug: `p-${id}`, repo: `o/p-${id}`, decision: 'reject',
  confidence: 0.9, reason: 'Only a sign-in form.', reasonKo: '로그인 창만 있다', trigger: 'sample', signals: [], ...over });

describe('공개분 확인 — Qwen-v2 판단', () => {
  it('Qwen-v2 도 거절한 줄에는 «Qwen-v2도 거절» 배지와 그 사유를, 판단 보류에는 그 배지를 붙인다. 아직 안 본 줄에는 없다', () => {
    const html = renderToStaticMarkup(<PublishedSecondReviews rows={[
      row(1, { qwen: { decision: 'reject', confidence: 0.95, reason: 'Placeholder page with no product.', reasonKo: '제품 없는 준비 중 화면' } }),
      row(2, { qwen: { decision: 'needs_review', confidence: 0.5, reason: null, reasonKo: null } }),
      row(3),
    ]} />);
    const rows = html.split('<tr class="border-t').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Qwen-v2도 거절');
    expect(rows[0]).toMatch(/0\.95/);
    expect(rows[0]).toContain('제품 없는 준비 중 화면');
    expect(rows[1]).toContain('Qwen-v2 판단 보류');
    expect(rows[2]).not.toContain('Qwen-v2');
    // 내리기·유지는 그대로 사람이 누른다
    for (const line of rows) expect(line).toMatch(/value="ban"[^>]*name="decision"[^>]*>내리기[\s\S]*value="keep"[^>]*name="decision"[^>]*>유지/);
  });
});
