import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import {
  ASSIGNMENT_LIVE_CONFIRM, assignmentPrefillFromParams, modelAssignmentIssueMessage, previewAdminAssignmentImport, readModelAssignmentsAdminView,
  type AssignmentRowView,
} from "@/lib/operations/admin-model-assignments";
import { readAssignmentReadsControl } from "@/lib/operations/admin-runtime-settings";
import { PageStamp } from "../../components/PageStamp";
import { AssignmentsForm } from "../limits/AssignmentsForm";
import { AssignmentForm, type AssignmentFormValues } from "./AssignmentForm";
import { AssignmentStageTable } from "./AssignmentTable";
import { ImportCard } from "./ImportCard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "모델 배정 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const ERROR_LABELS: Record<string, string> = { rows: "배정 표", helpers: "도우미 배정", devices: "장비 행", policy: "용량 정책", contracts: "계약",
  counts: "최근 1시간 건수", registry: "모델 등록부" };

function editValues(row: AssignmentRowView | undefined): AssignmentFormValues | null {
  if (!row || row.role !== "primary" || !row.registryKey || !row.transport || row.rank === null) return null;
  return { assignmentId: row.assignmentId, version: row.version, stage: row.stage, deviceId: row.deviceId, registryKey: row.registryKey, transport: row.transport,
    rank: row.rank, vote: row.vote, mode: row.mode === "live" ? "live" : "off", maxSlots: row.maxSlots, note: row.note };
}

/**
 * 모델 배정(PR 3b-D) — 단계 × 장비 × 모델 × 순위 × 모드 × 전송 배정을 보이고 PR 3b-A 의 저장 함수 하나로 바꾼다(재배포 없음).
 * 저장 한 번이 계약 확인(없으면 readback·1토큰 시험)·정책 경로 덧붙이기(DRAIN 없음)·장비 역할 순위·배정 행·감사를 한 TX 에 한다.
 * 도우미 행은 함께 보이지만 「도우미 장비」 화면에서만 바꾼다. 읽는 쪽(3b-B)은 「배정 표 읽기」(runtime_settings 토글, PR 3b-E — 아래 폼) 뒤에서 이 표를 읽는다;
 * env MODEL_ASSIGNMENT_TABLE 은 강제다. 켜는 순서: 가져오기 → 토글 켬 → 상태 띠 확인(재배포 없음).
 */
