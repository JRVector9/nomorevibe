"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import type { ReactNode } from "react";
import { LazyRankedPanelSlot as LazyRankedPanel } from "@/components/cards/lazy-slots";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import { trackAttrs } from "@/lib/analytics/attrs";


/**
 * 구간 탭 하나 — 처음 보이는 구간의 카드 판(panel)은 서버가 그려 넘기고, 나머지 구간(lazy)은 탭을 처음 고를 때 받는다.
 * 제품 값은 이 부품의 속성으로 넘어오지 않는다(2026-11-14 공개 HTML 줄이기).
 */
export type PopularTierGroup = { key: string; label: string; range: string; total: number; href: string; panel: ReactNode; lazy?: { personal: boolean } };

/**
 * 홈 '많이 쓰이는 프로젝트'의 구간 탭과 카드 3장(2026-10-11 시안 안 C) — 탭은 발견하기 정렬 탭과 같은 모양(.tabs),
 * 카드는 발견하기 카드 마크업 그대로(서버가 그린 판)라 이름·소개가 잘리지 않고 사이트 미리보기 그림이 썸네일이 된다.
 * 네 구간을 서버가 함께 그려 두고 탭은 보이는 판만 바꾼다(주소는 그대로) — 전체 목록은 '모두 보기'가 /popular 로 간다.
 * 화살표·Home·End 로 탭을 옮긴다(WAI-ARIA 탭 패턴).
 */
export function PopularTierCards({ groups }: { groups: PopularTierGroup[] }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  const [current, setCurrent] = useState(0);
  // 한 번 고른 구간은 받은 카드를 그대로 둔다
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set([0]));
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

  return (
    <>
      <div className="popular-tier-bar">
        <div className="tabs" role="tablist" aria-label={t("popular.tiers")} onKeyDown={onKeyDown}>
          {groups.map((tier, index) => (
            <button key={tier.key} ref={(element) => { tabs.current[index] = element; }} type="button" role="tab" id={`${id}-tab-${tier.key}`}
              aria-selected={index === current} aria-controls={`${id}-panel-${tier.key}`} tabIndex={index === current ? 0 : -1}
              className={`tab${index === current ? " active" : ""}`} onClick={() => open(index)}
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
          {tier.lazy ? opened.has(index) && <LazyRankedPanel tier={tier.key} personal={tier.lazy.personal} />
            : tier.panel ?? <p className="popular-empty">{t("popular.empty")}</p>}
        </div>
      ))}
    </>
  );
}
