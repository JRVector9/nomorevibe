"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StarView } from "@/lib/domain/github-stars/contract";
import { formatCount } from "@/lib/format/number";

const reconnectErrors = new Set(["login_required", "github_not_connected", "github_needs_reconnect"]);
type ConnectionNeeded = false | "connect" | "reconnect";
type Control = { view?: StarView; csrf?: string; connectionNeeded: ConnectionNeeded; message: string };
export function newerStarView(current: StarView | null, incoming: StarView): StarView {
  return current && current.revision > incoming.revision ? current : incoming;
}
function unknownMessage(view: StarView): string {
  return view.uncertain ? "변경 결과를 확인할 수 없습니다. GitHub에서 스타 상태를 직접 확인해 주세요. 이 변경 잠금은 재조회로 해제되지 않습니다." : "GitHub 스타 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.";
}
async function loadControl(endpoint: string, signal?: AbortSignal): Promise<Control> {
  const meResponse = await fetch("/api/me", { cache: "no-store", signal });
  const me = await meResponse.json();
  if (!meResponse.ok || (me.user && typeof me.csrfToken !== "string")) return { connectionNeeded: false, message: "GitHub 스타 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요." };
  if (!me.user) return { connectionNeeded: "connect", message: "" };
  const response = await fetch(endpoint, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) return { csrf: me.csrfToken, connectionNeeded: result.error === "github_needs_reconnect" ? "reconnect" : reconnectErrors.has(result.error) ? "connect" : false, message: reconnectErrors.has(result.error) ? "" : "GitHub 스타 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요." };
  return { csrf: me.csrfToken, view: result, connectionNeeded: result.state === "needs_reconnect" ? "reconnect" : false, message: result.state === "unknown" ? unknownMessage(result) : "" };
}
export function GithubStarButton({ slug, stars = null }: { slug: string; stars?: number | null }) {
  const [view, setView] = useState<StarView | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [connectionNeeded, setConnectionNeeded] = useState<ConnectionNeeded>(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [showMessage, setShowMessage] = useState(false);
  const [countState, setCountState] = useState<{ initial: StarView["state"]; state: StarView["state"]; revision: number } | null>(null);
  const requestGeneration = useRef(0);
  const endpoint = `/api/products/${encodeURIComponent(slug)}/github-star`;
  const loginHref = `/login?connectGithub=1&returnTo=${encodeURIComponent(`/p/${slug}`)}`;

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
      const message = "GitHub 스타 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.";
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
      if (!controller.signal.aborted && generation === requestGeneration.current) setMessage("GitHub 스타 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.");
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
        else if (response.status === 429) setMessage("GitHub 스타 요청이 제한되었습니다. 잠시 후 다시 시도해 주세요.");
        else if (result.error === "star_write_rejected" && response.status === 403) setMessage("GitHub에서 스타 변경 권한을 거부했습니다. GitHub 앱의 승인 권한을 확인해 주세요.");
        else {
          const refreshed = await refresh();
          if (!refreshed || refreshed.generation !== requestGeneration.current) return;
          generation = refreshed.generation;
          if (!refreshed.message) setMessage("GitHub 스타 변경 결과를 다시 확인해 주세요.");
        }
        return;
      }
      applyControl({ view: result, csrf, connectionNeeded: result.state === "needs_reconnect" ? "reconnect" : false, message: "" });
      if (result.state === "unknown") setMessage(unknownMessage(result));
      else if (result.retryAt) setMessage("GitHub 스타 요청이 제한되었습니다. 잠시 후 다시 시도해 주세요.");
      else if (result.state !== (starred ? "starred" : "unstarred") && result.state !== "needs_reconnect") setMessage("GitHub가 스타 변경을 확인하지 못했습니다. 다시 확인해 주세요.");
    } catch {
      if (generation !== requestGeneration.current) return;
      // A failed browser response can still follow a successful server write.
      setView((current) => current ? { ...current, state: "unknown", pending: false } : current);
      setMessage("변경 결과를 확인할 수 없습니다. 상태를 다시 확인해 주세요.");
    } finally { if (generation === requestGeneration.current) setBusy(false); }
  }

  const checking = !connectionNeeded && !view && !message;
  const retry = !view || view.state === "unknown" || view.pending;
  const label = connectionNeeded ? (connectionNeeded === "reconnect" ? "GitHub 재연결 후 스타" : "GitHub 연결 후 스타")
    : busy || checking ? "GitHub 스타 확인 중…" : retry ? "스타 상태 다시 확인" : view.state === "starred" ? "GitHub 스타 취소" : "GitHub 스타";
  const displayedStars = stars === null ? null : Math.max(0, stars + (countState ? Number(countState.state === "starred") - Number(countState.initial === "starred") : 0));
  const accessibleLabel = displayedStars === null ? label : `${label}, 전체 스타 ${formatCount(displayedStars)}개`;
  const style = `inline-flex min-h-6 items-center gap-1 rounded font-medium outline-offset-4 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-accent-solid disabled:cursor-wait ${view?.state === "starred" ? "text-accent-ink" : "text-fg"}`;
  const count = <><span aria-hidden className={busy || checking ? "animate-pulse" : undefined}>★</span><span>{displayedStars === null ? "스타" : formatCount(displayedStars)}</span></>;
  return <span className="relative inline-flex items-center" data-testid="github-star-control">
    {connectionNeeded ? <a href={loginHref} aria-label={accessibleLabel} title={label} className={style}>{count}</a>
      : <button type="button" aria-label={accessibleLabel} title={message || label} aria-pressed={view?.state === "starred"} aria-busy={busy || !!view?.pending} disabled={busy || checking} onBlur={() => setShowMessage(false)} onClick={() => { setShowMessage(true); void (retry ? refresh() : toggle()); }} className={style}>
        {count}
      </button>}
    {message && <span role="status" className={showMessage ? "absolute left-0 top-full z-20 mt-2 w-64 max-w-[80vw] rounded-lg border border-line bg-bg-card p-3 text-[13px] font-normal leading-5 text-fg-2 shadow-lg" : "sr-only"}>{message}</span>}
  </span>;
}
