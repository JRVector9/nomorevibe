export type LoginEmail = { challengeId: string; email: string; code: string };
export type EmailDeliveryState = "accepted" | "rejected" | "unknown";
export type LoginEmailDelivery = (email: LoginEmail) => Promise<EmailDeliveryState>;

export function emailLoginConfigured(): boolean {
  return Boolean(process.env.LOGIN_EMAIL_API_KEY?.trim() && process.env.LOGIN_EMAIL_FROM?.trim());
}

/** A timeout/5xx may have sent mail. Never automatically repeat that POST. */
export async function sendLoginEmail(email: LoginEmail, fetcher: typeof fetch = fetch): Promise<EmailDeliveryState> {
  const key = process.env.LOGIN_EMAIL_API_KEY;
  const from = process.env.LOGIN_EMAIL_FROM;
  if (!key || !from) throw new Error("public_auth_unconfigured");
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": email.challengeId },
      body: JSON.stringify({ from, to: [email.email], subject: "NoMoreVibe 로그인 인증 코드", text: `인증 코드: ${email.code}\n\n10분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.` }),
    });
    if (response.ok) return "accepted";
    if (response.status >= 400 && response.status < 500) return "rejected";
    return "unknown";
  } catch {
    // Provider errors can contain email addresses, request bodies and credentials.
    return "unknown";
  }
}

export type OutgoingEmail = {
  to: string; subject: string; text: string; html: string;
  /** 같은 열쇠로 24시간 안에 다시 보내면 Resend 가 한 번만 보낸다 — 발송함 행 id 를 쓴다 */
  idempotencyKey: string;
  headers?: Record<string, string>;
};

/**
 * 알림 메일 — 로그인 코드와 같은 Resend 키·보내는 주소(LOGIN_EMAIL_*). 발송함(lib/me/email-outbox.ts)이 다시 보낼 수 있게
 * 한도 초과(429)·같은 열쇠의 겹친 요청(409)은 rejected 가 아니라 unknown 으로 돌려준다.
 */
export async function sendEmail(email: OutgoingEmail, fetcher: typeof fetch = fetch): Promise<EmailDeliveryState> {
  const key = process.env.LOGIN_EMAIL_API_KEY;
  const from = process.env.LOGIN_EMAIL_FROM;
  if (!key || !from) throw new Error("public_auth_unconfigured");
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": email.idempotencyKey },
      body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text, html: email.html, ...(email.headers ? { headers: email.headers } : {}) }),
    });
    if (response.ok) return "accepted";
    if (response.status === 429 || response.status === 409) return "unknown";
    if (response.status >= 400 && response.status < 500) return "rejected";
    return "unknown";
  } catch {
    return "unknown";
  }
}
