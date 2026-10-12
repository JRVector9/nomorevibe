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
