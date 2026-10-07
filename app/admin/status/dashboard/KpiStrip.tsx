import type { HourlySeries } from "@/lib/operations/dashboard";
import { Sparkline } from "./Sparkline";

const n = (value: number) => value.toLocaleString("ko-KR");
const pct = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

/**
 * 지금 처리량 — 최근 1시간 수와 24시간 모양.
 *
 * 숫자 하나보다 "평소보다 많은가"가 먼저 보여야 한다. 그래서 칸마다 24시간 선을 깐다.
 * 타일 여섯은 격자 2칸씩이라 아래 행의 8칸·4칸 카드와 세로 선이 맞는다.
 */
export function KpiStrip({ series, textPending, verifyPending }: {
  /** 검색 점검 결과가 없거나 오래되면 null — 0 으로 그리면 밀린 것이 없는 줄 안다 */
  series: HourlySeries | null; textPending: number | null; verifyPending: number | null;
}) {
  if (!series || series.points.length === 0) {
    return <section className="dash-card dash-12" aria-label="지금 처리량"><p className="text-[13px] text-fg-3">처리량을 불러오지 못했습니다. 다음 갱신에서 다시 확인합니다.</p></section>;
  }
  const points = series.points;
  const last = points[points.length - 1];
  // 큰 숫자는 이번 시(정시부터 지금까지)다 — 15분 지난 칸을 "24h 평균 …/h" 옆에 두면 처리량이 1/4로 준 줄 안다
  const elapsed = Math.max(1, Math.round((new Date(series.measuredAt).getTime() - new Date(last.hour).getTime()) / 60_000));
  const partial = elapsed < 60 ? `이번 시 ${elapsed}분 · ` : "";
  const avg = (pick: (p: typeof last) => number) => Math.round(points.reduce((sum, p) => sum + pick(p), 0) / points.length);
  // firstReviews(끝난 심사)와 firstFailed(실패한 호출)는 겹치지 않는다 — 실패율 분모는 둘의 합(프로드 첫 화면에 "실패 567%"가 떴다)
  const firstTotal = last.firstReviews + last.firstFailed;
  const firstFailPct = firstTotal > 0 ? last.firstFailed / firstTotal : 0;
  const agree = last.secondReviews > 0 ? last.secondAgreed / last.secondReviews : null;
  const tiles = [
    { key: "discovered", label: "발견 (frontier)", value: last.discovered, small: undefined, sub: `${partial}24h 평균 ${n(avg(p => p.discovered))}/h`, tone: undefined,
      values: points.map(p => p.discovered), color: "accent" as const },
    { key: "judged", label: "수집·판정", value: last.judged, small: undefined, sub: `${partial}24h 평균 ${n(avg(p => p.judged))}/h`, tone: undefined,
      values: points.map(p => p.judged), color: "accent" as const },
    { key: "first", label: "1차 AI 심사", value: last.firstReviews, small: `실패 ${pct(last.firstFailed, firstTotal)}`,
      sub: `${partial}24h 평균 ${n(avg(p => p.firstReviews))}/h`, tone: firstFailPct >= 0.1 ? "bad" : firstFailPct >= 0.05 ? "warn" : undefined,
      values: points.map(p => p.firstReviews), color: "accent" as const },
    { key: "second", label: "2차 AI 심사", value: last.secondReviews, small: agree === null ? undefined : `1차와 일치 ${Math.round(agree * 100)}%`,
      sub: agree !== null && agree < 0.7 ? `갈림 → 사람 확인 ${n(last.secondReviews - last.secondAgreed)}건/h` : `${partial}24h 평균 ${n(avg(p => p.secondReviews))}/h`,
      tone: agree !== null && agree < 0.7 ? "warn" : undefined, values: points.map(p => p.secondReviews), color: agree !== null && agree < 0.7 ? "warn" as const : "accent" as const },
    { key: "published", label: "발행", value: last.published, small: `24h ${n(points.reduce((s, p) => s + p.published, 0))}`,
      sub: `${partial}한국어 소개 ${n(points.reduce((s, p) => s + p.publishedKorean, 0))} (${pct(points.reduce((s, p) => s + p.publishedKorean, 0), points.reduce((s, p) => s + p.published, 0))})`,
      tone: undefined, values: points.map(p => p.published), color: "up" as const },
    { key: "text", label: "텍스트 (키워드)", value: last.keywords, small: `대기 ${textPending === null ? "—" : n(textPending)}`,
      sub: `${partial}검수 대기 ${verifyPending === null ? "— (점검 결과 없음)" : n(verifyPending)}`,
      tone: textPending === null ? "warn" : textPending > 5_000 ? "warn" : undefined, values: points.map(p => p.keywords), color: "accent" as const },
  ];
  return (
    <>
      {tiles.map((tile) => (
        <article key={tile.key} className="dash-card dash-2 dash-kpi" aria-label={tile.label}>
          <span className="label">{tile.label}</span>
          <span className="value">{n(tile.value)}{tile.small && <small>{tile.small}</small>}</span>
          <span className="sub" data-tone={tile.tone}>{tile.sub}</span>
          <Sparkline values={tile.values} tone={tile.color} />
        </article>
      ))}
    </>
  );
}
