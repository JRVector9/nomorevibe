'use client';

import { useActionState } from 'react';
import { ConfirmAction } from '../components/ConfirmAction';
import { resultToast, useAdminToast } from '../components/Toast';
import { AUDIT_REASON_CATEGORIES, AUDIT_REASON_KEYS } from '@/lib/crawl/audit-reason-category';
import type { CrawlSettings } from '@/lib/crawl/settings-schema';
import { cancelAudit, releaseAuditHolds, restartStalledAudit, saveAuditHold, startAudit, type AuditActionState } from './actions';

type AuditHold = CrawlSettings['auditHold'];

/**
 * 감사 보류의 설정 — 켬/끔, 확신 문턱, 보류하는 사유 갈래, 두 번째 모델 거절. 폼은 화면이 본 값을 함께 보내 그 사이 바뀌었으면 거절된다.
 * 끄거나 좁혀도 이미 건 보류는 남는다 — 풀려면 옆의 '보류 모두 풀기'다.
 */
export function AuditHoldSettingsForm({ hold }: { hold: AuditHold }) {
  const [state, action, pending] = useActionState<AuditActionState, FormData>(saveAuditHold, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="expected" value={JSON.stringify(hold)} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-fg-2">
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" name="enabled" defaultChecked={hold.enabled} className="size-4 accent-accent" />
          <b className="font-semibold">자동 보류</b>
        </label>
        <label className="flex min-h-10 items-center gap-2">
          확신
          <input type="number" name="minConfidence" min={0.8} max={1} step={0.01} defaultValue={hold.minConfidence.toFixed(2)}
            className="w-[5.5rem] rounded-lg border border-line bg-bg-soft px-2 py-1.5 font-mono text-[13px]" aria-label="확신 문턱" />
          이상
        </label>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" name="secondOpinionReject" defaultChecked={hold.secondOpinionReject} className="size-4 accent-accent" />
          두 번째 모델도 거절하면 갈래와 상관없이 보류
        </label>
      </div>
      <fieldset className="flex flex-wrap items-center gap-x-3 text-[13px] text-fg-2">
        <legend className="mb-1 font-semibold text-fg-3">보류하는 사유 갈래</legend>
        {AUDIT_REASON_KEYS.map((key) => (
          <label key={key} title={AUDIT_REASON_CATEGORIES[key].hint} className="flex min-h-10 items-center gap-1.5">
            <input type="checkbox" name="category" value={key} defaultChecked={hold.categories.includes(key)} className="size-4 accent-accent" />
            {AUDIT_REASON_CATEGORIES[key].label}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <input name="reason" maxLength={500} placeholder="바꾸는 까닭 (선택, 기록에 남습니다)" aria-label="보류 설정을 바꾸는 까닭"
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-line bg-bg-soft px-3 py-1.5 text-[13px]" />
        <button type="submit" disabled={pending}
          className="min-h-10 rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50">
          {pending ? '저장 중…' : '보류 설정 저장'}
        </button>
      </div>
      {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
      {state?.message && <p className="text-[13px] text-up">{state.message}</p>}
    </form>
  );
}

/** 보류 모두 풀기 — 아무것도 내리지 않고 보류된 제품을 목록에 돌려놓는다. 확인 창에서 까닭을 받는다 */
export function ReleaseAllHolds({ held }: { held: number }) {
  const toast = useAdminToast();
  return (
    <ConfirmAction tone="neutral" title={`보류 ${held.toLocaleString('ko-KR')}건을 모두 풉니다`} confirmLabel="보류 모두 풀기"
      summary={<ul>
        <li>아무것도 내리지 않습니다. 보류된 제품이 공개 목록·검색·sitemap 에 돌아옵니다.</li>
        <li>푼 항목은 다시 보류하지 않습니다. 감사 거절 목록에는 그대로 남아 사람을 기다립니다.</li>
        <li>자동 보류가 켜져 있으면 새 감사 답은 다시 보류될 수 있습니다 — 멈추려면 먼저 끄세요.</li>
      </ul>}
      note={{ label: '왜 푸는지 (기록에 남습니다)', placeholder: '예: 문턱을 잘못 잡음', optional: true, maxLength: 500 }}
      onConfirm={async ({ note }) => {
        const form = new FormData();
        form.set('note', note ?? '');
        const result = await releaseAuditHolds(form);
        toast.show(resultToast(result, { message: result?.message ?? '보류를 풀었습니다', link: { label: '기록 보기', href: '/admin/activity?group=takedown' } }));
        return result;
      }}
      trigger={(open) => <button type="button" onClick={open} disabled={held === 0}
        className="min-h-10 rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2 disabled:opacity-50">보류 모두 풀기</button>} />
  );
}

/**
 * 감사를 여는 폼. 이 버튼은 아무것도 내리지 않는다 — 화면에도 그렇게 적는다.
 *
 * "유지 판정도 다시 보기"는 기본으로 꺼 둔다. 켜면 사람이 페이지를 열어 보고 유지로 둔 것까지
 * 전부 다시 사람 앞에 온다 — 심사 글을 한 줄 고칠 때마다 그러면 이미 한 확인을 버리는 셈이다.
 * 기준이 실제로 엄격해져 예전의 "유지"를 믿을 수 없을 때만 켠다. 꺼 두어도 페이지가 바뀌었거나
 * 90일이 지난 것은 다시 들어온다.
 */
export function StartAudit({ blockedReason, first }: { blockedReason: string | null; first: boolean }) {
  const [state, action, pending] = useActionState<AuditActionState, FormData>(startAudit, null);
  const disabled = pending || Boolean(blockedReason);
  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-[13px] leading-[1.7] text-fg-2">
        <b className="font-semibold">이 버튼은 아무것도 내리지 않습니다.</b> 공개된 제품을 지금의 심사 글로 다시 보고,
        사람이 확인할 새 목록을 만들 뿐입니다. 내리는 것은 아래 목록에서 한 건씩, 또는 묶음의 이름을 훑고 누릅니다.
      </p>
      <input name="reason" required maxLength={500} disabled={disabled} placeholder="왜 다시 보는지 (기록에 남습니다)"
        className="rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px] disabled:opacity-50" />
      <label className="flex items-start gap-2 text-[13px] text-fg-2">
        <input type="checkbox" name="reauditKept" disabled={disabled} className="mt-1 size-4 accent-accent" />
        <span>
          <b className="font-semibold">유지 판정도 다시 보기</b>
          <span className="block text-fg-3">
            끄면(기본) 사람이 유지로 둔 제품 중 90일이 안 지났고 페이지도 그대로인 것은 빼고 봅니다.
            기준이 실제로 엄격해졌을 때만 켜세요 — 켜면 이미 확인한 것까지 전부 다시 올라옵니다.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={disabled}
          className="rounded-lg border border-accent bg-accent px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
          {pending ? '올리는 중…' : first ? '감사 시작' : '재감사 시작'}
        </button>
        {blockedReason && <span className="text-[13px] text-fg-3">{blockedReason}</span>}
      </div>
      {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
      {state?.message && <p className="text-[13px] text-up">{state.message}</p>}
    </form>
  );
}

/** 진행 중인 감사를 멈춘다. 멈춰도 아무것도 내려가지 않고, 찾은 것은 목록에 남는다 */
export function CancelAudit() {
  const [state, action, pending] = useActionState<AuditActionState, FormData>(cancelAudit, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={pending}
        className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2 disabled:opacity-50">
        이 감사 중단
      </button>
      <span className="text-[13px] text-fg-3">멈춰도 아무것도 내려가지 않고, 지금까지 찾은 것은 남습니다.</span>
      {state?.error && <span className="text-[13px] text-down">{state.error}</span>}
    </form>
  );
}

/**
 * 멈춘 감사(심사 글이 바뀜)의 기본 버튼 — 중단과 새 감사를 한 번에(ADM-15). 새 감사도 사유를 남겨야 열리므로 창에서 받는다.
 * 유지 판정은 다시 보지 않는다(새 감사 폼의 기본값과 같다) — 켜야 하면 중단만 하고 아래 폼에서 연다.
 */
export function RestartStalledAudit({ campaignId, from, to }: { campaignId: number; from: string; to: string }) {
  const toast = useAdminToast();
  return (
    <ConfirmAction tone="neutral" title={`감사 #${campaignId}을 중단하고 새 감사를 엽니다`} confirmLabel="중단하고 새 감사 시작"
      summary={<ul>
        <li>심사 글이 {from} → {to}로 바뀌어 이 감사는 더 묻지 않고 멈춰 있습니다.</li>
        <li>아무것도 내리지 않습니다. 지금까지 찾은 것은 목록에 남습니다.</li>
        <li>새 감사는 지금 글로 공개된 제품을 다시 봅니다. 유지 판정은 다시 보지 않습니다.</li>
      </ul>}
      note={{ label: '왜 다시 보는지 (기록에 남습니다)', placeholder: `예: 심사 글 ${to} 배포`, maxLength: 500 }}
      onConfirm={async ({ note }) => {
        const form = new FormData();
        form.set('campaign', String(campaignId));
        form.set('reason', note ?? '');
        const result = await restartStalledAudit(form);
        toast.show(resultToast(result, { message: result?.message ?? '새 감사를 열었습니다', link: { label: '기록 보기', href: '/admin/activity?group=takedown' } }));
        return result;
      }}
      trigger={(open) => <button type="button" className="admin-button" data-tone="primary" onClick={open}>이 감사 중단 → 새 감사 시작</button>} />
  );
}
