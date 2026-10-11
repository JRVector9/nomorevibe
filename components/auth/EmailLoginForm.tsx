"use client";

import { useEffect, useState, type FormEvent } from "react";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: "이메일 주소를 확인해 주세요.",
  invalid_code: "코드가 올바르지 않거나 만료되었습니다. 새 코드를 받아 주세요.",
  login_rate_limited: "요청이 많습니다. 잠시 뒤 다시 시도해 주세요.",
  invalid_csrf: "로그인 화면을 새로고침한 뒤 다시 시도해 주세요.",
  email_delivery_failed: "인증 메일을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
  public_auth_unconfigured: "이메일 로그인을 준비하고 있습니다.",
};

export async function bootstrapLoginCsrf(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/auth/user/email/start", { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.csrfToken;
}

export function EmailLoginForm({ returnTo }: { returnTo: string }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    bootstrapLoginCsrf(abort.signal)
      .then(setCsrfToken).catch((failure) => {
        if (!abort.signal.aborted) setError(ERROR_MESSAGES[failure.message] ?? "로그인 화면을 불러오지 못했습니다. 새로고침해 주세요.");
      });
    return () => abort.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !csrfToken) return;
    setBusy(true);
    setError("");
    try {
      const currentCsrf = challengeId ? csrfToken : await bootstrapLoginCsrf();
      if (!challengeId) setCsrfToken(currentCsrf);
      const response = await fetch(`/api/auth/user/email/${challengeId ? "verify" : "start"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": currentCsrf },
        body: JSON.stringify(challengeId ? { challengeId, code } : { email, returnTo }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (challengeId) {
        window.location.assign(result.returnTo);
      } else {
        setChallengeId(result.challengeId);
        setMessage(result.delivery === "unknown" ? "메일 발송 결과를 확인하고 있습니다. 받은 코드가 있으면 입력해 주세요." : "이메일로 보낸 8자리 코드를 10분 안에 입력해 주세요.");
      }
    } catch (failure) {
      const key = failure instanceof Error ? failure.message : "";
      setError(ERROR_MESSAGES[key] ?? "로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  const fieldClass = "mt-2 w-full rounded-lg border border-line bg-bg-card px-3 py-3 text-[15px] text-fg outline-offset-2";
  return (
    <form onSubmit={submit} className="mt-6" aria-busy={busy}>
      <label htmlFor="public-email" className="text-[14px] font-semibold">이메일</label>
      <input id="public-email" type="email" autoComplete="email" maxLength={254} required value={email} disabled={busy || !!challengeId} onChange={(event) => setEmail(event.target.value)} className={fieldClass} />
      {challengeId && <div className="mt-4">
        <label htmlFor="public-email-code" className="text-[14px] font-semibold">인증 코드</label>
        <input id="public-email-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} minLength={8} required value={code} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))} className={fieldClass} />
      </div>}
      {message && <p className="mt-4 text-[14px] leading-6 text-fg-2" role="status">{message}</p>}
      {error && <p className="mt-4 text-[14px] leading-6 text-down" role="alert">{error}</p>}
      <button type="submit" disabled={busy || !csrfToken} className="mt-5 min-h-11 w-full rounded-lg bg-accent-solid px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50">
        {busy ? "처리 중…" : challengeId ? "로그인" : "인증 코드 받기"}
      </button>
      {challengeId && <button type="button" disabled={busy} onClick={() => { setChallengeId(""); setCode(""); setMessage(""); setError(""); }} className="mt-3 min-h-11 w-full text-[14px] text-fg-2">다른 이메일 또는 새 코드 받기</button>}
    </form>
  );
}
