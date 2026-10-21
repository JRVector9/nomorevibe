'use client';

import { useState } from 'react';
import type { SecondOpinionView } from '@/lib/crawl/audit-second-opinions';
import { ConfirmAction } from '../components/ConfirmAction';
import { useAdminToast } from '../components/Toast';
import { removeAuditGroup } from './actions';
import { secondOpinionLabel } from './second-opinion-label';

export type AuditGroupView = {
  category: string; total: number;
  items: { id: number; slug: string; name: string; url: string; confidence: number; second?: SecondOpinionView[] }[];
};
/** 묶음의 범위 — 감사 화면의 갈래(product-audit.ts GROUP_SCOPES) */
export type AuditGroupScopeView = 'held' | 'agreed' | 'reject';

const n = (value: number) => value.toLocaleString('ko-KR');
const SCOPE_LABELS: Record<AuditGroupScopeView, string> = {
  held: '보류 중(목록에서 빠짐)', agreed: '두 모델 모두 거절', reject: '내릴 후보 전체',
};

/**
 * 묶어 내리기(2026-10-08 UX 감사 ADM-07) — 확신 높은 거부를 같은 분류끼리 모아, 이름을 한 번 훑고 한 묶음씩 내린다.
 * 내리는 길은 한 건씩 내리기와 같다. 묶음을 내리면 그 분류의 다음 묶음이 이 자리에 온다.
 * 범위(scope)를 폼에 싣는다 — 서버가 잠근 뒤 그 범위를 다시 본다(그 사이 풀린 보류·바뀐 의견은 건너뛴다). 두 번째 모델이 승인한
 * 것(갈림)은 묶지 않는다. 확인 창은 줄마다 두 번째 의견을 붙여 보인다.
 */
export function AuditGroups({ groups, minConfidence, max, scope }: {
  groups: AuditGroupView[]; minConfidence: number; max: number; scope: AuditGroupScopeView;
}) {
  const [picked, setPicked] = useState<AuditGroupView | null>(null);
  const toast = useAdminToast();
  if (groups.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-line bg-bg-card p-4" aria-labelledby="audit-groups-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="audit-groups-title" className="text-[14.5px] font-bold">묶어 내리기 · {SCOPE_LABELS[scope]}</h2>
        <span className="text-[13px] text-fg-3">확신 {minConfidence.toFixed(2)} 이상 · 주인 없는 것 · 두 번째 모델이 승인한 것은 빼고 ·
          같은 분류끼리, 한 번에 {n(max)}건까지 이름을 훑고 내립니다</span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {groups.map((group) => (
          <li key={group.category}>
            <button type="button" onClick={() => setPicked(group)}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line bg-bg-soft px-3 py-1.5 text-[13px] hover:bg-bg-hover">
              <b className="font-semibold">{group.category}</b>
              <span className="font-mono text-fg-3">{n(group.total)}건</span>
              <span className="font-semibold text-down">{n(group.items.length)}건 내리기…</span>
            </button>
          </li>
        ))}
      </ul>
      <ConfirmAction open={picked !== null} onOpenChange={(open) => { if (!open) setPicked(null); }}
        title={`${SCOPE_LABELS[scope]} · ${picked?.category ?? ''} ${n(picked?.items.length ?? 0)}건을 내립니다 — 이름을 한 번 훑어 주세요`}
        targets={picked?.items.map((item) => [item.name, item.url.replace(/^https?:\/\//, ''), item.confidence.toFixed(2),
          ...(item.second ?? []).map(secondOpinionLabel)].join(' · '))}
        summary={<ul>
          <li>범위: {SCOPE_LABELS[scope]} — 내리기 전에 다시 확인해, 그 사이 범위에서 빠진 것(보류가 풀림·의견이 바뀜)은 건너뜁니다.</li>
          <li>사이트에서 곧바로 사라지고, 같은 주소를 다시 수집하거나 등록할 수 없게 막힙니다.</li>
          <li>되돌리려면 제품 관리에서 한 건씩 풉니다.</li>
          {picked && picked.total > picked.items.length && <li>이 분류의 나머지 {n(picked.total - picked.items.length)}건은 이번에 내리지 않습니다.</li>}
          <li>그 사이 누가 유지·내리기를 정한 것은 건너뜁니다.</li>
        </ul>}
        confirmLabel={`${n(picked?.items.length ?? 0)}건 내리기`}
        onConfirm={async () => {
          if (!picked) return null;
          const form = new FormData();
          form.set('group', picked.category);
          form.set('scope', scope);
          for (const item of picked.items) { form.append('item', String(item.id)); form.append('slug', item.slug); }
          const result = await removeAuditGroup(form);
          if ('error' in result) return result;
          toast.show({
            message: `${picked.category} ${n(result.removed)}건 내림${result.failed ? ` · ${n(result.failed)}건은 이미 처리됐거나 조건 밖이라 건너뜀` : ''}`,
            tone: result.failed ? 'warn' : 'ok', link: { label: '기록 보기', href: '/admin/activity?group=takedown' },
          });
          return null;
        }} />
    </section>
  );
}
