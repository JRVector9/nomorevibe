"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "@/lib/i18n/context";
import type { MessageKey } from "@/lib/i18n/messages";
import { trackAttrs } from "@/lib/analytics/attrs";

type Connection = { githubUserId: number; login: string; state: "active" | "needs_reconnect" | "revoked" };
type ErrorKey = Extract<MessageKey<"auth">, `error.${string}`>;
const ERRORS: Record<string, ErrorKey> = {
  github_identity_conflict: "error.githubConflict",
  github_authorization_declined: "error.githubDeclined",
  invalid_github_flow: "error.githubFlow",
  github_integration_unconfigured: "error.githubUnconfigured",
};

export function GithubConnection({ returnTo = "/", signedIn = false }: { returnTo?: string; signedIn?: boolean }) {
  const t = useTranslations("auth");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [sessionCsrf, setSessionCsrf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const failure = new URLSearchParams(window.location.search).get("githubError");
    fetch("/api/me", { cache: "no-store", signal: abort.signal }).then(async (response) => {
      if (failure) setError(ERRORS[failure] ?? "error.githubCallback");
      if (!response.ok) throw new Error();
      const me = await response.json();
      if (!me.user) return;
      setSessionCsrf(me.csrfToken);
      const current = await fetch("/api/me/github", { cache: "no-store", signal: abort.signal });
      if (current.ok) setConnection((await current.json()).connection);
    }).catch(() => { if (!abort.signal.aborted) setError("error.githubLoad"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);

  async function connect() {
    if (busy || !consent) return;
    setBusy(true); setError(null);
    try {
      let csrf = sessionCsrf;
      if (!csrf) {
        const bootstrap = await fetch("/api/auth/user/email/start", { cache: "no-store" });
        const body = await bootstrap.json();
        if (!bootstrap.ok) throw new Error(body.error);
        csrf = body.csrfToken;
      }
      const response = await fetch("/api/auth/user/github", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrf! }, body: JSON.stringify({ consent, returnTo }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      window.location.assign(body.authorizeUrl);
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "";
      setError(ERRORS[code] ?? "error.githubStart");
      setBusy(false);
    }
  }
  async function disconnect() {
    if (busy || !sessionCsrf) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/me/github", { method: "DELETE", headers: { "x-csrf-token": sessionCsrf } });
      if (!response.ok) throw new Error();
      setConnection(connection ? { ...connection, state: "revoked" } : null);
    } catch { setError("error.githubDisconnect"); }
    finally { setBusy(false); }
  }
  return (
    <section className={signedIn ? "mt-7 border-t border-line pt-6" : "mt-6"} aria-label={signedIn ? t("github.connectionSection") : t("github.signInSection")}>
      <h2 className="text-[17px] font-semibold">{signedIn ? t("github.connectionSection") : t("github.signIn")}</h2>
      <p className="mt-2 text-[14px] leading-6 text-fg-2">{signedIn ? t("github.connectionDescription") : t("github.signInDescription")}</p>
      {loading ? <p className="mt-3 text-[14px]" role="status">{t("github.loading")}</p> : connection?.state === "active" ? <>
        <p className="mt-3 text-[14px]" role="status">{t("github.connected", { login: connection.login })}</p>
        <p className="mt-2 text-[14px] text-fg-2">{t("github.starsRetained")}</p>
        <button type="button" disabled={busy} onClick={disconnect} className="mt-3 min-h-11 rounded-lg border border-line px-4 text-[14px]">{t("github.disconnect")}</button>
      </> : <>
        {connection?.state === "needs_reconnect" && <p className="mt-3 text-[14px]" role="status">{t("github.reconnectRequired")}</p>}
        <label className="mt-4 flex items-start gap-2 text-[14px] leading-6"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} className="mt-1" />{t("github.consent")}</label>
        <button type="button" disabled={busy || loading || !consent} onClick={connect}
          {...(signedIn ? trackAttrs("github_connect_start", { kind: "star", surface: "login" }) : trackAttrs("login_start", { method: "github", surface: "login" }))}
          className={`mt-4 min-h-11 w-full rounded-lg px-4 py-3 text-[14px] font-semibold disabled:opacity-50 ${signedIn ? "border border-line" : "bg-accent-solid text-white"}`}>{busy ? t("github.busy") : connection?.state === "needs_reconnect" ? t("github.reconnect") : signedIn ? t("github.connect") : t("github.signIn")}</button>
      </>}
      {error && <p role="alert" className="mt-3 text-[14px] text-down">{t(error)}</p>}
    </section>
  );
}