export default async function ModelAssignmentsPage({ searchParams }: Props) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const now = new Date();
  const [view, reads] = await Promise.all([readModelAssignmentsAdminView(now), readAssignmentReadsControl()]);
  const prefill = assignmentPrefillFromParams(params);
  const editing = prefill.editId ? editValues(view.groups.flatMap(group => group.rows).find(row => row.assignmentId === prefill.editId)) : null;
  const preview = params.import === "plan" ? await previewAdminAssignmentImport() : null;
  const errors = Object.entries(view.errors);
  return <main className="mx-auto grid max-w-7xl gap-6 p-4">
    <PageStamp />
    <header className="grid gap-1">
      <p className="flex flex-wrap gap-4 text-[13px] text-fg-3"><Link href="/admin/models">← 단계별 모델</Link><Link href="/admin/models/devices">장비 한도 →</Link>
        <Link href="/admin/models/helpers">도우미 장비 →</Link><Link href="/admin/models/contracts">모델 연결(계약) →</Link></p>
      <h1 className="text-[22px] font-semibold">모델 배정</h1>
      <p className="text-[13px] text-fg-3">단계마다 어느 장비의 어느 모델을 몇 순위로 쓸지 정합니다. 저장하면 재배포 없이 계약 확인(없으면 엔진에 readback·1토큰 시험) →
        정책 경로 덧붙이기(DRAIN 없음) → 장비 역할 순위 → 배정 행 → 작업 로그 한 줄이 한 번에 들어갑니다. 거절되면 아무것도 바뀌지 않고 이유와 할 일을 보입니다.
        도우미(쉬는 장비가 돕기)는 <Link href="/admin/models/helpers" className="underline">도우미 장비</Link>에서 섀도·승격합니다.</p>
      <p role="status" data-flag={view.flagOn ? "on" : "off"} data-flag-source={view.flagSource} className={`rounded-lg border px-3 py-2 text-[13px] font-semibold ${view.flagOn
        ? "border-emerald-300 bg-emerald-50 text-emerald-900" : view.flagSource === "unread" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-line bg-bg-soft text-fg-2"}`}>
        {view.banner}</p>
      <p className="text-[13px] text-fg-2">배정 {view.counts.primary}개(실전 {view.counts.live}) · 도우미 {view.counts.helpers}개
        {view.policy && <> · 정책 {view.policy.mode.toUpperCase()} revision <span className="font-mono">{view.policy.revision}</span> · 경로 {view.policy.routes}개</>}</p>
      {view.flagOn && <ul className="flex flex-wrap gap-2 text-[13px]" aria-label="단계별 읽기 출처">{view.groups.filter(group => !group.reserved).map(group =>
        <li key={group.id}><a href={`#stage-${group.id}`} className="underline">{group.label}</a> {group.sourceLabel}</li>)}</ul>}
      {errors.map(([key, error]) => <p key={key} role="alert" className="text-[13px] text-red-600">{ERROR_LABELS[key] ?? key}을(를) 읽지 못했습니다({modelAssignmentIssueMessage(error ?? "")})
        {key === "rows" ? " — 저장할 수 없습니다." : " — 그 칸은 「모름」·「—」입니다."}</p>)}
    </header>
    <section id="reads" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">배정 표 읽기</h2>
      <p className="text-[13px] text-fg-3">켜는 순서: ① 아래 「현재 설정 → 배정 표 가져오기」로 행을 채운다 → ② 여기서 「켬」으로 저장한다 → ③ 새로고침해 위 상태 띠가 「배정 표 읽기 켜짐」이고
        단계마다 「표」인지 본다. 모든 역할이 30초 안에 같은 값을 읽습니다(재배포·재시작 없음). 끄면 설정(legacy)으로 돌아갑니다.
        {view.flagSource === "env" && <> <strong>이 웹 프로세스는 env MODEL_ASSIGNMENT_TABLE 이 강제해 토글이 닿지 않습니다</strong> — 다른 역할에는 토글이 적용됩니다.</>}</p>
      {reads.rowError && <p role="alert" className="text-[13px] text-red-600">runtime_settings 행을 읽지 못했습니다({reads.rowError}) — 토글을 저장할 수 없습니다.</p>}
      <AssignmentsForm fields={reads.fields} revision={reads.revision} readOnly={reads.revision === null} compact />
    </section>
    <section id="table" className="grid gap-3 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">단계별 배정</h2>
      <p className="text-[13px] text-fg-3">「계약」은 그 경로·wire 모델의 켜진 계약(앞 12자리 hash), 「route」는 지금 용량 정책에 (경로, 공급자, 모델, 장비)가 있는지,
        「장비 역할 순위」는 장비 한도의 그 경로 순위, 「최근 1시간」은 정산(settled)된 호출 수입니다. 도우미 행은 도우미 화면에서 바꿉니다.</p>
      {view.groups.map(group => <AssignmentStageTable key={group.id} group={group} readOnly={view.readOnly} />)}
    </section>
    <section id="form" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">{editing ? "배정 고치기" : "배정 추가"}</h2>
      {prefill.editId && !editing && <p role="alert" className="text-[13px] text-amber-700">고칠 배정 {prefill.editId} 을(를) 찾지 못했습니다 — 새 배정으로 엽니다.</p>}
      <AssignmentForm key={editing?.assignmentId ?? `new:${prefill.stage ?? ""}:${prefill.registryKey ?? ""}`} options={view.options} initial={editing}
        prefill={prefill} readOnly={view.readOnly} />
    </section>
    <section id="import" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">현재 설정 → 배정 표 가져오기</h2>
      <ImportCard preview={preview} readOnly={view.readOnly} confirmWord={ASSIGNMENT_LIVE_CONFIRM} />
    </section>
    <section id="audit" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">최근 기록 ({view.audit.length})</h2>
      {view.audit.length === 0 ? <p className="text-[13px] text-fg-3">아직 기록이 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">누가</th><th className="py-2 pr-3">배정 · 판</th><th className="py-2 pr-3">바뀐 값</th></tr></thead>
          <tbody>{view.audit.map(row => <tr key={row.id} className="border-b border-line align-top">
            <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(row.at, now)}</td>
            <td className="py-2 pr-3">{row.actor}</td>
            <td className="py-2 pr-3"><code>{row.target}</code>{row.version !== null && <> · <span className="font-mono">{row.version}</span></>}</td>
            <td className="py-2 pr-3">{row.ok ? (row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—")
              : <span className="text-red-600">{row.error ? modelAssignmentIssueMessage(row.error) : "거절"}</span>}</td>
          </tr>)}</tbody></table></div>}
      <Link href="/admin/activity" prefetch={false} className="text-[13px] font-semibold text-accent-ink">작업 로그에서 전체 보기 →</Link>
    </section>
  </main>;
}
