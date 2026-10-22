"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "@/lib/i18n/context";
import type { MessageKey } from "@/lib/i18n/messages";
import { trackAttrs } from "@/lib/analytics/attrs";
import { track } from "@/lib/analytics/client";

type ErrorKey = Extract<MessageKey<"auth">, `error.${string}`>;
const ERROR_MESSAGES: Record<string, ErrorKey> = {
  invalid_email: "error.invalidEmail",
  invalid_code: "error.invalidCode",
  login_rate_limited: "error.rateLimited",
  invalid_csrf: "error.invalidCsrf",
  email_delivery_failed: "error.emailDelivery",
  public_auth_unconfigured: "error.emailUnconfigured",
};

export async function bootstrapLoginCsrf(signal?: AbortSignal): Promise<string> {
  const response = await fetch("/api/auth/user/email/start", { cache: "no-store", signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.csrfToken;
}

export function EmailLoginForm({ returnTo }: { returnTo: string }) {
  const t = useTranslations("auth");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"email.deliveryUnknown" | "email.codeSent" | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    bootstrapLoginCsrf(abort.signal)
      .then(setCsrfToken).catch((failure) => {
        if (!abort.signal.aborted) setError(ERROR_MESSAGES[failure.message] ?? "error.loginLoad");
      });
    return () => abort.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !csrfToken) return;
    setBusy(true);
    setError(null);
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
        // 수단만 보낸다(beacon 이라 바로 옮겨 가도 잃지 않는다). 처음 가입인지는 서버가 안다
        track("login", { method: "email" });
        window.location.assign(result.returnTo);
      } else {
        setChallengeId(result.challengeId);
        setMessage(result.delivery === "unknown" ? "email.deliveryUnknown" : "email.codeSent");
      }
    } catch (failure) {
      const key = failure instanceof Error ? failure.message : "";
      setError(ERROR_MESSAGES[key] ?? "error.loginFailed");
    } finally {
      setBusy(false);
    }
  }

  const fieldClass = "mt-2 w-full rounded-lg border border-line bg-bg-card px-3 py-3 text-[15px] text-fg outline-offset-2";
  return (
    <form onSubmit={submit} className="mt-6" aria-busy={busy}>
      <label htmlFor="public-email" className="text-[14px] font-semibold">{t("email.label")}</label>
      <input id="public-email" type="email" autoComplete="email" maxLength={254} required value={email} disabled={busy || !!challengeId} onChange={(event) => setEmail(event.target.value)} className={fieldClass} />
      {challengeId && <div className="mt-4">
        <label htmlFor="public-email-code" className="text-[14px] font-semibold">{t("email.codeLabel")}</label>
        <input id="public-email-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{8}" maxLength={8} minLength={8} required value={code} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))} className={fieldClass} />
      </div>}
      {message && <p className="mt-4 text-[14px] leading-6 text-fg-2" role="status">{t(message)}</p>}
      {error && <p className="mt-4 text-[14px] leading-6 text-down" role="alert">{t(error)}</p>}
      <button type="submit" disabled={busy || !csrfToken} {...(challengeId ? {} : trackAttrs("login_start", { method: "email", surface: "login" }))} className="mt-5 min-h-11 w-full rounded-lg bg-accent-solid px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-50">
        {busy ? t("email.busy") : challengeId ? t("email.submit") : t("email.sendCode")}
      </button>
      {challengeId && <button type="button" disabled={busy} onClick={() => { setChallengeId(""); setCode(""); setMessage(null); setError(null); }} className="mt-3 min-h-11 w-full text-[14px] text-fg-2">{t("email.restart")}</button>}
    </form>
  );
}
