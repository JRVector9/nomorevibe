"use client";

import { useState } from "react";

type BindingView = { repositoryFullName: string; repositoryUrl: string; enabled: boolean; revision: number; blockedReason: string | null };
const ERROR: Record<string, string> = {
  login_required: "로그인한 뒤 다시 시도해 주세요.", invalid_csrf: "로그인 상태를 다시 확인해 주세요.",
  maker_edit_token_required: "제품 수정 키를 입력해 주세요.", maker_edit_token_invalid: "이 제품의 수정 키를 확인해 주세요.",
  github_feedback_consent_required: "GitHub 공개 이슈 수신에 동의해 주세요.",
  github_repository_invalid: "제품에 공개 GitHub 저장소를 먼저 등록해 주세요.",
  github_repository_unavailable: "현재 제품의 GitHub 저장소를 확인할 수 없습니다.",
  github_repository_private: "공개 저장소만 연결할 수 있습니다.", github_repository_archived: "보관된 저장소는 연결할 수 없습니다.",
  github_repository_issues_disabled: "저장소에서 Issues를 활성화한 뒤 다시 연결해 주세요.",
  github_binding_revision_conflict: "설정이 변경되었습니다. 설정을 다시 불러와 주세요.",
  github_maker_authorization_changed: "제품 저장소나 수정 키가 변경되었습니다. 다시 연결해 주세요.",
  github_feedback_disabled: "현재 GitHub 연결 설정을 사용할 수 없습니다.",
};

export function GithubIntegrationSettings({ slug, csrfToken, installationPending = false }: { slug: string; csrfToken: string; installationPending?: boolean }) {
  const [editToken, setEditToken] = useState("");
  const [consent, setConsent] = useState(false);
  const [binding, setBinding] = useState<BindingView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    catch (failure) { setError(ERROR[failure instanceof Error ? failure.message : ""] ?? "설정을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."); }
    finally { setPending(false); }
  }
  function load(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(async () => {
      const value = await request(settingsUrl, "GET");
      setBinding(value.binding); setLoaded(true);
      setMessage(value.binding ? "현재 연결 정보를 불러왔습니다." : "아직 GitHub 저장소가 연결되지 않았습니다.");
    });
  }
  function connect() {
    void act(async () => {
      if (!consent) throw new Error("github_feedback_consent_required");
      const value = await request("/api/auth/maker/github", "POST", { slug, deliveryConsent: true });
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
      setBinding(value.binding); setMessage("GitHub 이슈 수신을 중지했습니다.");
    });
  }

  return <section className="mt-6 space-y-5">
    {installationPending && <p role="status" className="rounded-lg border border-line p-4 text-[14px] leading-6">조직 관리자에게 GitHub App 설치 승인을 요청했습니다. 아직 이슈 수신은 활성화되지 않았습니다. 승인 후 제품 수정 키를 입력하고 GitHub에 다시 연결해 주세요.</p>}
    <p className="text-[14px] leading-6 text-fg-2">제품 수정 키와 GitHub 저장소 관리 권한을 확인한 뒤 연결합니다. GitHub에서 이 제품의 저장소만 선택해 설치해 주세요.</p>
    <fieldset disabled={pending} className="space-y-5">
      <form onSubmit={load} className="space-y-3">
        <label className="block text-[14px]">제품 수정 키<input type="password" autoComplete="off" required maxLength={512} value={editToken} onChange={event => setEditToken(event.target.value)} className="mt-1 w-full rounded-lg border border-line bg-bg-card p-3 text-fg" /></label>
        <p className="text-[13px] text-fg-2">수정 키는 이 화면을 열어 둔 동안만 사용합니다. 연결 후에는 다시 입력해 주세요.</p>
        <button type="submit" className="min-h-11 rounded-full border border-line px-5 text-[14px]">설정 불러오기</button>
      </form>
      {loaded && binding && <div className="rounded-lg border border-line p-4 text-[14px] leading-6">
        <a href={binding.repositoryUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{binding.repositoryFullName}</a>
        <p>{binding.enabled ? "GitHub 이슈 수신이 활성화되어 있습니다." : "GitHub 이슈 수신이 중지되어 있습니다. 다시 사용하려면 연결 절차를 완료해 주세요."}</p>
        {binding.enabled && <button type="button" onClick={disable} className="mt-3 min-h-11 rounded-full border border-line px-5">이슈 수신 중지</button>}
      </div>}
      <label className="flex items-start gap-3 text-[14px] leading-6"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} className="mt-1" />작성자가 전송에 동의한 피드백을 앱 봇의 공개 이슈로 받겠습니다. 이슈에는 작성자 닉네임, 내용과 원문 링크가 포함됩니다.</label>
      <button type="button" disabled={!consent || !editToken} onClick={connect} className="min-h-11 rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white disabled:opacity-50">{pending ? "확인 중…" : binding ? "GitHub 다시 연결" : "GitHub 연결하고 이슈 수신"}</button>
    </fieldset>
    {message && <p role="status" className="text-[14px] leading-6">{message}</p>}
    {error && <p role="alert" className="text-[14px] leading-6">{error}</p>}
  </section>;
}
