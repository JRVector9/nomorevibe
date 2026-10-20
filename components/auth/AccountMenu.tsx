"use client";

import "./account-menu.css";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { MeAvatar } from "@/components/me/MeAvatar";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath, safePublicReturnUrl } from "@/lib/i18n/routing";
import { ME_SAVED_LINK, ME_TAB_PATHS } from "@/lib/me/contract";
import { useMeAccount, useUnreadCount } from "@/components/me/account-store";

/**
 * 머리의 계정 자리 — 로그아웃이면 로그인 링크, 로그인이면 이니셜 아바타와 메뉴(마이페이지 시안 머리 그림).
 * 처음 HTML 에는 개인 정보가 없다(엣지 저장 화면). 붙은 뒤 /api/me/summary 한 번(account-store, 다른 부품과 나눠 씀)으로 이름·수단을 받는다.
 * 이름은 닉네임을 바꾸면(patchMeAccount), 알림 수는 종·알림함과 같은 숫자(useUnreadCount)를 따라 그린다.
 */
export function AccountMenu() {
  const locale = useLocale();
  const t = useTranslations("common");
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const loginHref = (returnTo: string) => localePath(locale, `/login?returnTo=${encodeURIComponent(safePublicReturnUrl(returnTo, localePath(locale, "/")))}`);
  const account = useMeAccount();
  const unread = useUnreadCount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // 열리면 첫 항목에 초점, 바깥을 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>(".account-panel a, .account-panel button")?.focus();
    function onPointer(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>(".account-panel a, .account-panel button") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }

  async function logout() {
    if (!account || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/user/logout", { method: "POST", headers: { "x-csrf-token": account.csrfToken } });
      if (!response.ok) throw new Error();
      window.location.reload();
    } catch {
      setError(t("account.logoutFailed"));
      setBusy(false);
    }
  }

  // Authentication uses a fresh document; include the current hash at click time.
  if (!account) return <a href={loginHref(`${pathname}${query ? `?${query}` : ""}`)} onClick={(event) => {
    event.currentTarget.href = loginHref(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  }} className="text-[14px] font-semibold">{t("account.login")}</a>;

  const provider = account.providers[0];
  const via = provider?.provider === "github" ? (provider.login ? t("account.viaGithub", { login: provider.login }) : t("account.viaGithubPlain"))
    : provider?.provider === "email" ? t("account.viaEmail") : null;
  const links = [
    ["account.mypage", ME_TAB_PATHS.saved],
    ...(account.isMaker ? [["account.projects", ME_TAB_PATHS.projects] as const] : []),
    ["account.saved", ME_SAVED_LINK],
    ["account.tried", ME_TAB_PATHS.tried],
    ["account.opinions", ME_TAB_PATHS.opinions],
    ["account.alerts", ME_TAB_PATHS.alerts],
    ["account.settings", ME_TAB_PATHS.account],
  ] as const;
  return (
    <div ref={root} className="account-menu" onKeyDown={onKeyDown} onBlur={(event) => {
      if (open && !root.current?.contains(event.relatedTarget as Node | null) && event.relatedTarget) setOpen(false);
    }}>
      <button ref={button} type="button" className="account-button" aria-expanded={open} aria-controls={panelId}
        aria-label={t("account.menu", { name: account.user.displayName })} onClick={() => setOpen(!open)}>
        <MeAvatar name={account.user.displayName} seed={account.user.id} />
      </button>
      <div id={panelId} className="account-panel" hidden={!open}>
        <div className="account-who">
          <MeAvatar name={account.user.displayName} seed={account.user.id} />
          <span><b title={account.user.displayName}>{account.user.displayName}</b>{via && <small>{via}</small>}</span>
        </div>
        <hr />
        <ul>
          {links.map(([key, path]) => (
            <li key={key}>
              <Link prefetch={false} href={localePath(locale, path)} onClick={() => setOpen(false)}>
                {t(key)}
                {key === "account.alerts" && unread > 0 && <span className="account-count"><span className="sr-only">{t("account.unread", { count: unread })}</span><span aria-hidden="true">{formatNumber(unread, locale)}</span></span>}
              </Link>
            </li>
          ))}
        </ul>
        <hr />
        <button type="button" disabled={busy} onClick={logout} className="account-logout">{t(busy ? "account.busy" : "account.logout")}</button>
        {error && <p role="alert" className="account-error">{error}</p>}
      </div>
    </div>
  );
}
