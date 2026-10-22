import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 웹 쓰기 관문(PR15e) — fenced DB 에 붙은 웹은 정책 실행을 만들지도·적용하지도·되돌리지도 않는다 */
const mocks = vi.hoisted(() => ({ admin: vi.fn(), preview: vi.fn(), start: vi.fn(), apply: vi.fn(), undoStart: vi.fn(), undo: vi.fn() }));
vi.mock('@/lib/operations/dr/epoch', async (original) => ({ ...await original<typeof import('@/lib/operations/dr/epoch')>(),
  readWriterFence: async () => ({ state: 'fenced' }) }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/crawl/audit-policy', () => ({ previewAuditPolicy: mocks.preview, startAuditPolicyRun: mocks.start, applyAuditPolicyChunk: mocks.apply,
  startAuditPolicyUndo: mocks.undoStart, undoAuditPolicyChunk: mocks.undo, policyRunExceptions: vi.fn() }));

import { applyPolicyChunkAction, previewAuditPolicyAction, startPolicyRunAction, startPolicyUndoAction, undoPolicyChunkAction } from '@/app/(operator)/admin/audit/policy-actions';
import { EMPTY_POLICY_FILTER } from '@/lib/crawl/audit-policy-filter';
import { DrWriterFencedError } from '@/lib/operations/dr/epoch';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.preview.mockResolvedValue({ eligible: 0 });
});

describe('정책 처리 — DR writer fence', () => {
  it('쓰는 액션은 모두 관문에서 거절되고 라이브러리를 부르지 않는다', async () => {
    await expect(startPolicyRunAction({ filter: EMPTY_POLICY_FILTER, action: 'keep', expected: 1, note: '', keepDays: 90 })).rejects.toBeInstanceOf(DrWriterFencedError);
    await expect(applyPolicyChunkAction(1)).rejects.toBeInstanceOf(DrWriterFencedError);
    await expect(startPolicyUndoAction(1)).rejects.toBeInstanceOf(DrWriterFencedError);
    await expect(undoPolicyChunkAction(1)).rejects.toBeInstanceOf(DrWriterFencedError);
    for (const fn of [mocks.start, mocks.apply, mocks.undoStart, mocks.undo]) expect(fn).not.toHaveBeenCalled();
  });

  it('미리보기도 관리자 액션이라 같은 관문을 지난다 — fenced DB 에서는 적용할 수 없으니 미리보지도 않는다', async () => {
    await expect(previewAuditPolicyAction({ filter: EMPTY_POLICY_FILTER, action: 'keep' })).rejects.toBeInstanceOf(DrWriterFencedError);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
