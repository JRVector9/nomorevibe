import Link from "next/link";
import { aiTask, aiTaskAccepts } from "@/lib/llm/ai-tasks";
import { formatCount, formatKst } from "@/lib/operations/console-tasks";
import { modelCompareHref, modelStageHref, type ModelConsoleRow } from "@/lib/operations/model-console";
import { SAMPLE_COMPARE_LIMITS, SAMPLE_COMPARE_TASKS, sampleCompareTask, sampleReasonText, sampleStatusText, sampleTally, type SampleComparison,
  type SampleSideResult } from "@/lib/operations/model-sample-compare";
import { SampleCompareRequestForm } from "./SampleCompareRequestForm";
import "../console/model-console.css";

/**
 * 표본 비교(2026-11-12 최종 시안 흐름 2 「밀린 단계에 모델 붙이기」의 2·3번, 조각 3a).
 * 남는 모델(사용률이 낮은 순)을 고르고 표본 수를 정해 요청하면, 그 작업의 배경 잡이 기존 호출 경로·용량 장부로 지금 모델과 후보 모델을 한 묶음씩 부른다.
 * 결과는 원문 · 두 결과 · 기존 품질 검사 통과 여부로 나란히 보이고, 운영 데이터에는 쓰지 않는다. 붙이는 일은 작업 배정의 순위 저장이 한다(저장 전 확인 포함).
 */
export function SampleCompare({ task, rows, candidate, model, records, readOnly }: { task: string; rows: readonly ModelConsoleRow[]; candidate: string | null;
  model: string | null; records: readonly SampleComparison[] | null; readOnly: boolean }) {
  const spec = sampleCompareTask(task) ?? SAMPLE_COMPARE_TASKS[0];
  const def = aiTask(spec.task);
  const current = rows.find(row => row.stages.some(stage => stage.task === spec.task && stage.slot === 1 && stage.rank === 1)) ?? null;
  const candidates = def ? rows.filter(row => row.enabled && row.id !== current?.id && aiTaskAccepts(def, row.connection))
    .sort((a, b) => (a.utilization ?? 0) - (b.utilization ?? 0) || b.limit - a.limit) : [];
  const open = records?.some(record => record.status === "queued" || record.status === "running") ?? false;
  return <div className="model-console">
    <div className="mc-head"><h2>표본 비교</h2><span className="mc-count">모델을 단계에 붙이기 전에 같은 입력의 결과를 나란히 봅니다 · 운영 데이터에는 쓰지 않습니다</span>
      <span className="mc-right"><Link prefetch={false} className="text-button" href="/admin/models">모델 목록</Link></span></div>
    <nav className="mc-acts" aria-label="작업">{SAMPLE_COMPARE_TASKS.map(entry => <Link key={entry.task} prefetch={false}
      className={`button small${entry.task === spec.task ? " primary" : ""}`} aria-current={entry.task === spec.task ? "page" : undefined}
      href={candidate ? modelCompareHref(entry.task, candidate, model) : `/admin/models/compare?task=${encodeURIComponent(entry.task)}`}>{entry.label}{entry.supported ? "" : " · 지원 안 함"}</Link>)}</nav>
    {!spec.supported ? <section className="mc-card" aria-label="지원 안 함">
      <p><b>지원 안 함</b> — {spec.reason}</p>
      <p className="mc-muted">이 단계는 작업 배정에서 순위를 저장하고(저장 전 확인), 홈의 「바꾼 것 지켜보기」로 전·후 처리량을 봅니다.</p>
      <div className="mc-acts"><Link prefetch={false} className="button small primary" href={modelStageHref(spec.task)}>단계에서 붙이기</Link></div>
    </section> : <section className="mc-card" aria-label="비교 요청">
      <dl className="mc-dl"><dt>단계</dt><dd>{def?.label ?? spec.label}</dd>
        <dt>지금 모델</dt><dd>{current ? current.name : <span className="mc-muted">1순위 없음 — 후보만 부릅니다</span>}</dd></dl>
      {candidates.length ? <SampleCompareRequestForm task={spec.task} readOnly={readOnly || open} selected={candidate}
        candidates={candidates.map(row => ({ id: row.id, name: row.name, limit: row.limit, utilization: row.utilizationText, models: [...row.models],
          model: row.id === candidate && model && row.models.includes(model) ? model : row.models[0] ?? "" }))}
        defaultSize={SAMPLE_COMPARE_LIMITS.defaultSize} maxSize={SAMPLE_COMPARE_LIMITS.maxSize} />
        : <p className="mc-muted">이 단계에 쓸 수 있는 다른 모델이 없습니다.</p>}
      {open && <p className="mc-muted">이 단계에 아직 끝나지 않은 비교가 있어 새 요청은 그 뒤에 할 수 있습니다.</p>}
    </section>}
    {records === null ? <p role="alert" className="mc-notice">비교 기록을 읽지 못했습니다.</p>
      : records.map(record => <SampleRecord key={record.id} record={record} />)}
    {records && !records.length && spec.supported && <p className="mc-muted">아직 이 단계의 비교 기록이 없습니다.</p>}
  </div>;
}

