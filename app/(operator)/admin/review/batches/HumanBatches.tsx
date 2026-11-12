import Link from "next/link";
import type { ReactNode } from "react";
import { REVIEW_REJECT_REASONS } from "@/lib/crawl/review";
import { DEEPSEEK_MIN_CONFIDENCE } from "@/lib/crawl/deepseek-review-policy";
import { candidateHref, HUMAN_BATCH_GUIDE, HUMAN_BATCH_LOG_ANCHOR, HUMAN_BATCH_THRESHOLD_ANCHOR, HUMAN_BATCHES_HREF, humanBatchAnchor,
  humanBatchGateView, humanBatchResultLine, humanBatchStrip, humanHoldRows, humanWhyRows, ONE_BY_ONE_HREF, type HumanBatchKey } from "@/lib/crawl/human-batch-model";
import type { HumanBatchPanel, HumanBatchesRead } from "@/lib/operations/human-batches-read";
import type { DelegateThresholdPreview } from "@/lib/operations/delegate-threshold-preview";
import type { DelegateRejectSamples } from "@/lib/operations/delegate-threshold-samples";
import { formatDetailTime } from "@/lib/format/time";
import { INBOX_SECTIONS } from "../../inbox/inbox-model";
import { BatchGate } from "./BatchGate";
import { UndoBatch } from "./UndoBatch";

