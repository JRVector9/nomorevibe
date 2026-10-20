"use client";

import Link from "next/link";
import { useState } from "react";
import { FeedbackDeliveryStatus } from "@/components/product-detail/FeedbackDeliveryStatus";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { OpinionView } from "@/lib/me/opinions";
import { initialOf } from "./MeAvatar";
import { MeIcon } from "./MeIcon";

type Filter = "all" | "accepted" | "held" | "rejected" | "replied";
const FILTERS: Filter[] = ["all", "accepted", "held", "rejected", "replied"];
const TILES = ["hue", "note", "day", "form", "invoice", "paper"] as const;
const tileOf = (id: number) => `var(--tile-${TILES[Math.abs(id) % TILES.length]})`;
const matches = (item: OpinionView, filter: Filter) => filter === "all" || (filter === "replied" ? item.reply !== null : item.reviewState === filter);

/** 의견 탭 목록 — 상태는 색만이 아니라 글자로도 적고, 검토 중·숨김은 누가 보는지와 이유를 한 줄로 밝힌다 */
export function OpinionList({ opinions }: { opinions: OpinionView[] }) {
  const t = useTranslations("me");
  const detail = useTranslations("detail");
  const locale = useLocale();
  const now = useServerNow();
  const [filter, setFilter] = useState<Filter>("all");

  if (!opinions.length) {
    return (
      <section className="me-empty" aria-labelledby="me-opinions-empty">
        <span className="me-empty-ic"><MeIcon name="chat" size={26} /></span>
        <h2 id="me-opinions-empty">{t("opinions.emptyTitle")}</h2>
        <p>{t("opinions.emptyBody")}</p>
        <Link prefetch={false} className="me-btn me-btn-pri me-btn-lg" href={localePath(locale, "/rising")}>{t("opinions.emptyCta")}</Link>
      </section>
    );
  }

  const shown = opinions.filter((item) => matches(item, filter));
  const reason = (value: string) => detail("feedback.reviewReason", {
    reason: value === "too_many_urls" || value === "repeated_body" ? detail(`feedback.reason.${value}`) : value,
  });
  return (
    <section className="me-opinions" aria-labelledby="me-opinions-title">
      <h2 id="me-opinions-title" className="sr-only">{t("opinions.title")}</h2>
      <div className="me-ptool">
        <div className="me-chips" role="group" aria-label={t("opinions.filter")}>
          {FILTERS.map((value) => (
            <button key={value} type="button" className="me-chip" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {t(`opinions.filter.${value}`)} <span className="me-cc">{formatNumber(opinions.filter((item) => matches(item, value)).length, locale)}</span>
            </button>
          ))}
        </div>
        <p className="me-note">{t("opinions.tiedNote")}</p>
      </div>
      {shown.length ? (
        <ul className="me-olist">
          {shown.map((item) => (
            <li key={item.id} className="me-orow">
              <span className="me-mi" style={{ background: tileOf(item.productId) }} aria-hidden="true">{initialOf(item.productName)}</span>
              <div className="me-orow-h">
                <Link prefetch={false} className="me-orow-n" href={localePath(locale, `/p/${item.slug}`)}>{item.productName}</Link>
                <span className="me-state me-state-kind">{detail(item.kind === "feature" ? "feedback.kind.featureShort" : `feedback.kind.${item.kind}`)}</span>
                <span className={`me-state me-state-${item.reviewState === "accepted" ? "on" : item.reviewState === "held" ? "warn" : "off"}`}>{t(`opinions.state.${item.reviewState}`)}</span>
              </div>
              <Link prefetch={false} className="me-btn me-btn-sm me-orow-open" href={localePath(locale, `/feedback/${item.id}`)}>{t("opinions.open")}</Link>
              <div className="me-orow-b">
                {item.reviewState === "rejected" ? <p className="me-quote me-quote-hid">{t("opinions.rejectedNote")}</p> : <>
                  <p className="me-quote-t">{item.title}</p>
                  <p className="me-quote">{item.body}</p>
                </>}
                {item.reviewState === "held" && <p className="me-note">{t("opinions.heldNote")}</p>}
                {item.reviewReason && <p className="me-note">{reason(item.reviewReason)}</p>}
                <p className="me-meta">
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt, now, locale)}</time>
                  {(item.deliveryState !== "local_only" || item.githubIssueUrl) && <span><FeedbackDeliveryStatus feedback={item} compact /></span>}
                </p>
                {item.reply && (
                  <div className="me-reply">
                    <p className="me-reply-h"><span className="me-mk">{t("opinions.makerReply")}</span>{item.reply.authorDisplayName} · {formatDate(item.reply.createdAt, now, locale)}</p>
                    <p>{item.reply.body}</p>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="me-note me-filtered-empty" role="status">{t("opinions.filteredEmpty")}</p>}
      {opinions.length >= 100 && <p className="me-hint">{t("opinions.limit")}</p>}
    </section>
  );
}
