"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StarView } from "@/lib/domain/github-stars/contract";

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
  if (!meResponse.ok || !me.user || typeof me.csrfToken !== "string") return { connectionNeeded: "connect", message: "" };
  const response = await fetch(endpoint, { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) return { csrf: me.csrfToken, connectionNeeded: result.error === "github_needs_reconnect" ? "reconnect" : reconnectErrors.has(result.error) ? "connect" : false, message: reconnectErrors.has(result.error) ? "" : "GitHub 스타 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요." };
  return { csrf: me.csrfToken, view: result, connectionNeeded: result.state === "needs_reconnect" ? "reconnect" : false, message: result.state === "unknown" ? unknownMessage(result) : "" };
}
export function GithubStarButton({ slug }: { slug: string }) {
  const [view, setView] = useState<StarView | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  const [connectionNeeded, setConnectionNeeded] = useState<ConnectionNeeded>(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const requestGeneration = useRef(0);
  const endpoint = `/api/products/${encodeURIComponent(slug)}/github-star`;
  const loginHref = `/login?connectGithub=1&returnTo=${encodeURIComponent(`/p/${slug}`)}`;

  const applyControl = useCallback((result: Control) => {
    setCsrf(result.csrf ?? null); setView((current) => result.view ? newerStarView(current, result.view) : null);
    setConnectionNeeded(result.connectionNeeded); setMessage(result.message);
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
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
    }
  }, [endpoint, applyControl]);

  useEffect(() => {
    const controller = new AbortController();
    const generationState = requestGeneration;
    const generation = ++generationState.current;
    void loadControl(endpoint, controller.signal).then((result) => {
      if (!controller.signal.aborted && generation === requestGeneration.current) applyControl(result);
    }).catch(() => {
      if (!controller.signal.aborted && generation === requestGeneration.current) setMessage("GitHub 스타 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요.");
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
        else {
          const refreshed = await refresh();
          if (!refreshed || refreshed.generation !== requestGeneration.current) return;
          generation = refreshed.generation;
          if (!refreshed.message) setMessage("GitHub 스타 변경 결과를 다시 확인해 주세요.");
        }
        return;
      }
      setView((current) => newerStarView(current, result)); setConnectionNeeded(result.state === "needs_reconnect" ? "reconnect" : false);
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

  const pending = busy || view?.pending;
  const uncertain = !view || view.state === "unknown";
  return <div className="flex flex-col items-start gap-2" data-testid="github-star-control">
    {connectionNeeded ? <a href={loginHref} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-medium">{connectionNeeded === "reconnect" ? "GitHub 재연결 후 스타" : "GitHub 연결 후 스타"}</a>
      : <button type="button" aria-pressed={view?.state === "starred"} disabled={!!pending || uncertain} onClick={() => void toggle()} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-sm font-medium disabled:opacity-60">
        {pending ? "GitHub 스타 처리 중…" : view?.state === "starred" ? "GitHub 스타 취소" : view?.state === "unstarred" ? "GitHub 스타" : view?.state === "unknown" ? "GitHub 스타 확인 불가" : "GitHub 스타 확인 중…"}
      </button>}
    {!connectionNeeded && (uncertain || view?.pending || message) && <button type="button" disabled={busy} onClick={() => void refresh()} className="text-sm text-fg-muted underline underline-offset-4">스타 상태 다시 확인</button>}
    {message && <p role="status" className="max-w-sm text-sm text-fg-muted">{message}</p>}
  </div>;
}
