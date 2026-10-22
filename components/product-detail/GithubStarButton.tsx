"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath, stripLocale } from "@/lib/i18n/routing";
import type { DetailTextKey } from "./format";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StarView } from "@/lib/domain/github-stars/contract";
import { trackAttrs } from "@/lib/analytics/attrs";

const reconnectErrors = new Set(["login_required", "github_not_connected", "github_needs_reconnect"]);
type ConnectionNeeded = false | "connect" | "reconnect";
type Control = { view?: StarView; csrf?: string; connectionNeeded: ConnectionNeeded; message: DetailTextKey | "" };
export function newerStarView(current: StarView | null, incoming: StarView): StarView {
  return current && current.revision > incoming.revision ? current : incoming;
}
function unknownMessage(view: StarView): DetailTextKey {
  return view.uncertain ? "star.uncertain" : "star.unavailable";
}
async function loadControl(endpoint: string, signal?: AbortSignal): Promise<Control> {
  const meResponse = await fetch("/api/me", { cache: "no-store", signal });
  const me = await meResponse.json();
  if (!meResponse.ok || (me.user && typeof me.csrfToken !== "string")) return { connectionNeeded: false, message: "star.unavailable" };
  if (!me.user) return { connectionNeeded: "connect", message: "" };
  const response = await fetch(endpoint, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) return { csrf: me.csrfToken, connectionNeeded: result.error === "github_needs_reconnect" ? "reconnect" : reconnectErrors.has(result.error) ? "connect" : false, message: reconnectErrors.has(result.error) ? "" : "star.unavailable" };
  return { csrf: me.csrfToken, view: result, connectionNeeded: result.state === "needs_reconnect" ? "reconnect" : false, message: result.state === "unknown" ? unknownMessage(result) : "" };
}
export function GithubStarButton({ slug, stars = null }: { slug: string; stars?: number | null }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const [view, setView] = useState<StarView | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [connectionNeeded, setConnectionNeeded] = useState<ConnectionNeeded>(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<DetailTextKey | "">("");
  const [showMessage, setShowMessage] = useState(false);
  const [countState, setCountState] = useState<{ initial: StarView["state"]; state: StarView["state"]; revision: number } | null>(null);
  const requestGeneration = useRef(0);
  const endpoint = `/api/products/${encodeURIComponent(slug)}/github-star`;
  const loginHref = localePath(locale, `/login?connectGithub=1&returnTo=${encodeURIComponent(localePath(locale, `/p/${slug}`))}`);

  const applyControl = useCallback((result: Control) => {
    setCsrf(result.csrf ?? null); setView((current) => result.view ? newerStarView(current, result.view) : null);
    setConnectionNeeded(result.connectionNeeded); setMessage(result.message);
    const incoming = result.view;
    if (incoming && !incoming.pending && !incoming.uncertain && (incoming.state === "starred" || incoming.state === "unstarred")) {
      setCountState((current) => current && current.revision > incoming.revision ? current : {
        initial: current?.initial ?? incoming.state, state: incoming.state, revision: incoming.revision,
      });
    }
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setBusy(true); setMessage("");
    try {
      const result = await loadControl(endpoint);
      if (generation !== requestGeneration.current) return null;
      applyControl(result);
      return { generation, message: result.message };
    } catch {
      if (generation !== requestGeneration.current) return null;
      const message = "star.unavailable" as const;
      setMessage(message);
      return { generation, message };
    } finally { if (generation === requestGeneration.current) setBusy(false); }
  }, [endpoint, applyControl]);

  useEffect(() => {
    const controller = new AbortController();
    const generationState = requestGeneration;
    const generation = ++generationState.current;
    void loadControl(endpoint, controller.signal).then((result) => {
      if (!controller.signal.aborted && generation === requestGeneration.current) applyControl(result);
    }).catch(() => {
      if (!controller.signal.aborted && generation === requestGeneration.current) setMessage("star.unavailable");
    }).finally(() => {
      if (!controller.signal.aborted && generation === requestGeneration.current) setBusy(false);
    });
    return () => { controller.abort(); ++generationState.current; };
  }, [endpoint, applyControl]);

  async function toggle() {
    if (!view || !csrf || busy || view.pending || !["starred", "unstarred"].includes(view.state)) return;
    const starred = view.state !== "starred";
    let generation = ++requestGeneration.current;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ starred, operationId: crypto.randomUUID(), expectedRevision: view.revision }), cache: "no-store" });
      const result = await response.json();
      if (generation !== requestGeneration.current) return;
      if (!response.ok) {
        if (result.star) setView((current) => newerStarView(current, result.star));
        if (reconnectErrors.has(result.error)) { setConnectionNeeded(result.error === "github_needs_reconnect" ? "reconnect" : "connect"); setView(null); }
        else if (response.status === 429) setMessage("star.rateLimited");
        else if (result.error === "star_write_rejected" && response.status === 403) setMessage("star.rejected");
        else {
          const refreshed = await refresh();
          if (!refreshed || refreshed.generation !== requestGeneration.current) return;
          generation = refreshed.generation;
          if (!refreshed.message) setMessage("star.checkResult");
        }
        return;
      }
      applyControl({ view: result, csrf, connectionNeeded: result.state === "needs_reconnect" ? "reconnect" : false, message: "" });
      if (result.state === "unknown") setMessage(unknownMessage(result));
      else if (result.retryAt) setMessage("star.rateLimited");
      else if (result.state !== (starred ? "starred" : "unstarred") && result.state !== "needs_reconnect") setMessage("star.notConfirmed");
    } catch {
      if (generation !== requestGeneration.current) return;
      // A failed browser response can still follow a successful server write.
      setView((current) => current ? { ...current, state: "unknown", pending: false } : current);
      setMessage("star.failed");
    } finally { if (generation === requestGeneration.current) setBusy(false); }
  }

  const checking = !connectionNeeded && !view && !message;
  const retry = !view || view.state === "unknown" || view.pending;
  const label = t(connectionNeeded ? (connectionNeeded === "reconnect" ? "star.reconnect" : "star.connect")
    : busy || checking ? "star.checking" : retry ? "star.retry" : view.state === "starred" ? "star.remove" : "star.add");
  const displayedStars = stars === null ? null : Math.max(0, stars + (countState ? Number(countState.state === "starred") - Number(countState.initial === "starred") : 0));
  const accessibleLabel = displayedStars === null ? label : t("star.totalLabel", { label, count: formatNumber(displayedStars, locale) });
  const style = `inline-flex min-h-6 items-center gap-1 rounded font-medium outline-offset-4 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-accent-solid disabled:cursor-wait ${view?.state === "starred" ? "text-accent-ink" : "text-fg"}`;
  const count = <><span aria-hidden className={busy || checking ? "animate-pulse" : undefined}>★</span><span>{displayedStars === null ? t("star.label") : formatNumber(displayedStars, locale)}</span></>;
  return <span className="relative inline-flex items-center" data-testid="github-star-control">
    {connectionNeeded ? <a href={loginHref} onClick={(event) => { const current = new URL(window.location.href); if (stripLocale(current.pathname) === `/p/${encodeURIComponent(slug)}`) event.currentTarget.href = localePath(locale, `/login?connectGithub=1&returnTo=${encodeURIComponent(`${current.pathname}${current.search}${current.hash}`)}`); }} aria-label={accessibleLabel} title={label} className={style} {...trackAttrs("github_connect_start", { kind: "star", product_slug: slug })}>{count}</a>
      : <button type="button" aria-label={accessibleLabel} title={message ? t(message) : label} aria-pressed={view?.state === "starred"} aria-busy={busy || !!view?.pending} disabled={busy || checking} onBlur={() => setShowMessage(false)} onClick={() => { setShowMessage(true); void (retry ? refresh() : toggle()); }} className={style}
        {...(retry ? {} : trackAttrs("github_star", { product_slug: slug, action: view.state === "starred" ? "unstar" : "star" }))}>
        {count}
      </button>}
    {message && <span role="status" className={showMessage ? "absolute left-0 top-full z-20 mt-2 w-64 max-w-[80vw] rounded-lg border border-line bg-bg-card p-3 text-[13px] font-normal leading-5 text-fg-2 shadow-lg" : "sr-only"}>{t(message)}</span>}
  </span>;
}
