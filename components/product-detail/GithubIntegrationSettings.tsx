"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import type { DetailTextKey } from "./format";
import { useState } from "react";

type BindingView = { repositoryFullName: string; repositoryUrl: string; enabled: boolean; revision: number; blockedReason: string | null };
const ERROR: Record<string, DetailTextKey> = {
  login_required: "error.login_required", invalid_csrf: "error.invalid_csrf",
  maker_edit_token_required: "error.maker_edit_token_required", maker_edit_token_invalid: "error.maker_edit_token_invalid",
  github_feedback_consent_required: "error.github_feedback_consent_required",
  github_repository_invalid: "error.github_repository_invalid",
  github_repository_unavailable: "error.github_repository_unavailable",
  github_repository_private: "error.github_repository_private", github_repository_archived: "error.github_repository_archived",
  github_repository_issues_disabled: "error.github_repository_issues_disabled",
  github_binding_revision_conflict: "error.github_binding_revision_conflict",
  github_maker_authorization_changed: "error.github_maker_authorization_changed",
  github_feedback_disabled: "error.github_feedback_disabled",
};

export function GithubIntegrationSettings({ slug, csrfToken, installationPending = false }: { slug: string; csrfToken: string; installationPending?: boolean }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const [editToken, setEditToken] = useState("");
  const [consent, setConsent] = useState(false);
  const [binding, setBinding] = useState<BindingView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<DetailTextKey | null>(null);
  const [error, setError] = useState<DetailTextKey | null>(null);
  const settingsUrl = `/api/products/${encodeURIComponent(slug)}/github-integration`;

  async function request(url: string, method: "GET" | "POST" | "PUT", body?: Record<string, unknown>) {
    if (!editToken) throw new Error("maker_edit_token_required");
    const response = await fetch(url, { method, cache: "no-store", credentials: "same-origin", headers: { "X-Edit-Token": editToken, "X-CSRF-Token": csrfToken, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "unavailable");
    return value;
  }
  async function act(action: () => Promise<void>) {
    setPending(true); setError(null); setMessage(null);
    try { await action(); }
    catch (failure) { setError(ERROR[failure instanceof Error ? failure.message : ""] ?? "settings.failed"); }
    finally { setPending(false); }
  }
  function load(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(async () => {
      const value = await request(settingsUrl, "GET");
      setBinding(value.binding); setLoaded(true);
      setMessage(value.binding ? "settings.loaded" : "settings.notConnected");
    });
  }
  function connect() {
    void act(async () => {
      if (!consent) throw new Error("github_feedback_consent_required");
      const current = new URL(window.location.href);
      const returnTo = `${localePath(locale, `/p/${encodeURIComponent(slug)}/github`)}${current.search}${current.hash}`;
      const value = await request("/api/auth/maker/github", "POST", { slug, deliveryConsent: true, returnTo });
      const target = new URL(value.authorizeUrl);
      if (target.origin !== "https://github.com" || target.pathname !== "/login/oauth/authorize") throw new Error("unavailable");
      setEditToken("");
      window.location.assign(target.toString());
    });
  }
  function disable() {
    if (!binding) return;
    void act(async () => {
      const value = await request(settingsUrl, "PUT", { enabled: false, expectedRevision: binding.revision });
      setBinding(value.binding); setMessage("settings.stopped");
    });
  }

  return <section className="mt-6 space-y-5">
    {installationPending && <p role="status" className="rounded-lg border border-line p-4 text-[14px] leading-6">{t("settings.pendingInstallation")}</p>}
    <p className="text-[14px] leading-6 text-fg-2">{t("settings.description")}</p>
    <fieldset disabled={pending} className="space-y-5">
      <form onSubmit={load} className="space-y-3">
        <label className="block text-[14px]">{t("settings.editKey")}<input type="password" autoComplete="off" required maxLength={512} value={editToken} onChange={event => setEditToken(event.target.value)} className="mt-1 w-full rounded-lg border border-line bg-bg-card p-3 text-fg" /></label>
        <p className="text-[13px] text-fg-2">{t("settings.keyNote")}</p>
        <button type="submit" className="min-h-11 rounded-full border border-line px-5 text-[14px]">{t("settings.load")}</button>
      </form>
      {loaded && binding && <div className="rounded-lg border border-line p-4 text-[14px] leading-6">
        <a href={binding.repositoryUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{binding.repositoryFullName}</a>
        <p>{binding.enabled ? t("settings.enabled") : t("settings.disabled")}</p>
        {binding.enabled && <button type="button" onClick={disable} className="mt-3 min-h-11 rounded-full border border-line px-5">{t("settings.stop")}</button>}
      </div>}
      <label className="flex items-start gap-3 text-[14px] leading-6"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-1" />{t("settings.consent")}</label>
      <button type="button" disabled={!consent || !editToken} onClick={connect} className="min-h-11 rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white disabled:opacity-50">{pending ? t("settings.checking") : binding ? t("settings.reconnect") : t("settings.connect")}</button>
    </fieldset>
    {message && <p role="status" className="text-[14px] leading-6">{t(message)}</p>}
    {error && <p role="alert" className="text-[14px] leading-6">{t(error)}</p>}
  </section>;
}
