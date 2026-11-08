import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { aiTaskSupportsWorkloadPool } from "@/lib/llm/ai-task-execution-config";
import { AI_TASK_IMPORT_CONFIRM, aiTaskIssueMessage, aiUnreadConnections } from "@/lib/operations/admin-ai-tasks";
import { aiTaskTargetLabel, previewAiTaskImport, readAiTasksAdminView, type AiTaskSlotView } from "@/lib/operations/admin-ai-tasks-repository";
import { readAiTaskExecutionAdminViews } from "@/lib/operations/admin-ai-task-execution";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { PageStamp } from "../../components/PageStamp";
import { TaskExecutionForm, type TaskRuntimeLine } from "./TaskExecutionForm";
import { TaskImportCard } from "./TaskImportCard";
import { TaskAssignSlot } from "./task-assign-slot";
import { modelPickerConnectionLabel } from "../model-picker-display";
import "../llm-ops.css";
import "./tasks.css";
import { llmHistoryHref, RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "작업 배정 · LLM 운영 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";
const ERROR_LABELS: Record<string, string> = { connections: "AI 연결", rows: "작업 ↔ 모델 순위", readiness: "계약·정책·장비", policy: "용량 정책", current: "실행 쪽 모델 설정",
  audit: "최근 기록", runtime: "실행 쪽 순위 사정" };
const ACTION_LABELS: Record<string, string> = { "ai-connection-save": "연결 저장", "ai-connection-models-read": "모델 목록 읽기", "ai-connection-delete": "연결 지움", "ai-connection-model-hide": "모델 빼기·되돌리기",
  "ai-task-models-save": "순위 저장", "ai-task-execution-save": "실행 설정 저장", "ai-task-models-import": "가져오기", "ai-connection-key-fill": "키 자동 채움" };

const FOLD = "min-w-0 rounded-lg border border-line bg-bg-card scroll-mt-6";
const SUMMARY = "flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[15px] font-semibold";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 실행 방식 폼에 넘길 실행 쪽 순위 사정 — 화면 글 시각(at)·30분 안인가(fresh)를 서버에서 정한다(예전 순위판과 같은 값). */
function runtimeLine(slot: AiTaskSlotView | undefined, now: Date): TaskRuntimeLine {
  const runtime = slot?.runtime;
  if (!runtime) return null;
  const at = Date.parse(runtime.at);
  return { ...runtime, observedAt: runtime.at, fresh: now.getTime() >= at && now.getTime() - at <= 30 * 60_000, at: formatListTime(runtime.at, now),
    served: [...runtime.served], unusable: [...runtime.unusable] };
}

/**
 * 작업 배정(/admin/models/tasks) — 「어느 작업이 어느 모델로 가나? 설정대로 가고 있나?」(2026-11-07 승인 시안 PR 4).
 * 맨 위는 작업 × 칸마다 「설정 vs 실제」 표(1·2·3순위 · 장부의 최근 1시간 모델별 호출 · 상태와 까닭)이고, 줄의 「바꾸기」가 운영 홈과 같은 순위 서랍을 연다.
 * 순위 편집은 그 서랍 하나다(예전 줄마다 펼치던 순위판은 없앴다). 실행 방식(대체 실행·작업 분산)·가져오기·최근 기록은 표 아래 접힘이다.
 * 연결 추가·편집·키·모델 목록·동시 실행 한도는 LLM 운영(/admin/models/llm)으로 옮겼다 — 옛 ?edit=<연결> 주소는 그 행으로 넘긴다.
 */
export default async function AiTasksPage({ searchParams }: Props) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const editId = one(params.edit);
  if (UUID.test(editId)) redirect(`/admin/models/llm?edit=${editId}#conn-${editId}`);
  const now = new Date();
  const [view, preview, executionRead] = await Promise.all([readAiTasksAdminView(), one(params.import) === "plan" ? previewAiTaskImport() : Promise.resolve(null),
    readAiTaskExecutionAdminViews().then(executions => ({ executions, failed: false }), () => ({ executions: [], failed: true }))]);
  const readOnly = adminWorkspaceReadOnly();
  const errors = Object.entries(view.errors);
  const unread = aiUnreadConnections(view.connections, view.keyConflicts);
  const modes = executionRead.executions.filter(execution => aiTaskSupportsWorkloadPool(execution.task, execution.slot) || execution.mode !== "fallback");
  const pooled = modes.filter(execution => execution.mode === "workload_pool").length;
  const slotOf = (task: string, slot: number) => view.slots.find(entry => entry.task.id === task && entry.slot === slot);
  return <main className="stack mt-task-page">
    <PageStamp />
    <h1 className="admin-vh">LLM 운영 · 작업 배정</h1>
    {errors.map(([key, error]) => <p key={key} role="alert" className="llm-notice">{ERROR_LABELS[key] ?? key}을(를) 읽지 못했습니다({aiTaskIssueMessage(error)}).</p>)}
    {unread.length > 0 && <p role="status" data-unread={unread.length} className="llm-notice">
      모델 목록을 못 읽은 서버 — {unread.map((row, index) => <span key={row.id}>{index > 0 && ", "}<Link href={`/admin/models/llm?edit=${row.id}#conn-${row.id}`} prefetch={false}
        className="font-semibold underline">{modelPickerConnectionLabel(view.connections.find(connection => connection.id === row.id)!)}</Link>({row.reason})</span>)}. 이 서버의 모델은 순위 선택지에 없습니다 — 이름을 눌러 LLM 운영에서 키를 넣거나 「다시 읽기」를 누르세요.</p>}
    <section id="tasks" className="min-w-0 scroll-mt-6" aria-label="작업 배정 — 설정과 실제">
      <Suspense fallback={<p aria-busy="true" className="notice">작업 순위와 최근 1시간 호출을 읽는 중…</p>}>
        <TaskAssignSlot view={view} executions={executionRead.failed ? null : executionRead.executions} readOnly={readOnly} />
      </Suspense>
    </section>
    <details id="modes" className={FOLD}>
      <summary className={SUMMARY}><h2>실행 방식</h2><span className="text-[13px] font-normal text-fg-3">대체 실행 · 작업 분산{pooled ? ` — 분산 ${pooled}개` : ""} · 지원하는 작업 {modes.length}개</span></summary>
      <div className="grid gap-3 px-3 pb-3">
        <p className="text-[13px] text-fg-3">대체 실행은 1순위 모델 하나를 쓰고 필요할 때만 다음 순위로 넘깁니다. 작업 분산은 서로 다른 업무를 여러 모델에 나눕니다. 저장은 작업마다 따로 합니다.</p>
        {executionRead.failed ? <p role="alert" className="text-[13px] text-red-600">실행 방식을 읽지 못했습니다. 현재 방식을 확인할 때까지 작업 설정을 저장할 수 없습니다.</p>
          : modes.map(execution => {
            const slot = slotOf(execution.task, execution.slot);
            if (!slot) return null;
            return <section key={`${execution.task}#${execution.slot}`} id={`mode-${execution.task}-${execution.slot}`} className="mt-task-mode-item grid gap-1 scroll-mt-6">
              <h3 className="text-[14px] font-semibold">{slot.label}</h3>
              <TaskExecutionForm key={`${execution.task}#${execution.slot}#${execution.revision ?? "default"}`} view={execution} label={slot.label} options={[...slot.options]}
                connections={view.connections} readOnly={readOnly} runtime={runtimeLine(slot, now)} />
            </section>;
          })}
      </div>
    </details>
    <section id="connections" className={`${FOLD} grid gap-1 px-3 py-2`} aria-labelledby="connections-title">
      <h2 id="connections-title" className="text-[15px] font-semibold">AI 연결</h2>
      <p className="text-[13px] text-fg-3">연결 추가·편집, 키, CLI·OpenCode 모델, 모델 목록 다시 읽기, 동시 실행 한도, 지우기는 LLM 운영에서 합니다. 서버 {view.connections.length}개
        {unread.length > 0 && <> · <span className="text-amber-700">목록 못 읽음 {unread.length}</span></>}{view.policyMode && <> · 용량 정책 {view.policyMode.toUpperCase()}</>}.</p>
      <p><Link href="/admin/models/llm" prefetch={false} className="text-[13px] font-semibold text-accent-ink underline">LLM 운영에서 연결 관리 →</Link></p>
    </section>
    <details id="import" className={FOLD} open={one(params.import) === "plan"}>
      <summary className={SUMMARY}><h2>지금 설정 가져오기</h2><span className="text-[13px] font-normal text-fg-3">옛 설정의 모델을 연결·순위로 옮깁니다(빈 칸만)</span></summary>
      <div className="px-3 pb-3"><TaskImportCard preview={preview} confirmWord={AI_TASK_IMPORT_CONFIRM} /></div>
    </details>
    <details id="audit" className={FOLD}>
      <summary className={SUMMARY}><h2>최근 기록</h2><span className="text-[13px] font-normal text-fg-3">최근 {Math.min(view.audit.length, RECENT_AUDIT_ROWS)}건</span></summary>
      <div className="grid gap-2 px-3 pb-3">
      {view.audit.length === 0 ? <p className="text-[13px] text-fg-3">아직 기록이 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">누가</th><th className="py-2 pr-3">무엇</th><th className="py-2 pr-3">대상</th><th className="py-2 pr-3">내용</th></tr></thead>
          <tbody>{view.audit.slice(0, RECENT_AUDIT_ROWS).map(row => <tr key={row.id} className="border-b border-line align-top">
            <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(row.at, now)}</td><td className="py-2 pr-3">{row.actor}</td>
            <td className="py-2 pr-3">{ACTION_LABELS[row.action] ?? row.action}</td>
            <td className="py-2 pr-3">{row.action === "ai-task-models-save" || row.action === "ai-task-execution-save" ? aiTaskTargetLabel(row.target) : row.target}</td>
            <td className={`py-2 pr-3 ${row.ok ? "" : "text-red-600"}`}>{row.summary}</td>
          </tr>)}</tbody></table></div>}
      <Link href={llmHistoryHref()} prefetch={false} className="text-[13px] font-semibold text-accent-ink">LLM 운영 › 기록에서 전체 보기 →</Link>
      </div>
    </details>
  </main>;
}
