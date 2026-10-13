"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/home/icons";
import { AI_LEVELS, type AiLevel } from "@/lib/domain/evidence/ai-level-labels";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber, formatDateTime } from "@/lib/i18n/format";
import { stripLocale } from "@/lib/i18n/routing";
import { translatedCategory } from "./i18n";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import type { HomePulseView } from "@/components/home/types";
import type { StarGrowthSnapshot } from "@/lib/domain/products/star-growth";
import { StarGrowthSummary, starGrowthNote } from "@/components/home/StarGrowthSummary";

/**
 * 계산식·세부 조건은 '자세히' 안에 접는다(UX-37) — 본문은 지표마다 쉬운 문장 하나로 읽힌다.
 * 식을 궁금해하는 사람만 펼친다.
 */
function Details({ children }: { children: React.ReactNode }) {
  const t = useTranslations("browse");
  return (
    <details className="method-more">
      <summary>{t("method.details")}</summary>
      {children}
    </details>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return <code className="formula">{children}</code>;
}

/** 대화창이 열리는 화면 — 홈과 분야 화면(/c/…)이 같은 목록을 쓴다 */
const isBrowsePath = (pathname: string) => stripLocale(pathname) === "/" || stripLocale(pathname).startsWith("/c/");

export function MethodologyDialog({ pulse, aiLevels = null, starGrowth }: {
  pulse: HomePulseView;
  /** AI 제작 근거 단계마다의 전체 공개 수(탐색 칩은 현재 정렬 자격 안에서 별도 집계) — 못 읽었으면 null(수 없이 기준만) */
  aiLevels?: Record<AiLevel, number> | null;
  starGrowth?: StarGrowthSnapshot | null;
}) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const labels = useTranslations("labels");
  const count = (n: number) => formatNumber(n, locale);
  const dialog = useRef<HTMLDialogElement>(null);
  const skipClose = useRef(false);
  const params = useSearchParams();
  const pathname = usePathname();
  const rawMetric = params.get("metric") ?? "";
  const metric = rawMetric === "rising" ? "star-growth" : rawMetric;
  const open = isBrowsePath(pathname) && ["all", "born", "updates", "active", "categories", "ai", "tools", "popular", "rising", "star-growth"].includes(metric);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!open) {
      if (node.open) node.close();
      return;
    }
    try {
      if (!node.open) node.showModal();
    } catch {
      skipClose.current = true;
      node.close();
      node.showModal();
    }
  }, [open]);

  function hrefWithMetric(metricKey: string | null) {
    const next = new URLSearchParams(params.toString());
    if (metricKey) next.set("metric", metricKey);
    else next.delete("metric");
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  /*
   * 대화창은 주소의 metric 을 브라우저에서만 읽는다(서버 렌더는 쓰지 않는다). router.replace 는 홈 전체를 서버가 다시
   * 그리게 해 탭을 누를 때마다 쿼리 26개가 돌았다(2026-10-06) — 주소만 바꾼다. useSearchParams 가 따라 바뀐다.
   */
  function close() {
    window.history.replaceState(null, "", hrefWithMetric(null));
  }

  const metrics: [string, string][] = [["popular", t("popular.tiers")], ["born", t("intro.new")], ["updates", t("intro.updates")], ["active", t("active.title")], ["categories", t("filter.category")], ["ai", t("filter.ai")]];
  if (pulse.tools) metrics.push(["tools", t("tools.title")]);
  metrics.push(["star-growth", t("growth.title")]);
  const nav = (
    <div className="metric-links">
      {metrics.map(([key, label]) => (
        <button
          type="button"
          key={key}
          onClick={() => window.history.replaceState(null, "", hrefWithMetric(key))}
        >
          {label}
        </button>
      ))}
    </div>
  );

  // 기본 목록에서 빼는 분야(개인 프로필, 계약 C3)는 분야 순위에도 싣지 않는다
  const categories = pulse.categories.filter((item) => !hiddenByDefault(item.key));

  const projects = (n: number) => t("count.projects", { count: count(n) });
  const title = (level: AiLevel) => t(({ 1: "method.aiLevel1", 2: "method.aiLevel2", 3: "method.aiLevel3" } as const)[level]);
  const description = (level: AiLevel) => t(({ 1: "method.aiDescription1", 2: "method.aiDescription2", 3: "method.aiDescription3" } as const)[level]);
  const time = (value: string | null | undefined) => formatDateTime(value, pulse.asOf, locale);
  const observation = (first: string | null | undefined, last: string | null | undefined) => first ? `${time(first)} ~ ${time(last)}` : t("method.noObservation");
  const blocks: Record<string, React.ReactNode> = {
    "star-growth": <>
      <h3>{t("method.growthTitle")}</h3>
      <p>{starGrowthNote(starGrowth ?? null, locale, t)}.</p>
      {starGrowth !== undefined && <StarGrowthSummary snapshot={starGrowth} now={pulse.asOf} />}
      <Details>
        <p>{t("method.growthEligibility", { window: count(starGrowth?.policy?.collectionWindowHours ?? 1), min: count(starGrowth?.policy?.minIntervalHours ?? 7), max: count(starGrowth?.policy?.maxIntervalHours ?? 9) })}</p>
        <Formula>{t("method.growthFormula")}</Formula>
        <p>{t("method.growthOrder")}</p>
        {starGrowth && <table className="method-table">
          <thead><tr><th>{t("method.observation")}</th><th>{t("method.cycleTime")}</th><th>{t("method.actualTime")}</th></tr></thead>
          <tbody>
            <tr><td>{t("method.thisCycle")}</td><td>{time(starGrowth.asOf)}</td><td>{observation(starGrowth.firstObservedAt, starGrowth.lastObservedAt)}</td></tr>
            <tr><td>{t("method.baselineCycle")}</td><td>{time(starGrowth.baselineAsOf)}</td><td>{observation(starGrowth.baseline?.firstObservedAt, starGrowth.baseline?.lastObservedAt)}</td></tr>
          </tbody>
        </table>}
        <p>{t("method.growthFreshness", { hours: count(starGrowth?.policy?.maxAgeHours ?? 10) })}</p>
        <p>{t("method.growthMeaning")}</p>
      </Details>
    </>,
    popular: <>
      <h3>{t("method.popularTitle")}</h3><p>{t("method.popularSummary")}</p>
      <Details><p>{t("method.popularRange")}</p><p>{t("method.popularCaveat")}</p><p>{t("method.popularFreshness")}</p></Details>
    </>,
    born: <>
      <h3>{t("method.bornTitle")}</h3><p>{t("method.bornSummary")}</p>
      <table className="method-table"><tbody>
        <tr><td>{t("method.lastWeek")}</td><td>{projects(pulse.born.current)}</td></tr>
        <tr><td>{t("method.previousWeek")}</td><td>{projects(pulse.born.previous)}</td></tr>
        <tr><td>{t("method.change")}</td><td>{pulse.born.change === null ? t("method.smallSample") : `${count(pulse.born.change)}%`}</td></tr>
      </tbody></table>
      <Details><p>{t("method.bornEligibility")}</p><Formula>{t("method.bornFormula")}<br />{t("method.changeFormula")}</Formula><p>{t("method.bornDelay")}</p><p>{t("method.bornList")}</p></Details>
    </>,
    updates: <>
      <h3>{t("method.updatesTitle")}</h3><p>{t("method.updatesSummary")}</p>
      <Details><p>{t("method.updatesCount", { releases: count(pulse.updates.releases), projects: count(pulse.updates.projects) })}</p><Formula>{t("method.updatesFormula")}<br />{t("method.releasesFormula")}</Formula><p>{t("method.updatesCaveat")}</p></Details>
    </>,
    active: <>
      <h3>{t("method.activeTitle")}</h3><p>{t("method.activeSummary")}</p>
      <Details><p>{t("method.activeOrder")}</p><Formula>{t("method.activeFormula", { count: count(pulse.active.length) })}</Formula><p>{t("method.activeCaveat")}</p></Details>
    </>,
    categories: <>
      <h3>{t("method.categoriesTitle")}</h3><p>{t("method.categoriesSummary")}</p>
      <table className="method-table"><thead><tr><th>{t("filter.category")}</th><th>{t("intro.public")}</th><th>{t("method.bornColumn")}</th></tr></thead>
        <tbody>{categories.map(item => <tr key={item.key}><td>{translatedCategory(item.key, labels)}</td><td>{projects(item.total)}</td><td>{projects(item.born)}</td></tr>)}</tbody>
      </table><Details><p>{t("method.categoriesCaveat")}</p></Details>
    </>,
    ai: <>
      <h3>{t("method.aiTitle")}</h3><p>{t("method.aiSummary")}</p>
      <table className="method-table"><thead><tr><th>{t("method.evidence")}</th>{aiLevels && <th>{t("method.projectCount")}</th>}</tr></thead>
        <tbody>{AI_LEVELS.map(level => <tr key={level}><td>{title(level)}</td>{aiLevels && <td>{projects(aiLevels[level])}</td>}</tr>)}</tbody>
      </table><p>{t("method.aiAbsence")}</p>
      <Details>{AI_LEVELS.map(level => <p key={level}><b>{title(level)}</b> — {description(level)}</p>)}<p>{t("method.aiCaveat")}</p><p>{t("method.aiRefresh")}</p></Details>
    </>,
    ...(pulse.tools ? { tools: <>
      <h3>{t("method.toolsTitle")}</h3><p>{t("method.toolsSummary")}</p>
      <table className="method-table"><thead><tr><th>{t("method.tool")}</th><th>{t("method.projectCount")}</th></tr></thead>
        <tbody>{pulse.tools.rows.map(row => <tr key={row.label}><td>{row.label}</td><td>{projects(row.count)}</td></tr>)}<tr><td>{t("method.coverage")}</td><td>{t("method.toolsCoverage", { scanned: count(pulse.tools.scanned), found: count(pulse.tools.withTool) })}</td></tr></tbody>
      </table><Details><p>{t("method.toolsEvidence")}</p><Formula>{t("method.toolsFormula")}</Formula><p>{t("method.toolsCaveat")}</p></Details>
    </> } : {}),
  };

  const body = metric === "all" || !blocks[metric]
    ? (
      <>
        <h3>{t("method.overviewTitle")}</h3>
        <p>{t("method.overview")}</p>
        {nav}
        {Object.values(blocks).map((block, index) => (
          <div key={index}>
            {index > 0 && <hr className="method-rule" />}
            {block}
          </div>
        ))}
      </>
    )
    : <>{nav}{blocks[metric]}</>;

  return (
    <dialog
      ref={dialog}
      id="dialog"
      aria-labelledby="dialog-title"
      data-metric={metric || undefined}
      onClose={() => {
        if (skipClose.current) {
          skipClose.current = false;
          return;
        }
        close();
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <div className="modal-head">
        <h2 id="dialog-title">{t("method.title")}</h2>
        <Link prefetch={false} href={hrefWithMetric(null)} className="close-btn" aria-label={t("method.close")} scroll={false}>
          <Icon name="close" />
        </Link>
      </div>
      <div className="modal-body">
        <div className="notice">
          {t("method.notice")}
        </div>
        {body}
        <p className="method-foot">{metric === "star-growth"
          ? starGrowth ? t("method.growthFoot", { time: time(starGrowth.asOf), version: starGrowth.policyVersion ?? t("method.policyUnknown") }) : t("method.growthFootUnknown")
          : t("method.foot", { time: time(pulse.asOf), version: pulse.methodVersion })}</p>
      </div>
    </dialog>
  );
}
