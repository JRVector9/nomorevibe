import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/admin', () => ({ currentAdmin: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: vi.fn(), saveSettings: vi.fn(), changeReviewMode: vi.fn() }));

import { ReviewModeForm } from '@/app/admin/review/ReviewModeForm';
import { SecondVoterSwitch } from '@/app/admin/review/SecondVoterSwitch';
import { voterChoices } from '@/app/admin/review/voters';

/**
 * 발행 보호·2차 표 바로 바꾸기는 크롤 설정 폼 안(#second)에 그린다(2026-10-08 UX 감사 ADM-24).
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

  it('2차 표 바꾸기도 form·name 없이 그리고, 지금 표를 고른 채로 둔다', () => {
    const current = { provider: 'grok-cli', model: 'grok-4.7' };
    const html = renderToStaticMarkup(<SecondVoterSwitch current={current} choices={voterChoices(['qwen3-coder:30b'], current, null)} gatewayReachable />);
    expect(html).not.toMatch(/<form|name="/);
    expect(html).toMatch(/<option value="grok-cli\|grok-4.7" selected="">/);
  });
});
