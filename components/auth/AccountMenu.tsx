"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath, safePublicReturnUrl } from "@/lib/i18n/routing";

type PublicAccount = { user: { id: number; displayName: string }; csrfToken: string };

export function AccountMenu() {
  const locale = useLocale();
  const t = useTranslations("common");
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const loginHref = (returnTo: string) => localePath(locale, `/login?returnTo=${encodeURIComponent(safePublicReturnUrl(returnTo, localePath(locale, "/")))}`);
  const [account, setAccount] = useState<PublicAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/me", { cache: "no-store", signal: abort.signal }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json();
      if (body.user && body.csrfToken) setAccount(body);
    }).catch(() => {});
    return () => abort.abort();
  }, []);

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
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span className="max-w-28 truncate" title={account.user.displayName}>{account.user.displayName}</span>
      <button type="button" disabled={busy} onClick={logout} className="min-h-11 px-1 text-fg-2 disabled:opacity-50">{t(busy ? "account.busy" : "account.logout")}</button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
