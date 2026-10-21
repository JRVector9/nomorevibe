"use client";

import Link from "next/link";
import { useState } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { translatedCategory } from "@/components/home/i18n";
import { CATEGORIES } from "@/lib/domain/products/categories";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatNumber, formatRelativeTime } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { FollowTarget } from "@/lib/me/contract";
import { categoryKey } from "@/lib/me/follow-keys";
import type { FollowList } from "@/lib/me/follows";
import { FollowButton } from "./FollowButton";
import { followLabels } from "./follow-labels";
import "./alerts.css";

type Group = "all" | FollowTarget;
const PRODUCT_PREVIEW = 5;
const SUGGESTIONS = 4;

/**
 * 팔로 탭(시안 3.3 ⑥) — 프로젝트·메이커·분야를 한 화면에, 무엇을 받는지 머리줄에 적는다. «팔로 중»을 누르면 바로 풀리고,
 * 풀린 줄은 그 자리에 «팔로»로 남아 다시 누를 수 있다(화면을 다시 열면 빠진다). 위 칩은 종류별 수이자 거르기다.
 */
export function FollowingList({ initial }: { initial: FollowList }) {
  const t = useTranslations("me");
  const labels = useTranslations("labels");
  const locale = useLocale();
  const now = useServerNow();
  const [group, setGroup] = useState<Group>("all");
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState(() => new Map<string, boolean>());
  const keyOf = (target: FollowTarget, key: string) => `${target}:${key}`;
  const isOn = (target: FollowTarget, key: string) => state.get(keyOf(target, key)) ?? true;
  const track = (target: FollowTarget, key: string) => (following: boolean) => setState((current) => new Map(current).set(keyOf(target, key), following));
  const count = (target: FollowTarget, items: Array<{ key: string }>) => items.filter((item) => isOn(target, item.key)).length;

  const products = initial.products.map((item) => ({ ...item, key: String(item.productId) }));
  const makers = initial.makers;
  const categories = initial.categories.map((item) => ({ ...item, key: item.slug }));
  const counts: Record<FollowTarget, number> = { product: count("product", products), maker: count("maker", makers), category: count("category", categories) };
  const followedCategories = new Set(categories.map((item) => item.slug));
  const suggestions = CATEGORIES.filter((category) => !hiddenByDefault(category) && category !== "Other" && !followedCategories.has(categoryKey(category))).slice(0, SUGGESTIONS);

  if (!products.length && !makers.length && !categories.length) {
    return (
      <section className="me-empty">
        <h2>{t("following.empty.title")}</h2>
        <p>{t("following.empty.body")}</p>
        <Link prefetch={false} href={localePath(locale, "/")} className="me-empty-cta">{t("following.empty.cta")}</Link>
      </section>
    );
  }

  const shown = (target: FollowTarget) => group === "all" || group === target;
  const visibleProducts = expanded || group === "product" ? products : products.slice(0, PRODUCT_PREVIEW);
  const rowLabels = (target: FollowTarget, name: string) => followLabels(t, target,
    target === "product" ? t("follow.product", { name }) : target === "maker" ? t("follow.maker", { login: name }) : t("follow.category", { category: name }));

  return (
    <div className="me-following">
      <div className="me-chips" role="group" aria-label={t("following.groups")}>
        {(["all", "product", "maker", "category"] as const).map((value) => (
          <button key={value} type="button" className="me-chip" aria-pressed={group === value} onClick={() => setGroup(value)}>
            {value === "all" ? t("tabs.following") : t(`following.group.${value}`)}
            {value !== "all" && <span className="me-chip-count">{formatNumber(counts[value], locale)}</span>}
          </button>
        ))}
      </div>
      <div className={group === "all" ? "me-following-grid" : "me-following-one"}>
        {shown("product") && products.length > 0 && (
          <section className="me-box" aria-labelledby="following-products">
            <h2 id="following-products" className="me-box-title">{t("following.group.product")} <span className="me-count">{formatNumber(counts.product, locale)}</span></h2>
            <p className="me-desc">{t("following.desc.product")}</p>
            <ul className="me-rows">
              {visibleProducts.map((item) => {
                const body = (
                  <>
                    <ProductIcon name={item.name} ogImage={item.ogImage?.startsWith("/") ? item.ogImage : null} size={40} category={item.category} />
                    <span className="me-row-text">
                      <span className="me-row-title">{item.name}</span>
                      <span className={item.listed ? "me-row-sub" : "me-row-sub down"}>
                        {!item.listed ? t("following.product.unlisted")
                          : item.latest ? `${item.latest.title} · ${formatRelativeTime(item.latest.at, now, locale)}` : t("following.product.quiet")}
                      </span>
                    </span>
                  </>
                );
                return (
                  <li key={item.key} className="me-row">
                    {/* 차단된 제품의 상세는 404 다 — 링크 없이 이름과 «목록에서 내려감», 풀기 단추만 */}
                    {item.listed ? <Link prefetch={false} href={localePath(locale, `/p/${item.slug}`)} className="me-row-main">{body}</Link>
                      : <div className="me-row-main">{body}</div>}
                    <FollowButton target="product" targetKey={item.key} initial variant="row" labels={rowLabels("product", item.name)} onChange={track("product", item.key)} />
                  </li>
                );
              })}
            </ul>
            {visibleProducts.length < products.length && (
              <button type="button" className="me-more" onClick={() => setExpanded(true)}>{t("following.more", { count: formatNumber(products.length - visibleProducts.length, locale) })}</button>
            )}
          </section>
        )}
        {shown("maker") && makers.length > 0 && (
          <section className="me-box" aria-labelledby="following-makers">
            <h2 id="following-makers" className="me-box-title">{t("following.group.maker")} <span className="me-count">{formatNumber(counts.maker, locale)}</span></h2>
            <p className="me-desc">{t("following.desc.maker")}</p>
            <ul className="me-rows">
              {makers.map((item) => (
                <li key={item.key} className="me-row">
                  <Link prefetch={false} href={localePath(locale, `/?q=${encodeURIComponent(item.login)}`)} className="me-row-main">
                    <span className="me-avatar" aria-hidden="true">{item.login.slice(0, 1).toUpperCase()}</span>
                    <span className="me-row-text">
                      <span className="me-row-title">@{item.login}</span>
                      <span className="me-row-sub">{t("following.maker.projects", { count: formatNumber(item.projects, locale) })}</span>
                    </span>
                  </Link>
                  <FollowButton target="maker" targetKey={item.key} initial variant="row" labels={rowLabels("maker", item.login)} onChange={track("maker", item.key)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {shown("category") && (categories.length > 0 || group === "category") && (
          <section className="me-box" aria-labelledby="following-categories">
            <h2 id="following-categories" className="me-box-title">{t("following.group.category")} <span className="me-count">{formatNumber(counts.category, locale)}</span></h2>
            <p className="me-desc">{t("following.desc.category")}</p>
            <ul className="me-rows">
              {categories.map((item) => {
                const label = translatedCategory(item.category, labels);
                return (
                  <li key={item.key} className="me-row">
                    <Link prefetch={false} href={localePath(locale, `/c/${item.slug}?sort=recent`)} className="me-row-main">
                      <ProductIcon name={label} ogImage={null} size={40} category={item.category} />
                      <span className="me-row-text">
                        <span className="me-row-title">{label}</span>
                        <span className="me-row-sub">{t("following.category.week", { count: formatNumber(item.newThisWeek, locale) })}</span>
                      </span>
                    </Link>
                    <FollowButton target="category" targetKey={item.key} initial variant="row" labels={rowLabels("category", label)} onChange={track("category", item.key)} />
                  </li>
                );
              })}
            </ul>
            {suggestions.length > 0 && (
              <>
                <p className="me-desc">{t("following.suggest")}</p>
                <div className="me-chips me-chips-wrap">
                  {suggestions.map((category) => {
                    const label = translatedCategory(category, labels);
                    return <FollowButton key={category} target="category" targetKey={categoryKey(category)} initial={false} variant="chip"
                      labels={{ ...rowLabels("category", label), follow: t("follow.add", { category: label }), following: `${label} · ${t("follow.following")}` }} />;
                  })}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
