export type LoginEmail = { challengeId: string; email: string; code: string };
export type EmailDeliveryState = "accepted" | "rejected" | "unknown";
export type LoginEmailDelivery = (email: LoginEmail) => Promise<EmailDeliveryState>;

export function emailLoginConfigured(): boolean {
  return Boolean(process.env.LOGIN_EMAIL_API_KEY?.trim() && process.env.LOGIN_EMAIL_FROM?.trim());
}

/**
 * Resend 에 한 번 보낸다 — 로그인 코드와 알림 메일이 같은 키·보내는 주소·시간 제한·Idempotency-Key 를 쓴다.
 * 응답을 받지 못하면(시간 초과·연결 끊김) null. 상태를 어떻게 읽을지는 부른 쪽이 정한다.
 */
async function postResend(body: Record<string, unknown>, idempotencyKey: string, fetcher: typeof fetch): Promise<Response | null> {
  const key = process.env.LOGIN_EMAIL_API_KEY;
  const from = process.env.LOGIN_EMAIL_FROM;
  if (!key || !from) throw new Error("public_auth_unconfigured");
  try {
    return await fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from, ...body }),
    });
  } catch {
    // Provider errors can contain email addresses, request bodies and credentials.
    return null;
  }
}

/** A timeout/5xx may have sent mail. Never automatically repeat that POST. */
export async function sendLoginEmail(email: LoginEmail, fetcher: typeof fetch = fetch): Promise<EmailDeliveryState> {
  const response = await postResend({
    to: [email.email], subject: "NoMoreVibe 로그인 인증 코드", text: `인증 코드: ${email.code}\n\n10분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시해 주세요.`,
  }, email.challengeId, fetcher);
  if (!response) return "unknown";
  if (response.ok) return "accepted";
  if (response.status >= 400 && response.status < 500) return "rejected";
  return "unknown";
}

export type OutgoingEmail = {
  to: string; subject: string; text: string; html: string;
  /** 같은 열쇠로 24시간 안에 다시 보내면 Resend 가 한 번만 보낸다 — 발송함 행 id 를 쓴다 */
  idempotencyKey: string;
  headers?: Record<string, string>;
};
/** unavailable: 이 메일이 아니라 보내는 쪽(키·도메인·보내는 주소·한도) 탓으로 거절했다 — 보내지 않았고, 고치면 그대로 다시 보낼 수 있다 */
export type OutgoingEmailState = EmailDeliveryState | "unavailable";

/** 401·403·429 말고도 보내는 쪽 설정 탓인 Resend 오류 이름(422) */
const SENDER_ERRORS = new Set(["invalid_from_address", "invalid_access", "invalid_region"]);

async function errorName(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const name = body && typeof body === "object" ? (body as Record<string, unknown>).name : null;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/**
 * 알림 메일 — 로그인 코드와 같은 Resend 키·보내는 주소(LOGIN_EMAIL_*). 발송함(lib/me/email-outbox.ts)이 다시 보낼 수 있게
 * 같은 열쇠의 겹친 요청(409)·5xx·응답 없음은 unknown, 키·도메인·한도 문제(401·403·429·보내는 주소 오류)는 unavailable 로 돌려준다.
 * rejected 는 이 메일 자체를 받지 않은 나머지 4xx 뿐이다 — 키 하나가 잘못돼 발송함 전체가 rejected 로 닫히지 않게.
 */
export async function sendEmail(email: OutgoingEmail, fetcher: typeof fetch = fetch): Promise<OutgoingEmailState> {
  const response = await postResend({
    to: [email.to], subject: email.subject, text: email.text, html: email.html, ...(email.headers ? { headers: email.headers } : {}),
  }, email.idempotencyKey, fetcher);
  if (!response) return "unknown";
  if (response.ok) return "accepted";
  if (response.status === 401 || response.status === 403 || response.status === 429) return "unavailable";
  if (response.status === 409) return "unknown";
  if (response.status >= 400 && response.status < 500) return SENDER_ERRORS.has(await errorName(response)) ? "unavailable" : "rejected";
  return "unknown";
}
