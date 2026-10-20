"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatRelativeTime } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { NotificationView } from "@/lib/me/notification-view";
import { loadMeAccount, setUnreadCount, useMeAccount, useUnreadCount } from "./account-store";
import { NotificationText } from "./NotificationText";
import "./bell.css";

const POPOVER_ITEMS = 5;

function BellIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

/** 읽음 표시는 이동을 막지 않는다 — 문서가 바뀌어도 요청이 끝나게 keepalive 로 보낸다 */
export async function sendRead(body: { ids: number[] } | { all: true }): Promise<number | null> {
  const me = await loadMeAccount();
  if (!me) return null;
  const response = await fetch("/api/me/notifications/read", { method: "POST", keepalive: true,
    headers: { "content-type": "application/json", "x-csrf-token": me.csrfToken }, body: JSON.stringify(body) }).catch(() => null);
  if (!response?.ok) return null;
  const unread = Number((await response.json().catch(() => ({}))).unread);
  if (Number.isFinite(unread)) setUnreadCount(unread);
  return unread;
}

/**
 * 머리의 종(로그인 설계 M5) — 로그인했을 때만, 안 읽은 수를 배지로. 누르면 최근 다섯 줄과 «모두 읽음», 알림함 전체 보기.
 * 좁은 화면에서는 감춘다 — 아래 탭 '마이' 점이 같은 숫자를 따른다(useUnreadCount).
 */
export function AlertBell() {
  const t = useTranslations("common");
  const locale = useLocale();
  const account = useMeAccount();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    fetch(`/api/me/notifications?limit=${POPOVER_ITEMS}&locale=${locale}`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body = await response.json() as { items: NotificationView[]; unread: number };
        setItems(body.items);
        setUnreadCount(body.unread);
      }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    function close(event: KeyboardEvent | PointerEvent) {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        setOpen(false);
        button.current?.focus();
      } else if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      abort.abort();
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open, locale]);

  // 열리면 창으로 초점을 옮기고, 줄이 오면 첫 알림으로 — 그사이 사용자가 창 안에서 옮긴 초점은 건드리지 않는다
  useEffect(() => {
    const panel = open ? document.getElementById(panelId) : null;
    if (!panel || (panel.contains(document.activeElement) && document.activeElement !== panel)) return;
    const first = items === null && !failed ? null : panel.querySelector<HTMLElement>(".alert-bell-item") ?? panel.querySelector<HTMLElement>("a, button");
    (first ?? panel).focus();
  }, [open, items, failed, panelId]);

  if (!account) return null;
  const now = new Date();

  async function readAll() {
    if (await sendRead({ all: true }) !== null) setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? null);
  }

  return (
    <div ref={wrapper} className="alert-bell" onBlur={(event) => {
      if (open && event.relatedTarget && !wrapper.current?.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
      <button ref={button} type="button" className="alert-bell-button" aria-expanded={open} aria-controls={panelId} onClick={() => { setFailed(false); setOpen(!open); }}
        aria-label={unread ? t("bell.unread", { count: unread }) : t("bell.label")}>
        <BellIcon />
        {unread > 0 && <b className="alert-bell-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</b>}
      </button>
      {open && (
        <div id={panelId} className="alert-bell-panel" role="dialog" aria-label={t("bell.label")} tabIndex={-1}>
          <div className="alert-bell-head">
            <strong>{t("bell.label")}</strong>
            {unread > 0 && <button type="button" onClick={() => void readAll()}>{t("bell.readAll")}</button>}
          </div>
          {failed ? <p className="alert-bell-note" role="alert">{t("bell.failed")}</p>
            : items === null ? <p className="alert-bell-note" aria-busy="true">…</p>
              : items.length === 0 ? <p className="alert-bell-note">{t("bell.empty")}</p>
                : (
                  <ul>
                    {items.map((item) => (
                      <li key={item.id}>
                        <a href={item.href} className={item.read ? "alert-bell-item" : "alert-bell-item unread"}
                          onClick={() => { if (!item.read) void sendRead({ ids: [item.id] }); }}>
                          {item.tile ? <ProductIcon name={item.tile.name} ogImage={item.tile.ogImage?.startsWith("/") ? item.tile.ogImage : null} size={32} category={item.tile.category ?? undefined} />
                            : <span className="alert-bell-tile" aria-hidden="true" />}
                          <span className="alert-bell-text">
                            <span className="alert-bell-kind">{item.label} · {formatRelativeTime(item.createdAt, now, locale)}</span>
                            <NotificationText parts={item.parts} />
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
          <Link prefetch={false} href={localePath(locale, "/me/alerts")} className="alert-bell-all" onClick={() => setOpen(false)}>{t("bell.all")}</Link>
        </div>
      )}
    </div>
  );
}
