import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { AI_CLI_TOOL_LABELS } from "@/lib/llm/ai-tasks";
import { AI_TASK_IMPORT_CONFIRM, aiModelsErrorText, aiRankPendingText, aiTaskIssueMessage, aiUnreadConnections } from "@/lib/operations/admin-ai-tasks";
import { aiTaskTargetLabel, previewAiTaskImport, readAiTasksAdminView } from "@/lib/operations/admin-ai-tasks-repository";
import { readAiTaskExecutionAdminViews } from "@/lib/operations/admin-ai-task-execution";
import { PageStamp } from "../../components/PageStamp";
import { DeleteConnectionButton, RereadModelsButton } from "./ConnectionButtons";
import { ConnectionForm } from "./ConnectionForm";
import { TaskImportCard } from "./TaskImportCard";
import { TaskRanksBoard, type TaskRankLine } from "./TaskRanksBoard";
import { modelPickerConnectionDevice, modelPickerConnectionLabel, modelPickerConnectionModels, modelPickerModelLabel, modelPickerVisibleText } from "../model-picker-display";
import "./tasks.css";
import { llmHistoryHref, RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "작업 배정 · LLM 운영 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";
const ERROR_LABELS: Record<string, string> = { connections: "AI 연결", rows: "작업 ↔ 모델 순위", readiness: "계약·정책·장비", policy: "용량 정책", current: "실행 쪽 모델 설정",
  audit: "최근 기록", runtime: "실행 쪽 순위 사정" };
const ACTION_LABELS: Record<string, string> = { "ai-connection-save": "연결 저장", "ai-connection-models-read": "모델 목록 읽기", "ai-connection-delete": "연결 지움",
  "ai-task-models-save": "순위 저장", "ai-task-execution-save": "실행 설정 저장", "ai-task-models-import": "가져오기", "ai-connection-key-fill": "키 자동 채움" };

const FOLD = "min-w-0 rounded-lg border border-line bg-bg-card scroll-mt-6";
const SUMMARY = "flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[15px] font-semibold";

/**
 * 작업 ↔ AI 모델(2026-11-02 소유자 결정, PR A·B·C1) — 작업마다(2차는 투표자마다) 1·2·3순위를 고른다.
 * 화면 단순화(2026-11-02 소유자 지시): 맨 위는 작업 한 줄마다 1·2·3순위 드롭다운과 저장뿐이고, 드롭다운은 서버(AI 연결)마다 그 서버가 서비스하는 모델(GET /models·CLI 모델 이름)만 보인다.
 * 「AI 연결 관리」(주소·키·CLI)·「지금 설정 가져오기」·「최근 기록」은 아래에 접어 둔다(고치기·계획 보기·연결이 없을 때는 펼친다). 하드코딩한 주소·모델·환경변수로 고르지 않는다.
 */
export default async function AiTasksPage({ searchParams }: Props) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const now = new Date();
  const [view, preview, executionRead] = await Promise.all([readAiTasksAdminView(), one(params.import) === "plan" ? previewAiTaskImport() : Promise.resolve(null),
    readAiTaskExecutionAdminViews().then(executions => ({ executions, failed: false }), () => ({ executions: [], failed: true }))]);
  const editId = one(params.edit), editing = editId ? view.connections.find(row => row.id === editId) ?? null : null;
  const visibleText = (text: string) => modelPickerVisibleText(text, view.connections);
  const used = (id: string) => view.rows.filter(row => row.connectionId === id).length
    + executionRead.executions.reduce((count, execution) => count + execution.members.filter(member => member.connectionId === id).length, 0);
  const lines: TaskRankLine[] = view.slots.map(slot => ({ task: slot.task.id, slot: slot.slot, label: slot.label, group: slot.task.group, kind: slot.task.kind,
    description: slot.task.description, revision: slot.revision, rows: [...slot.rows], options: [...slot.options],
    accepts: [slot.task.api ? "API 주소" : "", ...slot.task.cliTools.map(tool => AI_CLI_TOOL_LABELS[tool])].filter(Boolean).join(" · "),
    current: slot.current ? { labels: slot.currentLabels.map(visibleText), source: slot.current.source, notes: slot.current.notes.map(visibleText), error: slot.current.error, skip: slot.current.skip } : null,
    sameAsCurrent: slot.sameAsCurrent, readiness: slot.readiness.map(row => ({ rank: row.rank, blocking: row.blocking.map(visibleText), warnings: row.warnings.map(visibleText),
      pending: aiRankPendingText(row).map(visibleText) })), live: slot.live,
    runtime: slot.runtime ? { ...slot.runtime, observedAt: slot.runtime.at,
      fresh: now.getTime() >= Date.parse(slot.runtime.at) && now.getTime() - Date.parse(slot.runtime.at) <= 30 * 60_000,
      at: formatListTime(slot.runtime.at, now), served: [...slot.runtime.served], unusable: [...slot.runtime.unusable] } : null }));
  const errors = Object.entries(view.errors);
  const unread = aiUnreadConnections(view.connections, view.keyConflicts);
  return <main className="mt-task-page grid min-w-0 gap-3">
    <PageStamp />
    <header className="grid gap-1">
      <p className="text-[13px] text-fg-3"><Link href="/admin/models">← LLM 운영 대시보드</Link></p>
      <h1 className="text-[22px] font-semibold">작업 배정 <span className="text-[15px] font-normal text-fg-3">작업 ↔ AI 모델 순위</span></h1>
      <p className="text-[13px] text-fg-3">Flow 단계와 같은 실제 적용 설정입니다. 대체 실행·작업 분산은 각 작업의 실행 방식을 따릅니다. 별도 설정 작업은 실제 설정 화면에서 변경합니다.</p>
      {executionRead.failed && <p role="alert" className="text-[13px] text-red-600">실행 방식을 읽지 못했습니다. 현재 방식을 확인할 때까지 작업 설정을 저장할 수 없습니다.</p>}
      {errors.map(([key, error]) => <p key={key} role="alert" className="text-[13px] text-red-600">{ERROR_LABELS[key] ?? key}을(를) 읽지 못했습니다({aiTaskIssueMessage(error)}).</p>)}
      {unread.length > 0 && <p role="status" data-unread={unread.length} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
        모델 목록을 못 읽은 서버 — {unread.map((row, index) => <span key={row.id}>{index > 0 && ", "}<Link href={`/admin/models/tasks?edit=${row.id}#connection-form`} prefetch={false}
          className="font-semibold underline">{modelPickerConnectionLabel(view.connections.find(connection => connection.id === row.id)!)}</Link>({row.reason})</span>)}. 이 서버의 모델은 드롭다운에 없습니다 — 이름을 눌러 키를 넣거나 「다시 읽기」를 누르세요.</p>}
    </header>
    <section id="tasks" className="min-w-0 scroll-mt-6" aria-label="작업 ↔ 모델">
      <TaskRanksBoard lines={lines} connections={[...view.connections]} rows={[...view.rows]} executions={executionRead.executions} readOnly={executionRead.failed} />
    </section>
    <details id="connections" className={FOLD} open={!!editId || view.connections.length === 0}>
      <summary className={SUMMARY}><h2>AI 연결 관리</h2><span className="text-[13px] font-normal text-fg-3">서버 {view.connections.length}개
        {unread.length > 0 && <> · <span className="text-amber-700">목록 못 읽음 {unread.length}</span></>} · 주소·키·CLI 모델 이름</span></summary>
      <div className="grid gap-2 px-3 pb-3">
      <p role="note" className="rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px]">연결·모델 목록·동시 실행 한도는 이제 <Link href="/admin/models/llm" prefetch={false} className="font-semibold text-accent-ink underline">LLM 운영</Link>에서 한 줄씩 보고 고칩니다(한도는 장비 행 한 곳). 이 표와 폼은 옮기는 동안 그대로 둡니다.</p>
      <p className="text-[13px] text-fg-3">API 저장 시 모델 목록을 읽습니다. 키는 암호화되며 다시 표시하지 않습니다. 작업 설정 저장 시 필요한 연결 자원을 확인합니다.
        {view.policyMode && <> 용량 정책 {view.policyMode.toUpperCase()}.</>}</p>
      <p className="flex flex-wrap gap-3 text-[13px] text-fg-3"><Link href="/admin/models/devices">장비 한도 →</Link>
        <Link href="/admin/models/contracts">모델 연결(계약) →</Link><Link href="/admin/models/assignments">모델 배정 →</Link></p>
      {view.connections.length === 0 ? <p className="text-[13px] text-fg-3">아직 연결이 없습니다. 아래에서 만들거나 「지금 설정 가져오기」로 오늘 쓰는 서버를 옮기세요.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">이름</th><th className="py-2 pr-3">주소 · 도구</th><th className="py-2 pr-3">모델</th><th className="py-2 pr-3">공유 장비</th>
          <th className="py-2 pr-3">상태</th><th className="py-2 pr-3">저장된 순위·분산 모델</th><th className="py-2" /></tr></thead>
          <tbody>{view.connections.map(row => <tr key={row.id} className="border-b border-line align-top" data-connection={row.id}>
            <td className="py-2 pr-3 font-semibold">{modelPickerConnectionLabel(row)}{row.note && <div className="font-normal text-fg-3">{row.note}</div>}</td>
            <td className="py-2 pr-3">{row.kind === "api" ? <><code className="break-all">{row.baseUrl}</code><div className="text-fg-3">{row.hasKey ? "키 저장됨" : "키 없음"}
              {row.contextTokens ? ` · 상한 ${row.contextTokens} 토큰` : ""}</div></> : row.cliTool ? AI_CLI_TOOL_LABELS[row.cliTool] : "CLI"}</td>
            <td className="py-2 pr-3">{row.kind === "api" ? <>
              {row.models ? <details><summary className="cursor-pointer">{modelPickerConnectionModels(row)!.length}개</summary><ul className="mt-1 grid gap-0.5">{modelPickerConnectionModels(row)!.map(model =>
                <li key={model.id}><code className="break-all">{modelPickerModelLabel(row, model.id)}</code>{model.maxModelLen ? <span className="text-fg-3"> · {model.maxModelLen}</span> : null}</li>)}</ul></details>
                : <span className="text-fg-3">아직 못 읽음</span>}
              <div className="text-fg-3">{row.modelsReadAt ? `읽음 ${formatListTime(row.modelsReadAt, now)}` : ""}</div>
              {row.modelsError && <div className="text-red-600">마지막 오류: {aiModelsErrorText(row.modelsError)}</div>}
            </> : <>{row.cliTool === "opencode" ? <details><summary className="cursor-pointer">마지막 저장된 모델 {row.cliModels.length}개</summary>
              <ul className="mt-1 grid max-h-64 gap-1 overflow-y-auto">{row.cliModels.map(model => <li key={model}><code className="break-all">{model}</code></li>)}</ul></details>
              : <code className="break-all">{row.cliModels.join(" ")}</code>}
              <div className="text-fg-3">{row.cliVersion ? <>CLI 버전 <code>{row.cliVersion}</code></> : "CLI 버전 없음 — 1차·2차 순위에 쓰려면 적으세요"}</div>
              {row.cliTool === "opencode" && <div className="text-fg-3">{row.hasKey ? "호스트 RPC 인증 정보 저장됨" : "호스트 RPC 인증 정보 미확인"}</div>}</>}</td>
            <td className="py-2 pr-3"><code>{modelPickerConnectionDevice(row)}</code><div><Link href="/admin/models/devices" className="text-accent-ink underline">공유 한도 확인</Link></div></td>
            <td className="py-2 pr-3">{row.enabled ? "켜짐" : <span className="text-amber-700">꺼짐</span>}<div className="text-fg-3">판 {row.version}</div></td>
            <td className="py-2 pr-3 tabular-nums">{used(row.id)}</td>
            <td className="py-2"><div className="flex flex-col items-start gap-1">
              <Link href={`/admin/models/tasks?edit=${row.id}#connection-form`} prefetch={false} className="font-semibold text-accent-ink underline">고치기</Link>
              {row.kind === "api" && <RereadModelsButton id={row.id} />}
              {!executionRead.failed && used(row.id) === 0 && <DeleteConnectionButton id={row.id} label={row.label} version={row.version} />}
            </div></td>
          </tr>)}</tbody></table></div>}
      <div id="connection-form" className="grid gap-2 scroll-mt-6">
        <h3 className="text-[15px] font-semibold">{editing ? `연결 고치기 — ${modelPickerConnectionLabel(editing)}` : "연결 만들기"}</h3>
        {editId && !editing && <p role="alert" className="text-[13px] text-amber-700">고칠 연결을 찾지 못했습니다 — 새 연결로 엽니다.</p>}
        <ConnectionForm key={editing?.id ?? "new"} initial={editing} secretBox={view.secretBox} />
      </div>
      </div>
    </details>
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
