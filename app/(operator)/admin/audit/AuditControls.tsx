'use client';

import { useActionState, useState } from 'react';
import { ConfirmAction } from '../components/ConfirmAction';
import { resultToast, useAdminToast } from '../components/Toast';
import { AUDIT_REASON_CATEGORIES, AUDIT_REASON_KEYS, type AuditReasonCategory } from '@/lib/crawl/audit-reason-category';
import { auditHoldWidens, sameAuditHold } from '@/lib/crawl/audit-hold-policy';
import type { CrawlSettings } from '@/lib/crawl/settings-schema';
import { cancelAudit, restartStalledAudit, saveAuditHold, startAudit, switchAuditModel, type AuditActionState } from './actions';

type AuditHold = CrawlSettings['auditHold'];

/**
 * 감사 보류의 설정 — 켬/끔, 확신 문턱, 보류하는 사유 갈래, 두 번째 모델 거절. 값은 이 화면이 쥐고 있다가(오류가 나도 고친 값이 남는다)
 * 저장을 누르면 확인 창이 지금 값 → 바꿀 값을 보인다. 넓히는 바꿈(켬·문턱 내림·갈래 더함·두 번째 모델 거절 켬)은 까닭을 받는다 —
 * 서버(setAuditHold)도 같은 규칙으로 막는다. 화면이 본 값을 함께 보내 그 사이 바뀌었으면 거절된다. 저장되면 페이지가 새 값으로 다시 그린다(key).
 * 끄거나 좁혀도 이미 건 보류는 남는다 — 풀려면 정책 처리의 '보류 풀기'(거르기로 골라, 되돌릴 수 있게)다.
 */
