import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { modelHelperIssueMessage, readModelHelpersAdminView } from "@/lib/operations/admin-model-helpers";
import { PageStamp } from "../../components/PageStamp";
import { HelperForm } from "./HelperForm";
import { HelperTable } from "./HelperTable";
import { SupervisorCard } from "./SupervisorCard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "도우미 장비 — NoMoreVibe", robots: { index: false } };

/**
 * 도우미 장비(PR 2a, Layer B) — 장비의 자기 역할이 쉬면 다른 역할(1차·2차 검수)을 돕게 하는 배정과 Oracle 감시자를 보이고 바꾼다.
 * 감시자 신호는 도우미 경로를 열 뿐 우선 역할 일을 막지 못한다. 신호가 없거나 만료·다른 epoch·판·계정이면 도우미는 닫힌다(fail-closed).
 * 상태는 readHelperStatusSnapshot 한 번(DB 시계)에서 만든다. 실전 승격은 PR 2c 에서 연다.
 */
export default async function ModelHelpersPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const view = await readModelHelpersAdminView();
  const now = new Date(view.nowMs);
  const readOnly = view.snapshotError !== null;
  return <main className="mx-auto grid max-w-6xl gap-6 p-4">
    <PageStamp />
    <header className="grid gap-1">
      <p className="flex flex-wrap gap-4 text-[13px] text-fg-3"><Link href="/admin/models/devices">← 장비 한도</Link><Link href="/admin/models">← 단계별 모델</Link></p>
      <h1 className="text-[22px] font-semibold">도우미 장비</h1>
      <p className="text-[13px] text-fg-3">장비의 자기 역할(예: M3 DeepSeek 의 사람 검수)이 쉬면 그 장비가 1차·2차 검수를 돕고, 자기 일이 다시 오면 바로 돌아갑니다.
        도우미는 언제나 그 장비의 우선 역할보다 낮은 순위이고, Oracle 감시자의 <strong>신선한 신호가 있을 때만</strong> 열립니다 — 신호가 없거나 오래되면 도우미가 닫힐 뿐
        우선 역할 일은 막히지 않습니다. 섀도 결과는 어떤 판정에도 쓰이지 않습니다.</p>
      {view.supervisor && <p className="text-[13px] text-fg-2">감시자 <strong>{view.supervisor.badgeLabel}</strong> · 배정 {view.helpers.length}개
        {" · "}돕는 중 {view.counts.help} · 섀도만 {view.counts.shadowOnly} · 쉬는 중 {view.counts.hold}</p>}
      {view.snapshotError && <p role="alert" className="text-[13px] text-red-600">도우미 상태를 읽지 못했습니다({modelHelperIssueMessage(view.snapshotError)}). 아래는 비어 있고 저장할 수 없습니다.</p>}
      {view.issues.map(text => <p key={text} role="alert" className="text-[13px] text-amber-700">{text}</p>)}
    </header>
    <section id="supervisor" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">감시자</h2>
      <SupervisorCard supervisor={view.supervisor} readOnly={readOnly} />
    </section>
    <section id="helpers" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">도우미 ({view.helpers.length})</h2>
      <p className="text-[13px] text-fg-3">「지금 판정」은 신호를 쓸 수 있을 때의 감시자 판정이고, 쓸 수 없으면 「쉬는 중」과 그 이유입니다. 「입장(실제)」는 입장 판정이 DB 안에서 본
        경로 열림·점유입니다(미확인 행은 점유가 아닙니다). 감시자가 metrics 에 적지 않은 칸은 「—」입니다.</p>
      <HelperTable helpers={view.helpers} now={now} />
    </section>
    <section id="stops" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">자동 정지 ({view.stops.length})</h2>
      <p className="text-[13px] text-fg-3">감시자가 확인 못함·실패 비율이나 품질 저하로 넣은 정지입니다. 지금 판에만 걸리고 지워지지 않습니다 — 배정을 다시 저장하거나
        「자동 정지 해제」로 판을 올리면 풀립니다.</p>
      {view.stops.length === 0 ? <p className="text-[13px] text-fg-3">지금 판에 걸린 자동 정지가 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">배정 · 판</th><th className="py-2 pr-3">효과</th><th className="py-2 pr-3">이유</th><th className="py-2 pr-3">근거</th>
          <th className="py-2 pr-3">쓴 계정</th></tr></thead>
          <tbody>{view.stops.map(stop => <tr key={stop.id} className="border-b border-line align-top">
            <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(stop.createdAt, now)}</td>
            <td className="py-2 pr-3"><a href={`#helper-${stop.assignmentId}`} className="font-mono underline">{stop.assignmentId}</a> · <span className="font-mono">{stop.version}</span></td>
            <td className="py-2 pr-3 font-semibold text-red-600">{stop.effectLabel}</td>
            <td className="py-2 pr-3">{stop.reasonLabel}</td>
            <td className="py-2 pr-3"><code className="break-all whitespace-pre-wrap">{stop.evidence}</code></td>
            <td className="py-2 pr-3"><code>{stop.writtenBy}</code></td>
          </tr>)}</tbody></table></div>}
    </section>
    <section id="edit" className="grid gap-4 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">배정별 설정</h2>
      <p className="text-[13px] text-fg-3">임계값·이력 설정만 바꾸면 판이 오르고 섀도 근거는 그대로입니다. 모델·경로를 바꾸면 섀도 근거(evidence_key)가 처음부터 시작하고 실전은 섀도로 내려갑니다.
        저장 거절(도우미 경로가 우선 역할·정책에 경로 없음·2차 대체 목록 밖)은 이유를 그대로 보입니다.</p>
      {view.helpers.length === 0 && <p className="text-[13px] text-fg-3">배정이 없습니다.</p>}
      {view.helpers.map(helper => <HelperForm key={helper.assignmentId} helper={helper} defaults={view.defaults} routeDefaults={view.routeDefaults} readOnly={readOnly} />)}
    </section>
    <section id="new" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">새 배정</h2>
      <p className="text-[13px] text-fg-3">장비 × 단계마다 하나입니다. 도우미 장비는 장비 한도에 있어야 하고, 도우미 경로는 그 장비에서 순위 2 이상이어야 합니다(1 이면 거절).
        도우미 경로(live·shadow)는 먼저 정책에 들어가 있어야 저장됩니다 — 경로는 DRAIN 없이 정책에 덧붙일 수 있습니다. 새 배정은 꺼짐으로 만드세요.</p>
      <HelperForm helper={null} defaults={view.defaults} routeDefaults={view.routeDefaults} readOnly={readOnly} />
    </section>
    <section id="audit" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">최근 기록 ({view.audit.length})</h2>
      {view.audit.length === 0 ? <p className="text-[13px] text-fg-3">아직 기록이 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">누가</th><th className="py-2 pr-3">무엇</th><th className="py-2 pr-3">대상 · 판</th><th className="py-2 pr-3">바뀐 값</th></tr></thead>
          <tbody>{view.audit.map(row => <tr key={row.id} className="border-b border-line align-top">
            <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(row.at, now)}</td>
            <td className="py-2 pr-3">{row.actor}</td>
            <td className="py-2 pr-3">{row.actionLabel}{!row.ok && <span className="ml-1 text-red-600">거절</span>}</td>
            <td className="py-2 pr-3"><code>{row.target}</code>{row.version !== null && <> · <span className="font-mono">{row.version}</span></>}</td>
            <td className="py-2 pr-3">{row.ok ? (row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—")
              : <span className="text-red-600">{row.error ? modelHelperIssueMessage(row.error) : "거절"}</span>}</td>
          </tr>)}</tbody></table></div>}
      <Link href="/admin/activity" prefetch={false} className="text-[13px] font-semibold text-accent-ink">작업 로그에서 전체 보기 →</Link>
    </section>
  </main>;
}
