'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { cancelProductAudit, GROUP_REMOVE_MAX, keepAuditedProduct, removeAuditedProduct, removeAuditedProducts,
  startProductAudit } from '@/lib/crawl/product-audit';
import { logger } from '@/lib/observability/logger';
import { recordAdminAction, recordAdminActions } from '@/lib/operations/admin-log';

export type AuditActionState = { error?: string; message?: string } | null;
/** 묶어 내리기 결과 — 화면이 알림으로 요약한다 */
export type AuditGroupResult = { error: string } | { removed: number; failed: number };
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
  await recordAdminAction(admin.login, { action: `audit-${decision}`, target: slug,
    detail: { itemId, note: String(form.get('note') ?? '') || null }, ok: result.ok, error: result.ok ? null : result.error });
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
  const reason = String(form.get('reason') ?? '');
  const reauditKept = form.get('reauditKept') === 'on';
  const result = await startProductAudit({ startedBy: admin.login, reason, reauditKept });
  await recordAdminAction(admin.login, result.ok
    ? { action: 'audit-start', target: `campaign:${result.campaignId}`,
      detail: { reason, reauditKept, enrolled: result.enrolled, keptSkipped: result.keptSkipped } }
    : { action: 'audit-start', target: 'product_audit', detail: { reason, reauditKept }, ok: false, error: result.error });
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
  await recordAdminAction(admin.login, { action: 'audit-cancel', target: 'product_audit', ok: cancelled,
    error: cancelled ? null : '진행 중인 감사가 없습니다' });
  logger.info('admin.product_audit_cancelled', { cancelled, login: admin.login });
  revalidatePath('/admin/audit');
  return cancelled ? { message: '중단했습니다.' } : { error: '진행 중인 감사가 없습니다.' };
}

/**
 * 묶어 내리기(ADM-07) — 사람이 이름을 훑고 확인한 묶음을 한 번에 내린다. 최대 GROUP_REMOVE_MAX 건.
 *
 * 한 건씩 내리기와 같은 길을 한 건마다 탄다(removeAuditedProducts). 화면이 보낸 것을 그대로 믿지 않는다 —
 * 확신 문턱·주인 없음·아직 아무도 손대지 않음을 잠근 뒤 다시 보고, 맞지 않는 것은 건너뛴다.
 */
export async function removeAuditGroup(form: FormData): Promise<AuditGroupResult> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const ids = form.getAll('item').map(Number);
  const slugs = form.getAll('slug').map(String);
  const group = String(form.get('group') ?? '').slice(0, 40);
  if (!ids.length || ids.length !== slugs.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || slugs.some((slug) => !slug)) {
    return { error: '고른 제품을 읽지 못했습니다. 새로고침해주세요.' };
  }
  if (ids.length > GROUP_REMOVE_MAX) return { error: `한 번에 ${GROUP_REMOVE_MAX}건까지 내립니다.` };
  const items = ids.map((itemId, index) => ({ itemId, slug: slugs[index] }));
  const result = await removeAuditedProducts({ items, by: admin.login });
  const failed = new Map(result.failed.map((item) => [item.slug, item.error]));
  await recordAdminActions(admin.login, items.map((item) => ({ action: 'audit-remove', target: item.slug,
    detail: { itemId: item.itemId, group, bulk: items.length }, ok: !failed.has(item.slug), error: failed.get(item.slug) ?? null })));
  logger.info('admin.product_audit_group_removed', { group, removed: result.removed.length, failed: result.failed.length, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/products');
  return { removed: result.removed.length, failed: result.failed.length };
}

/**
 * 멈춘 감사(심사 글이 바뀜)를 중단하고 지금 글로 새 감사를 연다 — 화면의 기본 버튼 하나(ADM-15).
 * 닫기와 열기는 한 트랜잭션이다(startProductAudit replacing): 새 감사를 열 수 없으면 멈춘 감사도 그대로고, 두 번 눌러도
 * 방금 연 새 감사를 닫지 않는다. 성공하면 중단과 시작을 작업 로그에 각각 남긴다.
 */
export async function restartStalledAudit(form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const campaignId = Number(form.get('campaign'));
  const reason = String(form.get('reason') ?? '');
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) return { error: '감사를 읽지 못했습니다. 새로고침해주세요.' };
  const result = await startProductAudit({ startedBy: admin.login, reason, reauditKept: false, replacing: campaignId });
  await recordAdminActions(admin.login, result.ok ? [
    { action: 'audit-cancel', target: `campaign:${campaignId}`, detail: { restart: true } },
    { action: 'audit-start', target: `campaign:${result.campaignId}`,
      detail: { reason, reauditKept: false, replaced: campaignId, enrolled: result.enrolled, keptSkipped: result.keptSkipped } },
  ] : [{ action: 'audit-start', target: `campaign:${campaignId}`, detail: { reason, replacing: campaignId }, ok: false, error: result.error }]);
  if (!result.ok) return { error: result.error };
  logger.info('admin.product_audit_restarted', { replaced: campaignId, campaign: result.campaignId, enrolled: result.enrolled, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/status');
  return { message: `감사 #${campaignId}을 닫고 #${result.campaignId}을 열었습니다 — ${result.enrolled.toLocaleString('ko-KR')}건.` };
}
