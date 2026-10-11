"use client";

import { useEffect, useState } from "react";

type Connection = { githubUserId: number; login: string; state: "active" | "needs_reconnect" | "revoked" };
const ERRORS: Record<string, string> = {
  github_identity_conflict: "이 GitHub 계정은 다른 NoMoreVibe 계정에 연결되어 있습니다.",
  github_authorization_declined: "GitHub 연결을 취소했습니다. 원할 때 다시 연결할 수 있습니다.",
  invalid_github_flow: "연결 요청이 만료되었거나 로그인 계정이 바뀌었습니다. 다시 연결해 주세요.",
  github_integration_unconfigured: "GitHub 연결을 준비하고 있습니다.",
};

export function GithubConnection({ returnTo = "/" }: { returnTo?: string }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [sessionCsrf, setSessionCsrf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    const failure = new URLSearchParams(window.location.search).get("githubError");
    fetch("/api/me", { cache: "no-store", signal: abort.signal }).then(async (response) => {
      if (failure) setError(ERRORS[failure] ?? "GitHub 연결을 완료하지 못했습니다. 다시 시도해 주세요.");
      if (!response.ok) throw new Error();
      const me = await response.json();
      if (!me.user) return;
      setSessionCsrf(me.csrfToken);
      const current = await fetch("/api/me/github", { cache: "no-store", signal: abort.signal });
      if (current.ok) setConnection((await current.json()).connection);
    }).catch(() => { if (!abort.signal.aborted) setError("연결 상태를 불러오지 못했습니다."); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, []);

  async function connect() {
    if (busy || !consent) return;
    setBusy(true); setError("");
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
      setError(ERRORS[code] ?? "GitHub 연결을 시작하지 못했습니다. 다시 시도해 주세요.");
      setBusy(false);
    }
  }
  async function disconnect() {
    if (busy || !sessionCsrf) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/me/github", { method: "DELETE", headers: { "x-csrf-token": sessionCsrf } });
      if (!response.ok) throw new Error();
      setConnection(connection ? { ...connection, state: "revoked" } : null);
    } catch { setError("연결을 해제하지 못했습니다. 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }
  return (
    <section className="mt-7 border-t border-line pt-6" aria-label="개인 GitHub 연결">
      <h2 className="text-[17px] font-semibold">개인 GitHub 연결</h2>
      <p className="mt-2 text-[14px] leading-6 text-fg-2">본인 GitHub 계정으로 프로젝트에 스타를 추가하거나 취소하려면 연결해 주세요.</p>
      {loading ? <p className="mt-3 text-[14px]" role="status">연결 상태 확인 중…</p> : connection?.state === "active" ? <>
        <p className="mt-3 text-[14px]" role="status">@{connection.login} 연결됨</p>
        <p className="mt-2 text-[14px] text-fg-2">연결을 해제해도 이미 남긴 GitHub 스타는 유지됩니다.</p>
        <button type="button" disabled={busy} onClick={disconnect} className="mt-3 min-h-11 rounded-lg border border-line px-4 text-[14px]">GitHub 연결 해제</button>
      </> : <>
        {connection?.state === "needs_reconnect" && <p className="mt-3 text-[14px]" role="status">권한이 만료되거나 회수되었습니다. 다시 연결해 주세요.</p>}
        <label className="mt-4 flex items-start gap-2 text-[14px] leading-6"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={busy} className="mt-1" />본인 계정의 GitHub 스타 추가·취소 권한을 승인합니다.</label>
        <button type="button" disabled={busy || loading || !consent} onClick={connect} className="mt-4 min-h-11 w-full rounded-lg border border-line px-4 text-[14px] font-semibold disabled:opacity-50">{busy ? "연결 중…" : connection?.state === "needs_reconnect" ? "GitHub 다시 연결" : "GitHub 연결"}</button>
      </>}
      {error && <p role="alert" className="mt-3 text-[14px] text-down">{error}</p>}
    </section>
  );
}
