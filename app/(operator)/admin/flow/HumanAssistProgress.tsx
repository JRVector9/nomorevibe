import { HUMAN_ASSIST_WINDOW_LABELS, HUMAN_ASSIST_WINDOWS, type HumanAssistProgress, type HumanAssistTask,
  type HumanAssistWindow } from "@/lib/operations/human-assist-progress";

const n = (value: number) => value.toLocaleString("ko-KR");
type Read = Promise<HumanAssistProgress | null>;
type FactKind = "decided" | "forward" | "held" | "failed" | "extra";
export type HumanAssistFact = { kind: FactKind; label: string; value: number; note: string };

/**
 * 결과 갈래 → 카드의 숫자들. 작업마다 뜻이 다른 갈래만 쓰고, 부수 갈래(다시 받기·대상 아님·실패)는 0이면 뺀다.
 *  - 위임 검수: 결정(공개로·반려) · 사람에게 남김 · 원본 다시 받기 · 실패
 *  - 갈림 재확인: 결정(반려 확정) · 사람에게 남김 · 실패
 *  - 갈림 판가름: 넘김(재확인으로) · 사람에게 남김 · 대상 아님 · 실패
 *  - 보류 재심사: 결정(반려) · 넘김(2차로) · 사람에게 남김 · 실패
 */
export function humanAssistFacts(task: HumanAssistTask, w: HumanAssistWindow): HumanAssistFact[] {
  const facts: HumanAssistFact[] = [];
  if (task === "human-review") facts.push({ kind: "decided", label: "결정", value: w.approve + w.reject, note: `공개로 ${n(w.approve)} · 반려 ${n(w.reject)}` });
  if (task === "split-confirm") facts.push({ kind: "decided", label: "결정", value: w.reject, note: "반려 확정" });
  if (task === "held-review-retry") facts.push({ kind: "decided", label: "결정", value: w.reject, note: "반려" });
  if (task === "split-tiebreak") facts.push({ kind: "forward", label: "넘김", value: w.forward, note: "재확인으로" });
  if (task === "held-review-retry") facts.push({ kind: "forward", label: "넘김", value: w.forward, note: "2차로" });
  facts.push({ kind: "held", label: "사람에게 남김", value: w.held, note: "" });
  if (task === "human-review" && w.refresh) facts.push({ kind: "extra", label: "원본 다시 받기", value: w.refresh, note: "" });
  if (task === "split-tiebreak" && w.ineligible) facts.push({ kind: "extra", label: "대상 아님", value: w.ineligible, note: "" });
  if (w.failed) facts.push({ kind: "failed", label: "실패", value: w.failed, note: "" });
  return facts;
}

/** 한 줄 글 — 화면 읽기 프로그램용 요약과 시험이 쓴다 */
export function humanAssistLine(task: HumanAssistTask, w: HumanAssistWindow): string {
  return humanAssistFacts(task, w).map(fact => fact.kind === "decided" && fact.note.includes("·") ? `${fact.label} ${n(fact.value)}(${fact.note})`
    : fact.kind === "forward" ? `${fact.note} 넘김 ${n(fact.value)}` : fact.kind === "decided" ? `${fact.note} ${n(fact.value)}`
    : `${fact.label} ${n(fact.value)}`).join(" · ");
}

/** 막대의 너비(%) — 결정·넘김·사람에게 남김·실패. 부수 갈래(다시 받기·대상 아님)는 막대에 넣지 않는다 */
function barWidths(facts: readonly HumanAssistFact[]): { kind: FactKind; width: string }[] {
  const parts = facts.filter(fact => fact.kind !== "extra" && fact.value > 0);
  const total = parts.reduce((sum, fact) => sum + fact.value, 0);
  return total ? parts.map(fact => ({ kind: fact.kind, width: `${(fact.value / total * 100).toFixed(1)}%` })) : [];
}

const WAITING_LABEL: Partial<Record<HumanAssistTask, string>> = { "split-confirm": "재확인 대기" };

/**
 * AI 보조 카드 한 장의 처리 현황 — 5분·1시간·24시간 세 창을 모두 그리고, 카드 묶음(.flow-human-assist[data-window])이 고른 창만 보인다.
 * 기간 단추는 클라이언트(HumanWork) 상태라 서버에서 다시 읽지 않는다.
 */
export async function HumanAssistTaskProgress({ read, task }: { read: Read; task: HumanAssistTask }) {
  const progress = await read;
  if (!progress) return <p className="flow-model-note">처리 현황을 읽지 못했습니다.</p>;
  const row = progress.tasks[task];
  const waiting = WAITING_LABEL[task];
  return <>{HUMAN_ASSIST_WINDOWS.map(windowKey => {
    const facts = humanAssistFacts(task, row[windowKey]);
    const bar = barWidths(facts);
    return <div key={windowKey} className="flow-assist-window" data-window-block={windowKey} role="group"
      aria-label={`${HUMAN_ASSIST_WINDOW_LABELS[windowKey]} ${humanAssistLine(task, row[windowKey])}`} data-testid={`human-assist-${task}-${windowKey}`}>
      <div className="flow-assist-bar" aria-hidden="true">{bar.map(part => <span key={part.kind} data-kind={part.kind} style={{ width: part.width }} />)}</div>
      <div className="flow-assist-facts" aria-hidden="true">
        {facts.map(fact => <span key={`${fact.kind}:${fact.label}`} className="flow-assist-fact" data-kind={fact.kind}>
          {fact.kind !== "extra" && <i />}<span className="flow-model-note">{fact.label}</span><b>{n(fact.value)}</b>
          {fact.note && <span className="flow-model-note">{fact.note}</span>}</span>)}
        {waiting && row.waiting !== null && <span className="flow-assist-wait flow-model-note">{waiting} {n(row.waiting)}건</span>}
      </div>
    </div>;
  })}</>;
}

/** 위임 검수가 본 것 중 결정한 몫 — 창마다 한 줄. 결정하지 못한 것은 사람에게 남는다(확신 문턱) */
export async function HumanAssistInsight({ read }: { read: Read }) {
  const progress = await read;
  if (!progress) return null;
  const row = progress.tasks["human-review"];
  return <>{HUMAN_ASSIST_WINDOWS.map(windowKey => {
    const w = row[windowKey];
    const decided = w.approve + w.reject;
    const seen = decided + w.held + w.refresh;
    return <p key={windowKey} className="small flow-assist-window flow-assist-insight" data-window-block={windowKey}>
      {seen ? <><b>{HUMAN_ASSIST_WINDOW_LABELS[windowKey]} 위임 검수가 본 {n(seen)}건 중 결정 {n(decided)}건({Math.round(decided / seen * 100)}%).</b>{" "}
        결정하지 못한 것은 확신 0.9 문턱에 걸려 사람에게 남습니다.</>
        : <>{HUMAN_ASSIST_WINDOW_LABELS[windowKey]} 위임 검수가 끝낸 판단이 없습니다.</>}
    </p>;
  })}</>;
}

/** 「사람이 처리할 일」의 24시간 AI 결정 — AI가 사람 대기열에서 빼낸 수 */
export async function HumanAssistDecided({ read }: { read: Read }) {
  const progress = await read;
  return <>{progress ? `${n(progress.decidedDay)}건` : "미확인"}</>;
}