export function AuditHoldSettingsForm({ hold }: { hold: AuditHold }) {
  const toast = useAdminToast();
  const [enabled, setEnabled] = useState(hold.enabled);
  const [threshold, setThreshold] = useState(hold.minConfidence.toFixed(2));
  const [categories, setCategories] = useState<AuditReasonCategory[]>([...hold.categories]);
  const [secondOpinionReject, setSecondOpinionReject] = useState(hold.secondOpinionReject);
  const minConfidence = Number(threshold);
  const valid = Number.isFinite(minConfidence) && minConfidence >= 0.8 && minConfidence <= 1;
  const next = { enabled, minConfidence, categories: AUDIT_REASON_KEYS.filter((key) => categories.includes(key)), secondOpinionReject };
  const changed = valid && !sameAuditHold(hold, next);
  const widens = valid && auditHoldWidens(hold, next);
  const onOff = (value: boolean) => (value ? '켬' : '끔');
  const labels = (keys: readonly AuditReasonCategory[]) => keys.map((key) => AUDIT_REASON_CATEGORIES[key].label).join(', ') || '없음';
  const toggle = (key: AuditReasonCategory) => setCategories((now) => now.includes(key) ? now.filter((item) => item !== key) : [...now, key]);
  // 고친 값이 있는 동안은 자동 갱신을 멈춘다(data-dirty) — 다시 그리면 새 설정 값(key)으로 다시 열려 고친 값을 잃는다
  const edited = !valid || changed;
  return (
    <div className="flex flex-col gap-2" data-dirty={edited || undefined}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-fg-2">
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" name="enabled" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-accent" />
          <b className="font-semibold">자동 보류</b>
        </label>
        <label className="flex min-h-10 items-center gap-2">
          확신
          <input type="number" name="minConfidence" min={0.8} max={1} step={0.01} value={threshold} onChange={(event) => setThreshold(event.target.value)}
            aria-invalid={!valid} className="w-[5.5rem] rounded-lg border border-line bg-bg-soft px-2 py-1.5 font-mono text-[13px]" aria-label="확신 문턱" />
          이상
        </label>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" name="secondOpinionReject" checked={secondOpinionReject} onChange={(event) => setSecondOpinionReject(event.target.checked)}
            className="size-4 accent-accent" />
          두 번째 모델도 거절하면 갈래와 상관없이 보류
        </label>
      </div>
      <fieldset className="flex flex-wrap items-center gap-x-3 text-[13px] text-fg-2">
        <legend className="mb-1 font-semibold text-fg-3">보류하는 사유 갈래</legend>
        {AUDIT_REASON_KEYS.map((key) => (
          <label key={key} title={AUDIT_REASON_CATEGORIES[key].hint} className="flex min-h-10 items-center gap-1.5">
            <input type="checkbox" name="category" value={key} checked={categories.includes(key)} onChange={() => toggle(key)} className="size-4 accent-accent" />
            {AUDIT_REASON_CATEGORIES[key].label}
          </label>
        ))}
      </fieldset>
      {!valid && <p className="text-[13px] text-down">확신 문턱은 0.80~1.00 사이로 적어 주세요.</p>}
      <ConfirmAction tone={widens ? 'danger' : 'neutral'} title={widens ? '보류를 넓힙니다 — 사람 눈 없이 목록에서 빠지는 제품이 늘어납니다' : '보류 설정을 바꿉니다'}
        confirmLabel="보류 설정 저장"
        summary={<ul>
          {hold.enabled !== next.enabled && <li>자동 보류: {onOff(hold.enabled)} → {onOff(next.enabled)}</li>}
          {hold.minConfidence !== next.minConfidence && <li>확신 문턱: {hold.minConfidence.toFixed(2)} → {next.minConfidence.toFixed(2)}</li>}
          {!sameAuditHold({ ...hold, categories: next.categories }, hold) && <li>사유 갈래: {labels(hold.categories)} → {labels(next.categories)}</li>}
          {hold.secondOpinionReject !== next.secondOpinionReject &&
            <li>두 번째 모델 거절로 보류: {onOff(hold.secondOpinionReject)} → {onOff(next.secondOpinionReject)}</li>}
          <li>끄거나 좁혀도 이미 건 보류는 남습니다. 넓히면 다음 틱부터 분당 20건씩 더 겁니다.</li>
        </ul>}
        note={{ label: widens ? '왜 넓히는지 (꼭 적어 주세요 · 기록에 남습니다)' : '바꾸는 까닭 (선택 · 기록에 남습니다)', optional: !widens, maxLength: 500 }}
        onConfirm={async ({ note }) => {
          const form = new FormData();
          form.set('expected', JSON.stringify(hold));
          if (next.enabled) form.set('enabled', 'on');
          form.set('minConfidence', threshold);
          for (const key of next.categories) form.append('category', key);
          if (next.secondOpinionReject) form.set('secondOpinionReject', 'on');
          form.set('reason', note ?? '');
          const result = await saveAuditHold(null, form);
          if (result && !result.error) toast.show(resultToast(result, { message: result.message ?? '보류 설정을 저장했습니다' }));
          return result;
        }}
        trigger={(open) => <button type="button" onClick={open} disabled={!changed}
          className="min-h-10 self-start rounded-lg border border-accent bg-accent px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50">
          보류 설정 저장…</button>} />
    </div>
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

/**
 * 남은 감사 모델 바꾸기(0112) — 진행 중인 감사의 아직 답이 없는 항목을 Qwen-v2(Qwen 직접 서버)로 묻는다. 확인 창이 지금 → 바꿀 모델과
 * 남은 수를 보이고 사유를 꼭 받는다(서버도 사유 없이는 바꾸지 않는다). 화면이 본 심사자(from)를 함께 보내 그 사이 바뀌었으면 거절된다.
 */
export function SwitchAuditModel({ campaignId, from, to, unanswered }: {
  campaignId: number;
  /** 지금 묻는 심사자 — 서버가 잠근 감사 행과 견준다 */
  from: { provider: string; model: string; label: string };
  /** server: 부르는 Qwen 직접 서버의 이름(AUDIT_SECOND_OPINION_LABEL 또는 주소의 호스트) */
  to: { model: string; label: string; server: string };
  unanswered: number;
}) {
  const toast = useAdminToast();
  return (
    <ConfirmAction tone="neutral" title={`감사 #${campaignId}의 남은 것을 ${to.label}(으)로 묻습니다`} confirmLabel="남은 감사 모델 바꾸기"
      summary={<ul>
        <li>모델: {from.label} → {to.label} ({to.model}, {to.server} 직접 — 게이트웨이를 거치지 않습니다)</li>
        <li>아직 답이 없는 {unanswered.toLocaleString('ko-KR')}건을 새 모델이 묻습니다. 이미 답한 것은 그대로 남고, 답마다 어느 모델이 답했는지 기록됩니다.</li>
        <li>Qwen 의 확신은 늘 0.95 나 1.00 이라 거절은 대부분 자동 보류 문턱을 넘습니다. 카탈로그·디렉터리 같은 거절은 보류하지 않고 목록에 둔 채 사람이 봅니다.</li>
        <li>되돌리는 버튼은 없습니다. 멈추려면 &lsquo;이 감사 중단&rsquo;을 누르세요.</li>
      </ul>}
      note={{ label: '왜 바꾸는지 (꼭 적어 주세요 · 작업 로그에 남습니다)', placeholder: '예: 남은 1만5천 건을 하루 안에 끝내려고', maxLength: 500 }}
      onConfirm={async ({ note }) => {
        const form = new FormData();
        form.set('campaign', String(campaignId));
        form.set('expectedProvider', from.provider);
        form.set('expectedModel', from.model);
        form.set('reason', note ?? '');
        const result = await switchAuditModel(form);
        toast.show(resultToast(result, { message: result?.message ?? '남은 감사 모델을 바꿨습니다', link: { label: '기록 보기', href: '/admin/activity?group=takedown' } }));
        return result;
      }}
      trigger={(open) => <button type="button" onClick={open}
        className="rounded-lg border border-accent px-3 py-1.5 text-[13px] font-semibold text-accent">남은 감사 모델 바꾸기…</button>} />
  );
}
