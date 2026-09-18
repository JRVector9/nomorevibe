'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { cancelProductAudit, keepAuditedProduct, removeAuditedProduct, startProductAudit } from '@/lib/crawl/product-audit';
import { logger } from '@/lib/observability/logger';

export type AuditActionState = { error?: string; message?: string } | null;
const UNAUTHORIZED = { error: '권한이 없습니다. 다시 로그인해주세요.' };

/**
 * 감사가 짚은 제품 하나를 내리거나 그대로 둔다.
 *
 * 한 번에 한 제품이다. 폼이 제품을 둘 이상 싣고 오면 아무것도 하지 않는다 — 화면에 일괄 버튼이
 * 없어도 요청은 손으로 만들 수 있다. 1차 심사 글의 실측 정확도는 85%다(2026-09-18 홀드아웃,
 * 결정한 26건 중 22건). 여러 건을 한 번에 내리면 모델이 틀린 몫이 사람 눈을 거치지 않고 같이 내려간다.
 */
export async function decideAuditFinding(_previous: AuditActionState, form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const items = form.getAll('item');
  const slugs = form.getAll('slug');
  const decision = form.get('decision');
  const itemId = Number(items[0]);
  const slug = String(slugs[0] ?? '');
  if (items.length !== 1 || slugs.length !== 1 || !Number.isSafeInteger(itemId) || itemId <= 0 || !slug
    || (decision !== 'remove' && decision !== 'keep')) return { error: '한 번에 한 제품만 처리합니다. 새로고침해주세요.' };
  const result = decision === 'remove'
    ? await removeAuditedProduct({ itemId, slug, by: admin.login })
    : await keepAuditedProduct({ itemId, slug, by: admin.login, note: String(form.get('note') ?? '') });
  if (!result.ok) return { error: result.error };
  logger.info('admin.product_audit_decided', { slug, decision, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/products');
  return { message: decision === 'remove' ? '내렸습니다.' : '그대로 둡니다.' };
}

/** 새 감사를 연다. 아무것도 내리지 않는다 — 사람이 볼 새 목록을 만들 뿐이다 */
export async function startAudit(_previous: AuditActionState, form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const result = await startProductAudit({
    startedBy: admin.login, reason: String(form.get('reason') ?? ''), reauditKept: form.get('reauditKept') === 'on',
  });
  if (!result.ok) return { error: result.error };
  logger.info('admin.product_audit_started', { campaign: result.campaignId, enrolled: result.enrolled, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/status');
  return { message: `${result.enrolled.toLocaleString('ko-KR')}건을 올렸습니다. 유지 판정으로 뺀 것 ${result.keptSkipped.toLocaleString('ko-KR')}건.` };
}

/** 진행 중인 감사를 멈춘다. 지금까지 찾은 것은 그대로 남는다 */
export async function cancelAudit(): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const cancelled = await cancelProductAudit();
  logger.info('admin.product_audit_cancelled', { cancelled, login: admin.login });
  revalidatePath('/admin/audit');
  return cancelled ? { message: '중단했습니다.' } : { error: '진행 중인 감사가 없습니다.' };
}
