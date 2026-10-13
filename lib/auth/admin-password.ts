import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const ADMIN_LOGIN_COOKIE = "nmv_admin_login";
export const ADMIN_LOGIN_TTL_SECONDS = 10 * 60;
const PASSWORD_HASH = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

export function adminPasswordConfig() {
  const username = process.env.ADMIN_USERNAME?.trim();
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const parts = hash?.match(PASSWORD_HASH);
  if (!username || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(username) || !parts) return null;
  return { username, hash: hash!, salt: parts[1], key: Buffer.from(parts[2], "hex") };
}

/** Fixed work factor; neither a request nor a malformed hash can choose its cost. */
export async function verifyAdminPassword(username: string, password: string): Promise<boolean> {
  const configured = adminPasswordConfig();
  if (!configured || !password || Buffer.byteLength(password) > 1024) return false;
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(configured.salt, "hex"), 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, result) => error ? reject(error) : resolve(result));
  });
  const matches = timingSafeEqual(key, configured.key);
  return matches && username === configured.username;
}

export function newAdminLoginNonce(): string {
  return `${randomBytes(32).toString("base64url")}.${Math.floor(Date.now() / 1000) + ADMIN_LOGIN_TTL_SECONDS}`;
}

/** The form token is bound to the HttpOnly nonce cookie and expires with it. */
export function adminLoginCsrf(nonce: string | undefined): string | null {
  const secret = process.env.AUTH_SECRET;
  const match = nonce?.match(/^[A-Za-z0-9_-]{43}\.([0-9]{10})$/);
  const now = Math.floor(Date.now() / 1000);
  if (!secret || secret.length < 32 || !match || Number(match[1]) <= now || Number(match[1]) > now + ADMIN_LOGIN_TTL_SECONDS) return null;
  return createHmac("sha256", secret).update(`admin-login:${nonce}`).digest("hex");
}

export function matchesAdminLoginCsrf(nonce: string | undefined, token: unknown): boolean {
  const expected = adminLoginCsrf(nonce);
  return !!expected && typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
    && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(token, "hex"));
}

export function adminLoginCookie(headers: Pick<Headers, "get">): string | undefined {
  const values = (headers.get("cookie") ?? "").split(";").map(part => part.trim())
    .filter(part => part.startsWith(`${ADMIN_LOGIN_COOKIE}=`));
  return values.length === 1 ? values[0].slice(ADMIN_LOGIN_COOKIE.length + 1) : undefined;
}