function Cell({ side }: { side: SampleSideResult | null }) {
  if (!side) return <span className="mc-muted">기다리는 중</span>;
  if (side.state === "skipped") return <span className="mc-muted">{sampleReasonText(side.reason) || "건너뜀"}</span>;
  if (side.state === "failed") return <span className="mc-st" data-tone="warn"><i aria-hidden="true" />결과 없음 · {sampleReasonText(side.reason)}</span>;
  return <span className="mc-out" data-pass={side.pass ? "true" : "false"}>{side.output}
    {!side.pass && <> <span className="mc-st" data-tone="warn"><i aria-hidden="true" />{sampleReasonText(side.reason)}</span></>}</span>;
}

function SampleRecord({ record }: { record: SampleComparison }) {
  const tally = sampleTally(record);
  const done = record.status === "done";
  return <section className="mc-card" style={{ maxWidth: "none" }} aria-label={`비교 ${record.id}`} data-comparison={record.id}>
    <div className="mc-head"><span className="mc-lab">#{record.id} · {record.current ? `${record.current.name} ↔ ` : ""}{record.candidate.name}</span>
      <span className="mc-st" data-tone={record.status === "failed" ? "bad" : done ? "ok" : "off"}><i aria-hidden="true" />{sampleStatusText(record)}</span>
      <span className="mc-count">{formatKst(record.requestedAt)} 요청 · {record.requestedBy}</span></div>
    <p className="mc-kv"><span>표본<b>{formatCount(tally.total)}</b></span>
      {tally.current && record.current && <span>검사 통과 · {record.current.name}<b>{formatCount(tally.current.pass)}/{formatCount(tally.current.done)}</b></span>}
      <span>검사 통과 · {record.candidate.name}<b>{formatCount(tally.candidate.pass)}/{formatCount(tally.candidate.done)}</b></span></p>
    <div className="mc-scroll"><table className="mc-table" style={{ minWidth: 640 }}>
      <colgroup><col style={{ width: "30%" }} /><col /><col /></colgroup>
      <thead><tr><th scope="col">원문</th><th scope="col">{record.current?.name ?? "지금 모델 없음"}</th><th scope="col">{record.candidate.name}</th></tr></thead>
      <tbody>{record.items.map(item => <tr key={item.productId}>
        <td className="q top">{item.text}<br /><span className="mc-muted">{item.name}</span></td>
        <td className="top">{record.current ? <Cell side={item.current} /> : <span className="mc-muted">—</span>}</td>
        <td className="top"><Cell side={item.candidate} /></td></tr>)}</tbody>
    </table></div>
    {done && <div className="mc-acts">
      <Link prefetch={false} className="button small primary" href={modelStageHref(record.task)}>이 모델을 붙이기</Link>
      <Link prefetch={false} className="button small" href="/admin/models">붙이지 않기</Link>
      <span className="mc-muted">붙이기는 작업 배정에서 순위로 저장합니다(저장 전 확인을 거칩니다).</span></div>}
  </section>;
}
