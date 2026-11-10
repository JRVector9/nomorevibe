import type { HumanAssistProgress, HumanAssistTask, HumanAssistWindow } from "@/lib/operations/human-assist-progress";

const n = (value: number) => value.toLocaleString("ko-KR");
type Read = Promise<HumanAssistProgress | null>;

/** 결과 갈래 → 한 줄. 작업마다 뜻이 다른 갈래만 쓰고, 부수 갈래(다시 받기·대상 아님·실패)는 0이면 뺀다 */
export function humanAssistLine(task: HumanAssistTask, w: HumanAssistWindow): string {
  const extra = (label: string, value: number) => value ? [`${label} ${n(value)}`] : [];
  const parts = task === "human-review"
    ? [`결정 ${n(w.approve + w.reject)}(공개로 ${n(w.approve)} · 반려 ${n(w.reject)})`, `사람에게 남김 ${n(w.held)}`, ...extra("원본 다시 받기", w.refresh)]
    : task === "split-confirm" ? [`반려 확정 ${n(w.reject)}`, `사람에게 남김 ${n(w.held)}`]
    : task === "split-tiebreak" ? [`재확인으로 넘김 ${n(w.forward)}`, `사람에게 남김 ${n(w.held)}`, ...extra("대상 아님", w.ineligible)]
    : [`반려 ${n(w.reject)}`, `2차로 넘김 ${n(w.forward)}`, `사람에게 남김 ${n(w.held)}`];
  return [...parts, ...extra("실패", w.failed)].join(" · ");
}

const WAITING_LABEL: Partial<Record<HumanAssistTask, string>> = { "human-review": "위임 판단 기록 없음", "split-confirm": "재확인 대기" };

/** AI 보조 카드 한 장의 처리 현황 — 최근 1시간·24시간에 끝낸 일과 지금 기다리는 수 */
export async function HumanAssistTaskProgress({ read, task }: { read: Read; task: HumanAssistTask }) {
  const progress = await read;
  if (!progress) return <><span className="flow-model-note">처리 현황</span><span className="flow-model-note">처리 현황을 읽지 못했습니다.</span></>;
  const row = progress.tasks[task];
  const waiting = WAITING_LABEL[task];
  return <>
    <span className="flow-model-note">처리 현황</span>
    <span className="flow-model-lines" data-testid={`human-assist-${task}`}>
      <span className="flow-model-line"><span className="flow-model-state">최근 1시간</span><span>{humanAssistLine(task, row.hour)}</span></span>
      <span className="flow-model-line"><span className="flow-model-state">최근 24시간</span><span>{humanAssistLine(task, row.day)}</span></span>
      {waiting && row.waiting !== null && <span className="flow-model-line"><span className="flow-model-state">{waiting}</span><span>{n(row.waiting)}건</span></span>}
    </span>
  </>;
}

/** 「사람이 처리할 일」의 24시간 AI 결정 — AI가 사람 대기열에서 빼낸 수 */
export async function HumanAssistDecided({ read }: { read: Read }) {
  const progress = await read;
  return <>{progress ? `${n(progress.decidedDay)}건` : "미확인"}</>;
}
