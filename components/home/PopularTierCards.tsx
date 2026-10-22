"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { RankedCardProduct } from "@/components/home/popular-cards";
import { RankedCards } from "@/components/home/RankedCards";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import { trackAttrs } from "@/lib/analytics/attrs";


export type PopularTierGroup = { key: string; label: string; range: string; total: number; href: string; items: RankedCardProduct[] };

/**
 * 홈 '많이 쓰이는 프로젝트'의 구간 탭과 카드 3장(2026-10-11 시안 안 C) — 탭은 발견하기 정렬 탭과 같은 모양(.tabs),
 * 카드는 발견하기 카드(ProjectCard) 그대로라 이름·소개가 잘리지 않고 사이트 미리보기 그림이 썸네일이 된다.
 * 네 구간을 서버가 함께 그려 두고 탭은 보이는 판만 바꾼다(주소는 그대로) — 전체 목록은 '모두 보기'가 /popular 로 간다.
 * 화살표·Home·End 로 탭을 옮긴다(WAI-ARIA 탭 패턴).
 */
export function PopularTierCards({ groups, now }: { groups: PopularTierGroup[]; now: string }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  const [current, setCurrent] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const select = (index: number) => {
    setCurrent(index);
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

  return (
    <>
      <div className="popular-tier-bar">
        <div className="tabs" role="tablist" aria-label={t("popular.tiers")} onKeyDown={onKeyDown}>
          {groups.map((tier, index) => (
            <button key={tier.key} ref={(element) => { tabs.current[index] = element; }} type="button" role="tab" id={`${id}-tab-${tier.key}`}
              aria-selected={index === current} aria-controls={`${id}-panel-${tier.key}`} tabIndex={index === current ? 0 : -1}
              className={`tab${index === current ? " active" : ""}`} onClick={() => setCurrent(index)}
              {...trackAttrs("select_content", { content_type: "popular_tier", content_id: tier.key, surface: "home" })}>
              {tier.label} <span className="tab-count">{count(tier.total)}</span>
            </button>
          ))}
        </div>
        <Link prefetch={false} className="row-more" href={localePath(locale, group.href)}>{t("popular.more", { tier: group.label, count: count(group.total) })}</Link>
      </div>
      {groups.map((tier, index) => (
        <div key={tier.key} role="tabpanel" id={`${id}-panel-${tier.key}`} aria-labelledby={`${id}-tab-${tier.key}`} hidden={index !== current}
          data-track-list={`popular_${tier.key}`}
          className="popular-tier-panel">
          <p className="row-note">★ {tier.range} · {t("popular.stars")}</p>
          {tier.items.length ? <RankedCards items={tier.items} now={now} /> : <p className="popular-empty">{t("popular.empty")}</p>}
        </div>
      ))}
    </>
  );
}
