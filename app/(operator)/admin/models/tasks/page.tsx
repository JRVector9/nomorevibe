import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { AI_CLI_TOOL_LABELS } from "@/lib/llm/ai-tasks";
import { AI_TASK_IMPORT_CONFIRM, aiModelsErrorText, aiRankPendingText, aiTaskIssueMessage } from "@/lib/operations/admin-ai-tasks";
import { aiTaskTargetLabel, previewAiTaskImport, readAiTasksAdminView } from "@/lib/operations/admin-ai-tasks-repository";
import { PageStamp } from "../../components/PageStamp";
import { DeleteConnectionButton, RereadModelsButton } from "./ConnectionButtons";
import { ConnectionForm } from "./ConnectionForm";
import { TaskImportCard } from "./TaskImportCard";
import { TaskRanksBoard, type TaskRankLine } from "./TaskRanksBoard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "작업 ↔ AI 모델 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const one = (value: string | string[] | undefined) => typeof value === "string" ? value.trim() : Array.isArray(value) ? (value[0] ?? "").trim() : "";
const ERROR_LABELS: Record<string, string> = { connections: "AI 연결", rows: "작업 ↔ 모델 순위", readiness: "계약·정책·장비", policy: "용량 정책", current: "지금 실제로 쓰는 모델",
  audit: "최근 기록", runtime: "실행 쪽 순위 사정" };
const ACTION_LABELS: Record<string, string> = { "ai-connection-save": "연결 저장", "ai-connection-models-read": "모델 목록 읽기", "ai-connection-delete": "연결 지움",
  "ai-task-models-save": "순위 저장", "ai-task-models-import": "가져오기" };

/**
 * 작업 ↔ AI 모델(2026-11-02 소유자 결정, PR A·B) — 「AI 연결」(API 주소·키 또는 CLI)을 저장하고, 작업마다(2차는 투표자마다) 1·2·3순위를 고른다.
 * 모델 선택지는 각 연결이 실제로 내놓는 모델(GET /models)과 CLI 모델 이름이다. 하드코딩한 주소·모델·환경변수로 고르지 않는다.
 * PR B 부터 글 짓기·번역·검색 text 일곱 작업은 실행 쪽이 이 순위만 읽는다(오른쪽에 지금 몇 순위가 일하는지·아래 순위를 쓴 까닭). 나머지는 PR C~D 가 옮긴다.
 */
