"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { LazyRankedPanelSlot as LazyRankedPanel, useNearViewport } from "@/components/cards/lazy-slots";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import { trackAttrs } from "@/lib/analytics/attrs";
import type { TierCountsResponse } from "@/app/api/browse-counts/route";
import { useCountsQuery } from "./browse-counts";


/**
 * 구간 탭 하나 — 이름·범위·수·주소만. 카드는 서버 HTML 에 없고 같은 출처 API 로 받는다:
 * 처음 보이는 구간은 구획이 화면 가까이 올 때, 나머지 구간은 탭을 처음 고를 때(2026-11-14·11-15 공개 HTML 줄이기).
 */
export type PopularTierGroup = { key: string; label: string; range: string; href: string };

/**
 * 홈 '많이 쓰이는 프로젝트'의 구간 탭과 카드 3장(2026-10-11 시안 안 C) — 탭은 발견하기 정렬 탭과 같은 모양(.tabs),
 * 카드는 발견하기 카드(ProjectCard)라 이름·소개가 잘리지 않고 사이트 미리보기 그림이 썸네일이 된다.
 * 탭은 보이는 판만 바꾸고(주소는 그대로) 판의 카드는 열 때 받는다 — 전체 목록은 '모두 보기'가 /popular 로 간다.
 * 화살표·Home·End 로 탭을 옮긴다(WAI-ARIA 탭 패턴).
 */
export function PopularTierCards({ groups, personal }: { groups: PopularTierGroup[]; personal: boolean }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  // 구간마다의 수는 서버 HTML 에 싣지 않는다(2026-11-15 공개 HTML 이름·요약만) — 받으면 탭·모두 보기 글에 단다
  const totals = useCountsQuery<TierCountsResponse>(`part=tiers${personal ? "&personal=1" : ""}`)?.totals;
  const totalOf = (key: string) => totals?.[key];
  const [current, setCurrent] = useState(0);
  // 한 번 고른 구간은 받은 카드를 그대로 둔다. 처음 구간은 구획이 화면 가까이 오면 연다(홈 목록 아래 — 첫 화면 밖)
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const [barRef, near] = useNearViewport<HTMLDivElement>();
  const open = (index: number) => { setCurrent(index); setOpened((previous) => previous.has(index) ? previous : new Set(previous).add(index)); };
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const select = (index: number) => {
    open(index);
    tabs.current[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = groups.length - 1;
    const next = event.key === "ArrowRight" ? (current === last ? 0 : current + 1)
      : event.key === "ArrowLeft" ? (current === 0 ? last : current - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (next === null) return;
    event.preventDefault();
    select(next);
  };
  const group = groups[current];
  if (!group) return null;
  const total = totalOf(group.key);

  return (
    <>
      <div ref={barRef} className="popular-tier-bar">
        <div className="tabs" role="tablist" aria-label={t("popular.tiers")} onKeyDown={onKeyDown}>
          {groups.map((tier, index) => (
            <button key={tier.key} ref={(element) => { tabs.current[index] = element; }} type="button" role="tab" id={`${id}-tab-${tier.key}`}
              aria-selected={index === current} aria-controls={`${id}-panel-${tier.key}`} tabIndex={index === current ? 0 : -1}
              className={`tab${index === current ? " active" : ""}`} onClick={() => open(index)}
              {...trackAttrs("select_content", { content_type: "popular_tier", content_id: tier.key, surface: "home" })}>
              {tier.label}{totals !== undefined && totalOf(tier.key) !== undefined && <> <span className="tab-count">{count(totalOf(tier.key)!)}</span></>}
            </button>
          ))}
        </div>
        <Link prefetch={false} className="row-more" href={localePath(locale, group.href)}>{total === undefined
          ? t("popular.moreWithoutCount", { tier: group.label })
          : t("popular.more", { tier: group.label, count: count(total) })}</Link>
      </div>
      {groups.map((tier, index) => (
        <div key={tier.key} role="tabpanel" id={`${id}-panel-${tier.key}`} aria-labelledby={`${id}-tab-${tier.key}`} hidden={index !== current}
          data-track-list={`popular_${tier.key}`}
          className="popular-tier-panel">
          <p className="row-note">★ {tier.range} · {t("popular.stars")}</p>
          {opened.has(index) || (near && index === current) ? <LazyRankedPanel tier={tier.key} personal={personal} />
            : index === current && <div aria-busy="true" className="projects-grid" style={{ minHeight: 180 }} />}
        </div>
      ))}
    </>
  );
}
