import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/admin', () => ({ currentAdmin: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: vi.fn(), saveSettings: vi.fn(), changeReviewMode: vi.fn() }));

import { ReviewModeForm } from '@/app/(operator)/admin/review/ReviewModeForm';
import { TaskRanksPointer } from '@/app/(operator)/admin/settings/TaskRanksPointer';

/**
 * 발행 보호·(예전 2차 표 바로 바꾸기 자리의) 「작업 ↔ 모델」 안내는 크롤 설정 폼 안(#second)에 그린다(2026-10-08 UX 감사 ADM-24, PR C1).
 * 폼 안이라 <form> 이 있으면 중첩 form 이 되고, name 이 있으면 설정 저장에 섞여 들어간다.
 * 끄기의 확인 창(ADM-06)은 고르는 상호작용이라 e2e(worker-review-admin.spec.ts)가 본다.
 */
describe('설정 화면의 바로 바꾸기 손잡이', () => {
  it('발행 보호는 form·name 없이 그리고, 지금 모드와 세 선택지를 보인다', () => {
    const html = renderToStaticMarkup(<ReviewModeForm mode="enforce" ready />);
    expect(html).not.toMatch(/<form|name="/);
    expect(html).toContain('발행 보호 · AI 리뷰 운영 모드');
    expect(html).toContain('지금 적용');
    expect(html).toContain('끄기 — AI 발행 보호 해제');
    // 끄기를 고르기 전에는 확인 창을 여는 단추가 없다 — 사유를 적고 바로 바꾸는 단추만
    expect(html).toContain('모드 변경');
    expect(html).not.toContain('발행 보호 끄기…');
  });

  it('배포 확인 전에는 관측·적용을 고를 수 없다', () => {
    const html = renderToStaticMarkup(<ReviewModeForm mode="off" ready={false} />);
    expect(html).toMatch(/<option value="observe" disabled="">/);
    expect(html).toMatch(/<option value="enforce" disabled="">/);
  });

  // PR C1: 2차 표 바로 바꾸기(SecondVoterSwitch)는 없앴다 — 2차 투표자는 「작업 ↔ 모델」 투표자 칸 순위뿐이고, 그 자리에는 읽기 전용 안내만 둔다
  it('2차 표 바꾸기 자리의 안내도 form·name·고르기 없이 그리고, 「작업 ↔ 모델」로 보낸다', () => {
    const html = renderToStaticMarkup(<TaskRanksPointer what="2차 투표 모델" />);
    expect(html).not.toMatch(/<form|name="|<select|<option/);
    expect(html).toContain('data-task-ranks-pointer="true"');
    expect(html).toContain('href="/admin/models#tasks"');
    expect(html).toContain('2차 투표 모델은(는)');
  });
});
