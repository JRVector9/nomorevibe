import Link from "next/link";
import { Panel } from "@/components/Panel";
import { formatDetailTime } from "@/lib/format/time";
import { textRankUnusableText, type TextRankResolution } from "@/lib/llm/ai-task-resolver";
import { aiTask } from "@/lib/llm/ai-tasks";
import type { AiTaskRuntimeView } from "@/lib/operations/admin-ai-tasks-repository";
import { ScrollTable } from "../components/ScrollTable";

export type TextTaskRanksLine = Readonly<{ task: string; resolution: TextRankResolution; runtime: AiTaskRuntimeView | null }>;

const STATUS_TEXT: Readonly<Record<TextRankResolution["status"], string>> = {
  ok: "", no_task_models: "순위 없음 — 이 작업은 돌지 않습니다(no_task_models)",
  task_models_unreadable: "순위 표를 읽지 못함(task_models_unreadable)",
};

/**
 * 「작업 ↔ 모델」 text 일곱 작업의 순위 사정(PR B) — 저장한 1·2·3순위와 쓸 수 없는 순위의 까닭, 실행 쪽의 마지막 틱에서 몇 순위가 일했고 아래 순위를 쓴 까닭.
 * 고치는 단추는 없다 — 순위는 /admin/models/tasks 에서 고친다. 순위·계약은 이 웹 프로세스의 스냅숏(30초)이다.
 */
export function TextTaskRanksStatus({ lines, error }: { lines: readonly TextTaskRanksLine[]; error?: string | null }) {
  return (
    <Panel title="작업 ↔ 모델 · text 작업 순위" actions={<Link href="/admin/models/tasks#tasks" prefetch={false} className="text-[13px] font-semibold text-accent-ink">순위 고치기 →</Link>}
      note="글 짓기·번역·검색 text 작업은 이 순위만 부릅니다. 1순위를 쓸 수 없으면 같은 일을 2순위, 그다음 3순위로 넘기고, 순위가 없거나 모두 쓸 수 없으면 기본값으로 대신 부르지 않고 멈춥니다(조치할 일에 「제 일 못 함」).">
      {error && <p role="alert" className="text-[13px] text-red-600">실행 기록을 읽지 못했습니다({error}).</p>}
      <ScrollTable label="text 작업 순위">
        <table className="mt-2 w-full min-w-[720px] text-left text-[13px]">
          <thead className="text-fg-3"><tr><th className="py-1 font-medium">작업</th><th className="font-medium">순위</th><th className="font-medium">실행(마지막 틱)</th></tr></thead>
          <tbody>{lines.map(line => {
            const served = line.runtime?.served.filter(row => row.count > 0) ?? [];
            return <tr key={line.task} className="border-t border-line align-top" data-task={line.task}>
              <td className="py-1 pr-3 font-semibold">{aiTask(line.task)?.label ?? line.task}</td>
              <td className="py-1 pr-3">{line.resolution.status !== "ok" ? <span className="text-red-600">{STATUS_TEXT[line.resolution.status]}</span>
                : <ol className="grid gap-0.5">{line.resolution.candidates.map(candidate => <li key={candidate.rank.rank}>
                  <span className="font-mono tabular-nums text-fg-3">{candidate.rank.rank}.</span> {candidate.rank.connection.label} · {candidate.rank.model}
                  {candidate.binding && candidate.binding.identity !== candidate.rank.model && <span className="text-fg-3"> (장부 이름 {candidate.binding.identity})</span>}
                  {candidate.unusable && <span className="text-amber-700"> — 쓸 수 없음: {textRankUnusableText(candidate.unusable)}</span>}</li>)}</ol>}</td>
              <td className="py-1">{!line.runtime ? <span className="text-fg-3">기록 없음</span> : <span className="grid gap-0.5">
                <span><time dateTime={line.runtime.at}>{formatDetailTime(line.runtime.at)}</time>{line.runtime.from === "web" ? " · 이 웹 프로세스" : ""}:{" "}
                  {served.length ? served.map(row => `${row.rank}순위 ${row.count}건`).join(" · ") : "맡은 순위 없음"}</span>
                {line.runtime.unusable.length > 0 && <span className="text-amber-700">{served.some(row => row.rank > 1) ? "아래 순위를 쓴 까닭 — " : "쉰 순위 — "}
                  {line.runtime.unusable.map(row => `${row.rank}순위: ${row.text}${row.count > 1 ? ` ×${row.count}` : ""}`).join(" / ")}</span>}
                {line.runtime.degraded && <span className="text-red-600">제 일 못 함 <code>{line.runtime.degraded.code}</code></span>}
              </span>}</td>
            </tr>;
          })}</tbody>
        </table>
      </ScrollTable>
    </Panel>
  );
}