const n = (value: number) => value.toLocaleString("ko-KR");
const NONE = "셀 수 없음";
const KST = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const kst = (value: string | Date | null) => {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  const parts = Object.fromEntries(KST.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

/**
 * 사람 확인 · 묶음(최종 시안 「화면 3 사람 확인」) — 머리줄, 왼쪽 「보류 묶음」·「사람에게 남은 까닭」, 오른쪽 한 번에 끝낼 수 있는 묶음(표본 관문)과
 * 「요청과 감사」 한 줄, 아래 「문턱 보기」와 「일괄 결정 기록」. 목록·상세는 기존 화면(하나씩 보기)에 그대로 있다.
 * 이 화면이 직접 바꾸는 것은 표본 관문을 거친 일괄 결정과 묶음째 되돌리기뿐이다 — 모두 운영자가 누를 때만.
 */
export function HumanBatches({ data, threshold }: { data: HumanBatchesRead; threshold: ReactNode }) {
  const assistDay = data.assist?.tasks["human-review"].day ?? null;
  const strip = humanBatchStrip({ overview: data.overview, assistDay });
  // 2차 갈림을 AI 가 다시 본 수 — 판가름이 결론을 낸 것(넘김·남김, 대상 아님·실패 제외)과, 그중 재확인이 거절한 것(human-assist-progress.ts)
  const tiebreak = data.assist?.tasks["split-tiebreak"].day;
  const split = data.assist && tiebreak ? { seen: tiebreak.approve + tiebreak.reject + tiebreak.forward + tiebreak.held,
    rejected: data.assist.tasks["split-confirm"].day.reject } : null;
  const holds = data.holds ? humanHoldRows(data.holds, split) : null;
  const heldTotal = data.holds ? data.holds.reduce((total, row) => total + row.count, 0) : null;
  const why = data.delegate ? humanWhyRows(data.delegate.counts, data.assist?.tasks["human-review"].waiting ?? null) : null;
  const panels = data.panels.filter(panel => panel.key !== "agreed_reject" || (panel.members?.length ?? 0) > 0 || (panel.gate && !panel.gate.executedAt));
  return <div className="human-batches">
    <p className="hb-strip" aria-label="사람 확인 지금 상태">{strip.map(item => <span key={item.key}>{item.label}<b>{item.value === null ? NONE : n(item.value)}</b></span>)}</p>
    <div className="hb-grid">
      <section aria-labelledby="hb-holds-title">
        <div className="hb-head"><h2 id="hb-holds-title">보류 묶음</h2><span className="hb-count">사유별 · 합계 {heldTotal === null ? NONE : `${n(heldTotal)}건`}</span>
          <Link prefetch={false} className="text-button hb-more" href={ONE_BY_ONE_HREF}>하나씩 보기 →</Link></div>
        <div className="hb-scroll" role="region" aria-label="보류 묶음 표" tabIndex={0}>
          <table className="hb-table" style={{ minWidth: 560 }}>
            <colgroup><col /><col style={{ width: 84 }} /><col style={{ width: 96 }} /><col style={{ width: 196 }} /></colgroup>
            <thead><tr><th scope="col">묶음</th><th scope="col" className="n">건수</th><th scope="col" className="n">24시간</th><th scope="col">조치</th></tr></thead>
            <tbody>{holds === null ? <tr><td colSpan={4} className="hb-none">보류 수를 셀 수 없음 — 다음 갱신에서 다시 읽습니다.</td></tr>
              : holds.length === 0 ? <tr><td colSpan={4} className="hb-none">보류 없음</td></tr>
              : holds.map(row => <tr key={row.reason}>
                <th scope="row">{row.label}</th>
                <td className="n">{n(row.count)}</td>
                <td className="n">{row.recent24h ? `+${n(row.recent24h)}` : "—"}</td>
                <td>{row.action.kind === "batch" ? <a className="button small" href={`#${humanBatchAnchor(row.action.key)}`}>{row.action.label}</a>
                  : row.action.kind === "auto" ? <span className="hb-auto"><span className="hb-st" data-tone="ok"><i aria-hidden="true" />{row.action.label}</span>
                    {row.action.detail && <small>{row.action.detail}</small>}<a className="text-button" href={row.action.href}>문턱 보기</a></span>
                  : <span className="hb-auto"><Link prefetch={false} className="button small" href={row.action.href}>{row.action.label}</Link>
                    {row.action.note && <small>{row.action.note}</small>}</span>}</td>
              </tr>)}</tbody>
          </table>
        </div>
        <div className="hb-head"><h2 id="hb-why-title">사람에게 남은 까닭</h2>
          <span className="hb-count">사람 몫 {data.overview ? `${n(data.overview.stages.human + data.overview.stages.agreed)}건` : NONE}</span></div>
        <div className="hb-scroll" role="region" aria-labelledby="hb-why-title" tabIndex={0}>
          <table className="hb-table" style={{ minWidth: 560 }}>
            <colgroup><col /><col style={{ width: 84 }} /><col style={{ width: 236 }} /></colgroup>
            <thead><tr><th scope="col">까닭</th><th scope="col" className="n">건수</th><th scope="col">다음</th></tr></thead>
            <tbody>{why === null ? <tr><td colSpan={3} className="hb-none">AI 위임 결과를 셀 수 없음</td></tr>
              : why.length === 0 ? <tr><td colSpan={3} className="hb-none">사람에게 남은 것 없음</td></tr>
              : why.map(row => <tr key={row.group}><th scope="row">{row.label}</th><td className="n">{n(row.count)}</td>
                <td>{row.next.href ? (row.next.href.startsWith("#") ? <a className="text-button" href={row.next.href}>{row.next.label}</a>
                  : <Link prefetch={false} className="text-button" href={row.next.href}>{row.next.label}</Link>) : <span className="hb-quiet">{row.next.label}</span>}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <section aria-label="한 번에 끝낼 수 있는 묶음">
        {panels.map(panel => <BatchPanel key={panel.key} panel={panel} />)}
        <RequestsLine data={data} />
      </section>
    </div>
    {threshold}
    <RunLog runs={data.runs} />
  </div>;
}


function BatchPanel({ panel }: { panel: HumanBatchPanel }) {
  const guide = HUMAN_BATCH_GUIDE[panel.key];
  const gate = panel.gate;
  const active = gate && !gate.executedAt ? gate : null;
  const view = active ? humanBatchGateView(active, panel.members) : null;
  const repos = new Map(active?.members.map(member => [member.id, member.repo]) ?? []);
  const count = panel.members?.length ?? null;
  return <div className="hb-panel" id={humanBatchAnchor(panel.key)}>
    <div className="hb-head"><h2>{guide.title}</h2>
      <span className="hb-count">{count === null ? NONE : `${n(count)}건${count ? ` · ${panel.key === "repo_deleted" ? "확인 뒤 한 번에 거절" : "바로 끝낼 수 있음"}` : ""}`}</span></div>
    {panel.preview.length > 0 && <div className="hb-scroll" role="region" aria-label={`${guide.title} 후보`} tabIndex={0}>
      <table className="hb-table" style={{ minWidth: 420 }}>
        <colgroup><col /><col style={{ width: 132 }} /></colgroup>
        <thead><tr><th scope="col">후보{count !== null && count > panel.preview.length ? ` · 오래된 ${panel.preview.length}건` : ""}</th><th scope="col" className="n">기다린 때부터</th></tr></thead>
        <tbody>{panel.preview.map(row => <tr key={row.id}><td className="hb-mono"><Link prefetch={false} href={candidateHref(row.id)}>{row.repo}</Link></td>
          <td className="n">{kst(row.since)}</td></tr>)}</tbody>
      </table>
    </div>}
    {count === 0 && !active ? <p className="hb-none hb-box">지금 이 묶음에 후보가 없습니다.</p>
      : <BatchGate batchKey={panel.key} memberCount={count} view={view} cards={panel.cards}
        gate={gate ? { id: gate.id, sampleIds: gate.sampleIds, verdicts: gate.verdicts, executed: gate.executedAt !== null, result: gate.result } : null}
        targetRepos={view ? view.targets.map(id => repos.get(id) ?? `후보 ${id}`) : []}
        reasons={REVIEW_REJECT_REASONS} />}
  </div>;
}

/** 요청과 감사 — 기존 「오늘 할 일」 칸과 같은 수. 요청이 모두 0건이면 한 줄로 접는다 */
function RequestsLine({ data }: { data: HumanBatchesRead }) {
  const results = data.inbox?.results;
  const of = (key: "takedown" | "introRequest" | "feedback" | "makerReply" | "contact") => results?.[key]?.ok ? results[key].data.count : null;
  const requests = [
    { key: "takedown", label: "내림 요청", value: of("takedown"), href: INBOX_SECTIONS.takedown.href },
    { key: "introRequest", label: "소개 수정 요청", value: of("introRequest"), href: INBOX_SECTIONS.introRequest.href },
    { key: "feedback", label: "피드백", value: of("feedback"), href: INBOX_SECTIONS.feedback.href },
    { key: "makerReply", label: "메이커 답글", value: of("makerReply"), href: INBOX_SECTIONS.makerReply.href },
    { key: "contact", label: "문의", value: of("contact"), href: INBOX_SECTIONS.contact.href },
  ];
  const audit = data.audit;
  const auditItem = <span><Link prefetch={false} href={INBOX_SECTIONS.audit.href}>감사 거절</Link>
    <b>{audit ? `${n(audit.open)} · 7일 넘음 ${n(audit.overdue)}` : NONE}</b></span>;
  const allZero = requests.every(item => item.value === 0);
  return <div className="hb-panel">
    <div className="hb-head"><h2>요청과 감사</h2></div>
    {allZero ? <p className="hb-inline"><span>요청<b>0건</b><small>내림·소개 수정·피드백·메이커 답글·문의</small></span>{auditItem}</p>
      : <p className="hb-inline">{requests.map(item => <span key={item.key}><Link prefetch={false} href={item.href}>{item.label}</Link>
        <b>{item.value === null ? NONE : n(item.value)}</b></span>)}{auditItem}</p>}
    <p className="hb-note">요청이 0건이면 줄 하나로 접습니다. 내림 요청은 24시간이 넘으면 홈의 「멈춤」으로 올라갑니다.</p>
  </div>;
}

/** 일괄 결정 기록 — 실행한 묶음(모든 운영자, 최근 10개)과 묶음째 되돌리기. 작업 로그의 「묶음 일괄 결정」 줄이 여기로 잇는다 */
function RunLog({ runs }: { runs: HumanBatchesRead["runs"] }) {
  return <section className="hb-log" id={HUMAN_BATCH_LOG_ANCHOR} aria-labelledby="hb-log-title">
    <div className="hb-head"><h2 id="hb-log-title">일괄 결정 기록</h2><span className="hb-count">묶음째 되돌릴 수 있습니다</span>
      <Link prefetch={false} className="text-button hb-more" href="/admin/activity?group=review">작업 로그 →</Link></div>
    {runs === null ? <p className="hb-none hb-box">기록을 읽지 못했습니다.</p>
      : runs.length === 0 ? <p className="hb-none hb-box">아직 일괄 결정이 없습니다.</p>
      : <div className="hb-scroll" role="region" aria-labelledby="hb-log-title" tabIndex={0}>
        <table className="hb-table" style={{ minWidth: 900 }}>
          <colgroup><col style={{ width: 64 }} /><col style={{ width: 112 }} /><col /><col style={{ width: 216 }} /><col style={{ width: 96 }} /><col style={{ width: 168 }} /></colgroup>
          <thead><tr><th scope="col" className="n">묶음</th><th scope="col">시각</th><th scope="col">무엇</th><th scope="col">결과</th><th scope="col">처리자</th><th scope="col">되돌리기</th></tr></thead>
          <tbody>{runs.map(run => {
            const guide = HUMAN_BATCH_GUIDE[run.batchKey as HumanBatchKey];
            const decided = run.result?.decided.length ?? 0;
            return <tr key={run.id}>
              <td className="n">#{run.id}</td>
              <td className="hb-time" title={run.executedAt ? formatDetailTime(run.executedAt.toISOString()) : undefined}>{kst(run.executedAt)}</td>
              <th scope="row">{guide?.title ?? run.batchKey}</th>
              <td>{run.result ? humanBatchResultLine(run.result) : "결과 없음(처리 중이었거나 멈춤)"}</td>
              <td className="hb-mono">{run.actor}</td>
              <td>{run.undoneAt ? <span className="hb-quiet" title={run.undoResult ? `되돌림 ${run.undoResult.restored} · 못함 ${run.undoResult.failures.length}` : undefined}>
                  되돌림 · {kst(run.undoneAt)}{run.undoResult?.failures.length ? ` · 못함 ${n(run.undoResult.failures.length)}` : ""}</span>
                : decided > 0 ? <UndoBatch gateId={run.id} title={`#${run.id} ${guide?.title ?? ""}`} count={decided} />
                : <span className="hb-quiet">되돌릴 결정 없음</span>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
  </section>;
}

/**
 * 문턱 보기(시안 「흐름 5」 4번) — AI 위임 확신 문턱을 내리면 24시간 동안 승인·거절·사람 몫이 어떻게 달라졌을지(readDelegateThresholdPreview)와,
 * 문턱을 고르면 그 구간의 거절 표본. 문턱 값은 코드 값(deepseek-review-policy.ts)이라 이 화면에서 저장하지 않는다.
 */
export async function HumanThreshold({ load, rejectsAt }: {
  load: Promise<{ preview: DelegateThresholdPreview | null; samples: DelegateRejectSamples | null }>; rejectsAt: number | null;
}) {
  const { preview, samples } = await load;
  const current = preview?.currentThreshold ?? DEEPSEEK_MIN_CONFIDENCE;
  return <section className="hb-threshold" id={HUMAN_BATCH_THRESHOLD_ANCHOR} aria-labelledby="hb-threshold-title">
    <div className="hb-head"><h2 id="hb-threshold-title">문턱 보기 · AI에 더 맡길 때</h2>
      <span className="hb-count">{preview ? `${kst(preview.measuredAt)} 기준 24시간 ${n(preview.total)}건` : NONE}</span></div>
    <p className="hb-note">확신 문턱을 내리면 AI가 대신 끝내는 건수가 얼마나 달라지는지입니다. 내리기 전에 그 구간의 거절 표본을 먼저 봅니다.
      문턱 값은 코드 값(지금 {current})이라 이 화면에서 바꾸지 않습니다.</p>
    {preview === null ? <p className="hb-none hb-box">미리보기를 읽지 못했습니다 — 다음 갱신에서 다시 읽습니다.</p>
      : <div className="hb-scroll" role="region" aria-labelledby="hb-threshold-title" tabIndex={0}>
        <table className="hb-table" style={{ minWidth: 640 }}>
          <colgroup><col style={{ width: 120 }} /><col /><col /><col /><col style={{ width: 168 }} /></colgroup>
          <thead><tr><th scope="col">문턱</th><th scope="col" className="n">AI가 승인</th><th scope="col" className="n">AI가 거절</th><th scope="col" className="n">사람에게 남음</th><th scope="col">거절 표본</th></tr></thead>
          <tbody>{preview.thresholds.map(line => <tr key={line.threshold} data-current={line.threshold === current || undefined}>
            <th scope="row">{line.threshold.toFixed(2)}{line.threshold === current ? " · 지금" : ""}</th>
            <td className="n" title={line.approveRepoCheck ? `24~72시간 근거 ${line.approveRepoCheck}건은 저장소 확인을 거칩니다` : undefined}>{n(line.approve)}</td>
            <td className="n">{n(line.reject)}</td>
            <td className="n">{n(line.held)}</td>
            <td>{line.threshold < current ? <Link prefetch={false} className="text-button" aria-current={rejectsAt === line.threshold ? "true" : undefined}
              href={`${HUMAN_BATCHES_HREF}?rejects=${line.threshold}#${HUMAN_BATCH_THRESHOLD_ANCHOR}`}>{line.threshold.toFixed(2)}~{current} 거절 보기</Link> : <span className="hb-quiet">—</span>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    {rejectsAt !== null && <RejectSamples samples={samples} rejectsAt={rejectsAt} current={current} />}
  </section>;
}

function RejectSamples({ samples, rejectsAt, current }: { samples: DelegateRejectSamples | null; rejectsAt: number; current: number }) {
  return <div className="hb-panel">
    <div className="hb-head"><h3>확신 {rejectsAt.toFixed(2)}~{current} 거절 표본</h3>
      <span className="hb-count">{samples ? `24시간 ${n(samples.total)}건 중 무작위 ${n(samples.samples.length)}건` : NONE}</span>
      <Link prefetch={false} className="text-button hb-more" href={`${HUMAN_BATCHES_HREF}#${HUMAN_BATCH_THRESHOLD_ANCHOR}`}>닫기</Link></div>
    {samples === null ? <p className="hb-none hb-box">표본을 읽지 못했습니다.</p>
      : samples.samples.length === 0 ? <p className="hb-none hb-box">이 구간의 거절 의견이 없습니다.</p>
      : <div className="hb-scroll" role="region" aria-label="거절 표본" tabIndex={0}>
        <table className="hb-table" style={{ minWidth: 560 }}>
          <colgroup><col style={{ width: "34%" }} /><col style={{ width: 72 }} /><col /><col style={{ width: 96 }} /></colgroup>
          <thead><tr><th scope="col">후보</th><th scope="col" className="n">확신</th><th scope="col">AI 사유</th><th scope="col">지금</th></tr></thead>
          <tbody>{samples.samples.map(row => <tr key={row.candidateId}>
            <td className="hb-mono"><Link prefetch={false} href={candidateHref(row.candidateId)}>{row.repo}</Link></td>
            <td className="n">{row.confidence.toFixed(2)}</td>
            <td className="hb-reason-cell">{row.reason ?? "—"}</td>
            <td>{row.state === "needs_review" ? "사람 확인" : row.state === "rejected" ? "거절됨" : row.state === "published" ? "공개됨" : row.state}</td>
          </tr>)}</tbody>
        </table>
      </div>}
  </div>;
}
