import type { StarGrowthRunSummary, StarGrowthSnapshot } from "@/lib/domain/products/star-growth";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { formatNumber } from "@/lib/i18n/format";
import { formatCount } from "@/lib/format/number";

export const STAR_GROWTH_TITLE = "최근 8시간 스타 급상승";

/**
 * 브라우저 부품(집계 기준 창·급상승 요약)에 넘기는 회차 값 — 화면이 읽는 칸만(2026-11-14 공개 HTML 줄이기).
 * 실행 번호·실행 상태·닫힌 시각과 기준 회차의 실행 정보는 서버에 남는다. 회차 상태는 state 로 싣는다(제품 status 와 다른 칸).
 */
export type StarGrowthSnapshotView = Omit<StarGrowthSnapshot, "runId" | "runStatus" | "closedAt" | "baseline" | "status"> & {
  state: StarGrowthSnapshot["status"];
  baseline: Pick<StarGrowthRunSummary, "firstObservedAt" | "lastObservedAt"> | null;
};

export function starGrowthView(snapshot: StarGrowthSnapshot): StarGrowthSnapshotView;
export function starGrowthView(snapshot: StarGrowthSnapshot | null): StarGrowthSnapshotView | null;
export function starGrowthView(snapshot: StarGrowthSnapshot | null): StarGrowthSnapshotView | null {
  if (!snapshot) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 버리는 칸
  const { runId, runStatus, closedAt, baseline, status, ...rest } = snapshot;
  return { ...rest, state: status, baseline: baseline ? { firstObservedAt: baseline.firstObservedAt, lastObservedAt: baseline.lastObservedAt } : null };
}

export function starGrowthNote(snapshot: Pick<StarGrowthSnapshot, "policy"> | null, locale: Locale = "ko", t?: Translator<"browse">) {
  const min = snapshot?.policy?.minStars ?? 50;
  const max = (snapshot?.policy?.maxStarsExclusive ?? 2000) - 1;
  return t ? t("growth.note", { min: formatNumber(min, locale), max: formatNumber(max, locale) })
    : `스타 ${formatCount(min)}~${formatCount(max)}개 · 직전 8시간 회차 대비 증가량순 · 8시간마다 갱신`;
}
