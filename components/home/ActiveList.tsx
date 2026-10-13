"use client";

import Link from "next/link";
import { ProductIcon } from "@/components/ProductIcon";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import { translatedCategory } from "./i18n";
import type { HomePulse } from "@/lib/domain/products/home-pulse";

/** 이번 주 가장 활발한 — 새 버전 수 상위 5, 막대 없이 번호·아이콘·이름·숫자만 */
export function ActiveList({ active, projects }: { active: HomePulse["active"]; projects: number }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const labels = useTranslations("labels");
  const count = (n: number) => formatNumber(n, locale);
  const rows = active.slice(0, 5);
  return (
    <section className="active-list" aria-labelledby="active-title">
      <div className="row-head">
        <h2 id="active-title" className="row-title">{t("active.title")}</h2>
        <span className="row-note">{t("active.note")}</span>
      </div>
      {rows.length === 0 ? (
        <p className="row-foot">{t("active.empty")}</p>
      ) : (
        <ol className="rank-list">
          {rows.map((item, index) => (
            <li key={item.slug} className="rank-row">
              <span className="rank-no">{index + 1}</span>
              <ProductIcon name={item.name} ogImage={item.ogImage} size={28} category={item.category} />
              <span className="rank-name">
                <Link prefetch={false} href={localePath(locale, `/p/${item.slug}`)}>{item.name}</Link>
                <small>{translatedCategory(item.category, labels)}{item.stars !== null && item.stars >= 100 ? ` · ★ ${count(item.stars)}` : ""}</small>
              </span>
              <b className="rank-value">{t("count.releases", { count: count(item.releases) })}</b>
            </li>
          ))}
        </ol>
      )}
      <p className="row-foot">{t("active.footer", { count: count(projects) })}</p>
    </section>
  );
}
