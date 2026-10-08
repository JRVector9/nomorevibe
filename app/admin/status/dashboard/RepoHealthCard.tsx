import Link from "next/link";
import type { AttentionCounts } from "@/lib/operations/dashboard";

/** 지난 24시간에 확인한 비율이 이보다 낮으면 조치할 일에 올린다 */
export const REPO_COVERAGE_TARGET = 0.95;
/** 저장소가 사라졌다고 확정된 뒤 2단계(AI 확인·운영자 결정)가 이만큼 끝나지 않으면 맨 앞 급으로 */
export const REPO_REVIEW_OVERDUE_HOURS = 48;

const n = (value: number) => value.toLocaleString("ko-KR");
const filter = (name: string) => `/admin/products?filter=${encodeURIComponent(name)}`;
const STATES = [
  { key: "ok", label: "있음" },
  { key: "not_found", label: "없음" },
  { key: "empty", label: "빈 저장소" },
  { key: "blocked", label: "막힘" },
  { key: "archived", label: "보관됨", href: filter("저장소 보관됨") },
  { key: "renamed", label: "이름 바뀜", href: filter("저장소 이름 바뀜") },
] as const;

/**
 * GitHub 저장소 확인의 품질 — 하루 확인이 다 돌고 있는지(확인 범위), 상태별 수와 지난 24시간에 바뀐 것,
 * 저장소가 사라진 웹사이트의 2단계 줄. 보관·이름 바뀜은 기록만 하는 값이다(공개 화면에 영향 없음).
 */
export function RepoHealthCard({ health, review }: { health: AttentionCounts["repoHealth"]; review: AttentionCounts["repoReview"] }) {
  const coverage = health.tracked > 0 ? health.checked24h / health.tracked : null;
  const overdue = review.oldestHours !== null && review.oldestHours > REPO_REVIEW_OVERDUE_HOURS;
  return (
    <section className="dash-card dash-12" aria-label="GitHub 저장소 확인">
      <div className="dash-card-h">
        <h2>GitHub 저장소 확인 · {coverage === null ? "—" : `${Math.floor(coverage * 1000) / 10}%`}</h2>
        <small>지난 24시간에 확인 {n(health.checked24h)} / 공개 저장소 {n(health.tracked)} · 목표 {REPO_COVERAGE_TARGET * 100}% 이상</small>
      </div>
      <div className="dash-chips">
        {STATES.map((state) => {
          const value = health.states[state.key];
          const body = <>{state.label} <b>{n(value.total)}</b>{value.new24h > 0 && <span>· 24시간 새로 {n(value.new24h)}</span>}</>;
          return "href" in state
            ? <Link key={state.key} className="dash-pill" href={state.href}>{body}</Link>
            : <span key={state.key} className="dash-pill">{body}</span>;
        })}
      </div>
      <p className="dash-line">
        <span>
          저장소가 사라진 웹사이트 2단계 — 확인 대기 <b>{n(review.pending)}</b> · 내릴 후보 <b>{n(review.delistCandidates)}</b> ·
          사람 확인 <b>{n(review.human)}</b> · AI 유지 <b>{n(review.kept)}</b>
          {review.oldestHours !== null && <> · 가장 오래 기다린 것 <b className={overdue ? "text-down" : ""}>{Math.round(review.oldestHours)}시간</b></>}
          {" "}<Link href={filter("저장소 사라짐")} className="text-accent">제품 관리</Link>
        </span>
      </p>
    </section>
  );
}
