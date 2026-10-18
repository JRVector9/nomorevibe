import type { EvidenceVerdicts } from "@/lib/operations/flow-reads";
import type { ReplicaRead } from "@/lib/operations/replica-hold";
import { dbClock, enrichmentSummary, worstTone, type CellSummary, type EnrichmentNode, type FlowTone } from "../flow-model";

/**
 * 운영센터 v8 의 요약 칸 셋 — 들어오는 곳 · 발행 후 보강 · 설정 전환·재해 복구.
 *
 * 넓은 화면(1,181px 이상)에서는 레일 오른쪽의 빈 4칸에, 흐름 상세 탭에서는 맨 위에 같은 칸이 선다.
 * 글은 칸마다 세 줄(이름·값·설명), 줄마다 nowrap·말줄임이고 전체 문구는 title 로 본다 — 늦게 와도 높이가 바뀌지 않는다.
 * 쉬운 말 뒤에 코드 이름을 괄호로 함께 적는다.
 */
export const DOT_TONE: Record<FlowTone, "ok" | "warn" | "bad" | undefined> = { ok: "ok", warn: "warn", bad: "bad", idle: undefined };

export function FlowCell({ label, summary }: { label: string; summary: CellSummary }) {
  return (
    <section className="ops-v8-cell" data-tone={summary.tone} aria-label={label}>
      <span className="l">{label} <i className="ops-v8-new">새</i></span>
      <span className="v" title={summary.value}><span className="dash-dot" data-tone={DOT_TONE[summary.tone]} aria-hidden /> {summary.value}</span>
      <span className="s" title={summary.note}>{summary.note}</span>
    </section>
  );
}

/** 늦게 오는 칸의 자리 — 같은 높이(세 줄)를 미리 차지한다 */
export function FlowCellPending({ label }: { label: string }) {
  return (
    <section className="ops-v8-cell" aria-label={label} aria-busy="true">
      <span className="l">{label} <i className="ops-v8-new">새</i></span>
      <span className="v">세는 중…</span>
      <span className="s">&nbsp;</span>
    </section>
  );
}

/** 들어오는 곳 — 이번 시 GitHub · Show HN(복제본, 기준 시각) 과 X 보고 상태 */
export function SourceCell({ summary, x }: { summary: CellSummary & { at: string | null }; x: CellSummary }) {
  return <FlowCell label="들어오는 곳" summary={{ tone: worstTone(summary.tone, x.tone === "warn" ? "warn" : "idle"), value: summary.value,
    note: summary.at ? `이번 시 · ${x.value} · 기준 ${dbClock(summary.at)} (DB)` : `${summary.note} · ${x.value}` }} />;
}

export function EnrichmentCell({ nodes, evidence }: { nodes: EnrichmentNode[]; evidence: ReplicaRead<EvidenceVerdicts> }) {
  return <FlowCell label="발행 후 보강 12단계" summary={enrichmentSummary(nodes, evidence)} />;
}

export function TransitionCell({ summary }: { summary: CellSummary }) {
  return <FlowCell label="설정 전환 · 재해 복구" summary={summary} />;
}
