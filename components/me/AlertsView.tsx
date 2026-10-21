"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate, formatNumber, formatRelativeTime } from "@/lib/i18n/format";
import { NOTIFICATION_RETENTION_DAYS } from "@/lib/me/contract";
import { groupByDay, type NotificationView } from "@/lib/me/notification-view";
import type { Inbox } from "@/lib/me/inbox";
import { seedUnreadCount, setUnreadCount, useUnreadCount } from "./account-store";
import { sendRead } from "./AlertBell";
import { NotificationText } from "./NotificationText";
import "./alerts.css";

/**
 * 알림 탭(시안 3.4 ⑦⑧) — 넓은 화면은 알림함과 설정을 나란히, 휴대폰은 알림함 | 알림 설정 두 칸 전환.
 * 안 읽은 줄은 바탕과 점으로 가르고, 누르면 읽음으로 바꾼 뒤 그 제품(또는 대상)으로 간다. 설정 칸은 MY7 이 채운다.
 * 안 읽은 수는 종·탭·아바타 메뉴와 같은 숫자(useUnreadCount)다 — 넓은 화면에서 이 탭 위의 종으로 «모두 읽음»을 눌러도 여기가 따라간다
 * (수가 0 이 되면 모든 줄을 읽음으로 그린다).
 */
export function AlertsView({ initial, settings }: { initial: Inbox; settings: ReactNode }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const now = useServerNow();
  const [view, setView] = useState<"inbox" | "settings">("inbox");
  const [items, setItems] = useState<NotificationView[]>(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const unread = useUnreadCount(initial.unread);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const isRead = (item: NotificationView) => item.read || unread === 0;

  // 서버가 방금 센 수 — 이 화면이 아직 숫자를 모를 때만(뒤로 가기로 돌아온 옛 화면이 새 숫자를 덮지 않게)
  useEffect(() => { seedUnreadCount(initial.unread); }, [initial.unread]);

  async function readAll() {
    setBusy(true);
    // 남은 수는 sendRead 가 같은 숫자(store)에 적는다
    const left = await sendRead({ all: true });
    setBusy(false);
    if (left === null) return setFailed(true);
    setItems((current) => current.map((item) => ({ ...item, read: true })));
  }

  function open(item: NotificationView) {
    if (isRead(item)) return;
    setItems((current) => current.map((row) => row.id === item.id ? { ...row, read: true } : row));
    void sendRead({ ids: [item.id] });
  }

  async function more() {
    if (!cursor) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/me/notifications?cursor=${cursor}&locale=${locale}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const page = await response.json() as Inbox;
      setItems((current) => [...current, ...page.items.filter((item) => !current.some((row) => row.id === item.id))]);
      setCursor(page.nextCursor);
      setUnreadCount(page.unread);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="me-alerts" data-view={view}>
      <div className="me-switch" role="group" aria-label={t("alerts.view")}>
        <button type="button" aria-pressed={view === "inbox"} onClick={() => setView("inbox")}>{t("alerts.inbox")}</button>
        <button type="button" aria-pressed={view === "settings"} onClick={() => setView("settings")}>{t("alerts.settings")}</button>
      </div>
      <section className="me-box me-alerts-inbox" aria-labelledby="alerts-inbox-title">
        <div className="me-box-head">
          <h2 id="alerts-inbox-title" className="me-box-title">
            {t("alerts.title")}
            {unread > 0 && <span className="me-count hot" aria-label={t("alerts.unreadCount", { count: unread })}>{formatNumber(unread, locale)}</span>}
          </h2>
          {items.length > 0 && <button type="button" className="me-small" disabled={busy || unread === 0} onClick={() => void readAll()}>{t("alerts.readAll")}</button>}
        </div>
        {items.length === 0 ? (
          <div className="me-empty quiet">
            <h3>{t("alerts.empty.title")}</h3>
            <p>{t("alerts.empty.body")}</p>
          </div>
        ) : groupByDay(items, now).map(({ group, items: rows }) => (
          <div key={group} role="group" aria-labelledby={`alerts-${group}`}>
            <h3 id={`alerts-${group}`} className="me-group">{t(`alerts.group.${group}`)}</h3>
            <ul className="me-notes">
              {rows.map((item) => (
                <li key={item.id}>
                  <a href={item.href} className={isRead(item) ? "me-note" : "me-note unread"} onClick={() => open(item)}>
                    {item.tile ? <ProductIcon name={item.tile.name} ogImage={item.tile.ogImage?.startsWith("/") ? item.tile.ogImage : null} size={36} category={item.tile.category} />
                      : <span className="me-note-tile" aria-hidden="true" />}
                    <span className="me-note-kind">{item.label}{!isRead(item) && <span className="sr-only"> · {t("alerts.unread")}</span>}</span>
                    <time className="me-note-time" dateTime={item.createdAt}>
                      {group === "today" ? formatRelativeTime(item.createdAt, now, locale) : formatDate(item.createdAt, now, locale)}
                    </time>
                    <NotificationText parts={item.parts} />
                    {item.quote && <span className="me-note-quote">“{item.quote}”</span>}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {cursor && <button type="button" className="me-more" disabled={busy} onClick={() => void more()}>{t("alerts.more")}</button>}
        {failed && <p className="me-error" role="alert">{t("alerts.failed")}</p>}
        <p className="me-hint">{t("alerts.retention", { days: NOTIFICATION_RETENTION_DAYS })}</p>
      </section>
      <section className="me-box me-alerts-settings" aria-label={t("alerts.settings")}>
        {settings}
      </section>
    </div>
  );
}
