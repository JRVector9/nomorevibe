/**
 * 서명 쿠키 세션.
 *
 * next-auth를 쓰지 않는다 — 어드민 로그인 하나에 비해 너무 크다. 필요한 것은
 * "이 쿠키를 우리가 발급했다"는 보장뿐이고, HMAC 하나로 충분하다.
 *
 * Web Crypto만 쓰므로 middleware(edge)와 라우트 핸들러(node) 양쪽에서 동작한다.
 * node:crypto를 쓰면 middleware에서 못 쓴다.
 */

export const SESSION_COOKIE = "nmv_admin";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12시간

export type Session = { login: string; exp: number };

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Buffer의 backing store가 SharedArrayBuffer일 수 있어 Web Crypto가 받는 형태로 복사한다 */
function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(value, "base64url");
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 서명된 세션 쿠키 값을 만든다 */
export async function signSession(login: string, secret: string, nowSeconds?: number): Promise<string> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: Session = { login, exp: now + SESSION_TTL_SECONDS };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), body);
  return `${b64urlEncode(body)}.${b64urlEncode(new Uint8Array(signature))}`;
}

/**
 * 쿠키 값을 검증해 세션을 돌려준다. 위조·만료면 null.
 * 서명 비교는 crypto.subtle.verify에 맡긴다 — 직접 문자열 비교하면 타이밍 정보가 샌다.
 */
export async function verifySession(
  value: string | undefined,
  secret: string,
  nowSeconds?: number,
): Promise<Session | null> {
  if (!value) return null;
  const [bodyPart, signaturePart] = value.split(".");
  if (!bodyPart || !signaturePart) return null;

  let body: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    body = b64urlDecode(bodyPart);
    signature = b64urlDecode(signaturePart);
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), signature, body);
  if (!valid) return null;

  let session: Session;
  try {
    session = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  if (typeof session.login !== "string" || typeof session.exp !== "number") return null;

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (session.exp <= now) return null;

  return session;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};