export default async function AiTasksPage({ searchParams }: Props) {
  if (!await currentAdmin()) redirect("/admin/login");
  const params = await searchParams;
  const now = new Date();
  const [view, preview] = await Promise.all([readAiTasksAdminView(), one(params.import) === "plan" ? previewAiTaskImport() : Promise.resolve(null)]);
  const editId = one(params.edit), editing = editId ? view.connections.find(row => row.id === editId) ?? null : null;
  const used = (id: string) => view.rows.filter(row => row.connectionId === id).length;
  const lines: TaskRankLine[] = view.slots.map(slot => ({ task: slot.task.id, slot: slot.slot, label: slot.label, group: slot.task.group, kind: slot.task.kind,
    description: slot.task.description, revision: slot.revision, rows: [...slot.rows], options: [...slot.options],
    accepts: [slot.task.api ? "API 주소" : "", ...slot.task.cliTools.map(tool => AI_CLI_TOOL_LABELS[tool])].filter(Boolean).join(" · "),
    current: slot.current ? { labels: [...slot.currentLabels], source: slot.current.source, notes: [...slot.current.notes], error: slot.current.error, skip: slot.current.skip } : null,
    sameAsCurrent: slot.sameAsCurrent, readiness: slot.readiness.map(row => ({ rank: row.rank, blocking: [...row.blocking], warnings: [...row.warnings],
      pending: aiRankPendingText(row) })), live: slot.live,
    runtime: slot.runtime ? { ...slot.runtime, at: formatListTime(slot.runtime.at, now), served: [...slot.runtime.served], unusable: [...slot.runtime.unusable] } : null }));
  const errors = Object.entries(view.errors);
  return <main className="mx-auto grid max-w-7xl gap-6 p-4">
    <PageStamp />
    <header className="grid gap-1">
      <p className="flex flex-wrap gap-4 text-[13px] text-fg-3"><Link href="/admin/models">← 모델 운영 현황</Link><Link href="/admin/models/devices">장비 한도 →</Link>
        <Link href="/admin/models/contracts">모델 연결(계약) →</Link><Link href="/admin/models/assignments">모델 배정 →</Link></p>
      <h1 className="text-[22px] font-semibold">작업 ↔ AI 모델</h1>
      <p className="text-[13px] text-fg-3">AI 를 쓰는 작업마다 1·2·3순위 모델을 정합니다. 1순위를 쓸 수 없으면 2순위, 그다음 3순위입니다. 모델은 아래 「AI 연결」에 저장한 서버(주소·키)가
        실제로 내놓는 목록과 CLI 모델 이름에서만 고릅니다 — 코드에 박은 주소나 환경변수로 고르지 않습니다. 2차 AI 검수는 투표자마다 따로 정합니다.</p>
      <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] font-semibold text-amber-900">
        글 짓기·번역·검색의 text 작업 일곱(수집 소개 짓기·심사 사유 번역·제품 다국어 번역·한국어 소개 번역·검색어 번역·검색 키워드 짓기·검색 키워드 검수)은
        실행 쪽이 이 순위만 읽습니다 — 순위가 없거나 모두 쓸 수 없으면 기본값으로 대신 부르지 않고 멈추며 그 까닭이 상태 화면에 보입니다.
        심사·보강·벡터 작업은 아직 오늘의 설정으로 고릅니다(다음 단계에서 옮깁니다).</p>
      {errors.map(([key, error]) => <p key={key} role="alert" className="text-[13px] text-red-600">{ERROR_LABELS[key] ?? key}을(를) 읽지 못했습니다({aiTaskIssueMessage(error)}).</p>)}
    </header>
    <section id="connections" className="grid gap-3 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">AI 연결 ({view.connections.length})</h2>
      <p className="text-[13px] text-fg-3">API 연결은 저장할 때 GET /models 로 모델 목록을 읽습니다(「다시 읽기」는 1분에 한 번). 키는 암호화해 두고 화면에 다시 보이지 않습니다.
        장비 이름은 용량 장비(장비 한도 화면)의 이름입니다.</p>
      {view.connections.length === 0 ? <p className="text-[13px] text-fg-3">아직 연결이 없습니다. 아래에서 만들거나 「지금 설정 가져오기」로 오늘 쓰는 서버를 옮기세요.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">이름</th><th className="py-2 pr-3">주소 · 도구</th><th className="py-2 pr-3">모델</th><th className="py-2 pr-3">장비 · 칸</th>
          <th className="py-2 pr-3">상태</th><th className="py-2 pr-3">쓰는 순위</th><th className="py-2" /></tr></thead>
          <tbody>{view.connections.map(row => <tr key={row.id} className="border-b border-line align-top" data-connection={row.id}>
            <td className="py-2 pr-3 font-semibold">{row.label}{row.note && <div className="font-normal text-fg-3">{row.note}</div>}</td>
            <td className="py-2 pr-3">{row.kind === "api" ? <><code className="break-all">{row.baseUrl}</code><div className="text-fg-3">{row.hasKey ? "키 저장됨" : "키 없음"}
              {row.contextTokens ? ` · 상한 ${row.contextTokens} 토큰` : ""}</div></> : row.cliTool ? AI_CLI_TOOL_LABELS[row.cliTool] : "CLI"}</td>
            <td className="py-2 pr-3">{row.kind === "api" ? <>
              {row.models ? <details><summary className="cursor-pointer">{row.models.length}개</summary><ul className="mt-1 grid gap-0.5">{row.models.map(model =>
                <li key={model.id}><code className="break-all">{model.id}</code>{model.maxModelLen ? <span className="text-fg-3"> · {model.maxModelLen}</span> : null}</li>)}</ul></details>
                : <span className="text-fg-3">아직 못 읽음</span>}
              <div className="text-fg-3">{row.modelsReadAt ? `읽음 ${formatListTime(row.modelsReadAt, now)}` : ""}</div>
              {row.modelsError && <div className="text-red-600">마지막 오류: {aiModelsErrorText(row.modelsError)}</div>}
            </> : <code className="break-all">{row.cliModels.join(" ")}</code>}</td>
            <td className="py-2 pr-3"><code>{row.deviceId}</code> · {row.capacitySlots}칸</td>
            <td className="py-2 pr-3">{row.enabled ? "켜짐" : <span className="text-amber-700">꺼짐</span>}<div className="text-fg-3">판 {row.version}</div></td>
            <td className="py-2 pr-3 tabular-nums">{used(row.id)}</td>
            <td className="py-2"><div className="flex flex-col items-start gap-1">
              <Link href={`/admin/models/tasks?edit=${row.id}#connection-form`} prefetch={false} className="font-semibold text-accent-ink underline">고치기</Link>
              {row.kind === "api" && <RereadModelsButton id={row.id} />}
              {used(row.id) === 0 && <DeleteConnectionButton id={row.id} label={row.label} version={row.version} />}
            </div></td>
          </tr>)}</tbody></table></div>}
      <div id="connection-form" className="grid gap-2 scroll-mt-6">
        <h3 className="text-[15px] font-semibold">{editing ? `연결 고치기 — ${editing.label}` : "연결 만들기"}</h3>
        {editId && !editing && <p role="alert" className="text-[13px] text-amber-700">고칠 연결을 찾지 못했습니다 — 새 연결로 엽니다.</p>}
        <ConnectionForm key={editing?.id ?? "new"} initial={editing} secretBox={view.secretBox} />
      </div>
    </section>
    <section id="tasks" className="grid gap-3 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">작업 ↔ 모델</h2>
      <p className="text-[13px] text-fg-3">줄마다 저장합니다. 저장하면 그 순위가 오늘 실행 쪽에서 쓰일 수 있게 없는 장비 행·엔진 직접 계약(엔진에 1토큰 시험)·용량 경로(덧붙이기만, DRAIN 없음)를
        함께 만듭니다. 만들 수 없는 것이 빠졌으면 저장하지 않고 무엇이 없는지 보입니다. 기존 계약·경로·장비 값·장비 역할 순위는 바꾸지 않습니다.
        {view.policyMode && <> 용량 정책 {view.policyMode.toUpperCase()}.</>}</p>
      <TaskRanksBoard lines={lines} connections={[...view.connections]} rows={[...view.rows]} />
    </section>
    <section id="import" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">지금 설정 → 작업 ↔ 모델 가져오기</h2>
      <TaskImportCard preview={preview} confirmWord={AI_TASK_IMPORT_CONFIRM} />
    </section>
    <section id="audit" className="grid gap-2 scroll-mt-6">
      <h2 className="text-[18px] font-semibold">최근 기록 ({view.audit.length})</h2>
      {view.audit.length === 0 ? <p className="text-[13px] text-fg-3">아직 기록이 없습니다.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]"><thead><tr className="border-b border-line">
          <th className="py-2 pr-3">시각</th><th className="py-2 pr-3">누가</th><th className="py-2 pr-3">무엇</th><th className="py-2 pr-3">대상</th><th className="py-2 pr-3">내용</th></tr></thead>
          <tbody>{view.audit.map(row => <tr key={row.id} className="border-b border-line align-top">
            <td className="py-2 pr-3 whitespace-nowrap">{formatListTime(row.at, now)}</td><td className="py-2 pr-3">{row.actor}</td>
            <td className="py-2 pr-3">{ACTION_LABELS[row.action] ?? row.action}</td>
            <td className="py-2 pr-3">{row.action === "ai-task-models-save" ? aiTaskTargetLabel(row.target) : row.target}</td>
            <td className={`py-2 pr-3 ${row.ok ? "" : "text-red-600"}`}>{row.summary}</td>
          </tr>)}</tbody></table></div>}
      <Link href="/admin/activity" prefetch={false} className="text-[13px] font-semibold text-accent-ink">작업 로그에서 전체 보기 →</Link>
    </section>
  </main>;
}
