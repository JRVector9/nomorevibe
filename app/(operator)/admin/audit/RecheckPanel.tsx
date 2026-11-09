import Link from "next/link";
import type { RecheckOverview, RecheckReviewerPlan } from "@/lib/crawl/published-recheck";
import { formatListTime } from "@/lib/format/time";

const count = (value: number) => value.toLocaleString("ko-KR");

export type RecheckReviewerRow = RecheckReviewerPlan["reviewers"][number] & { route: { ready: boolean; text: string } };

/**
 * 공개분 변경 재검수(lib/crawl/published-recheck.ts) — 늘 열린 줄의 상태·한도·지금 묻는 1차 순위. 내리기·유지는 아래 목록(감사 거절과 같은 줄)에서 한다.
 * 한도는 실시간 한도 화면(잡별 묶음의 published-recheck 줄)에서 고친다.
 */
export function RecheckPanel({ overview, plan, reviewers, now }: { overview: RecheckOverview; plan: RecheckReviewerPlan; reviewers: RecheckReviewerRow[]; now: Date }) {
  const { stream, limits, counts, baselines } = overview;
  const enrollOn = limits.dailyCap > 0, askOn = limits.askBatch > 0;
  const onOff = (on: boolean, label: string) => <span className={`rounded px-1.5 py-0.5 font-semibold ${on ? "bg-accent-soft text-accent" : "bg-bg-soft text-fg-2"}`}>{label} {on ? "켬" : "끔"}</span>;
  const stale = overview.oldestPendingHours !== null && overview.oldestPendingHours >= Math.max(24, limits.yieldHours);
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-bg-card p-4 text-[13px] text-fg-2" aria-labelledby="recheck-title">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="recheck-title" className="text-[14.5px] font-bold text-fg">공개분 변경 재검수</h2>
        {onOff(enrollOn, "올리기")}
        {onOff(askOn, "묻기")}
        <span className="text-fg-3">{stream ? `줄 #${stream.id} · ${formatListTime(stream.startedAt, now)}부터` : "아직 줄이 없습니다 — 잡이 처음 돌 때 만듭니다"}</span>
      </div>
      <p className="max-w-[90ch] leading-[1.7]">
        공개 제품의 받아 둔 원본(다시 받지 않습니다)을 모델이 마지막으로 본 내용과 견주어, 이름·소개·페이지 본문·README·토픽·주소·쓰는 방식·패키지 증거·제작자
        GitHub 링크가 <b className="font-semibold">뜻있게</b> 바뀐 것만 다시 묻습니다. 스타·푸시 시각은 보지 않고, 글은 낱말 유사도가
        {" "}<b className="font-semibold">{Math.round(limits.minSimilarity * 100)}%</b> 아래로 떨어졌거나 글이 생기고 사라졌을 때만 바뀐 것으로 봅니다.
        답은 감사와 같이 다룹니다 — 확신 높은 거절은 보류(공개 목록에서만 빠짐), 판단 보류는 아래 목록, 승인은 기준만 새로 둡니다. 아무것도 저절로 내리지 않습니다.
      </p>
      <p className="tabular-nums">
        지난 24시간 올림 <b className="font-semibold text-fg">{count(counts.enrolledDay)}</b> / 하루 상한 {count(limits.dailyCap)} ·
        답 {count(counts.answeredDay)}(승인 {count(counts.approvedDay)} · 거절 <span className="text-down">{count(counts.rejectedDay)}</span> · 판단 보류 {count(counts.needsReviewDay)}) ·
        물을 것 <b className="font-semibold text-fg">{count(counts.pending)}</b>
        {overview.oldestPendingHours !== null && ` (가장 오래 ${overview.oldestPendingHours.toFixed(1)}시간)`} · 답 못 받음 {count(counts.failed)}
      </p>
      <p className="tabular-nums">
        사람 몫: 거절 <b className="font-semibold text-down">{count(counts.openReject)}</b> · 판단 보류 <b className="font-semibold text-warn">{count(counts.openNeedsReview)}</b> ·
        그중 보류 중 {count(counts.held)} · 기준 — 1차 승인 {count(baselines.firstReview)} · 재검수 답 {count(baselines.recheck)} · 처음 본 내용 {count(baselines.seeded)}
      </p>
      {stale && <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 leading-[1.7]">
        물을 재검수 항목이 {overview.oldestPendingHours!.toFixed(1)}시간째 기다립니다. 아래 순위가 감사 경로에서 열리는지(계약), 1차 대기가 늘 차 있지 않은지 보세요.</p>}
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <p><b className="font-semibold text-fg">묻는 모델 — 1차 AI 검수 순위</b> <span className="text-fg-3">(작업 ↔ 모델의 first-review 를 1차와 같은 길로 읽습니다. 높은 순위부터, 그 틱에 열리지 않으면 다음 순위)</span></p>
        {plan.status !== "ok" && <p className="text-warn">{plan.status === "no_task_models" ? "1차 AI 검수 순위가 없습니다." : "작업 ↔ 모델 표를 아직 읽지 못했습니다."}</p>}
        <ul className="flex flex-col gap-0.5">
          {reviewers.map((row) => <li key={`${row.rank}:${row.provider}:${row.model}`}>
            {row.rank}순위 {row.connectionLabel} · <span className="font-mono">{row.model}</span> ({row.provider}) —{" "}
            <span className={row.route.ready ? "text-fg-2" : "text-warn"}>{row.route.text}</span></li>)}
          {plan.skipped.map((row) => <li key={`s:${row.rank}:${row.model}`} className="text-fg-3">{row.rank}순위 {row.label} · <span className="font-mono">{row.model}</span> — 부르지 않음: {row.reason}</li>)}
        </ul>
        <p className="text-fg-3">감사 경로(product-audit)의 장부 요청이라 background 등급입니다 — 장부 행은 1차가 아니라 감사로 셉니다. 1차 심사 대기에 후보가 있으면 물러나되,
          가장 오래 기다린 항목이 {count(limits.yieldHours)}시간을 넘으면 함께 묻습니다(0 이면 물러나지 않음).</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Link href="/admin/models/limits" className="admin-button">한도 고치기 →</Link>
        <span className="text-fg-3">틱마다 견줄 제품 {count(limits.scanBatch)} · 하루 올리기 상한 {count(limits.dailyCap)} · 감사 틱마다 묻기 {count(limits.askBatch)} ·
          같다고 볼 유사도 {Math.round(limits.minSimilarity * 100)}% · 1차 양보 상한 {count(limits.yieldHours)}시간 (잡별 묶음의 published-recheck 줄)</span>
      </div>
    </section>
  );
}
