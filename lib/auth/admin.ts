import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession, type Session } from "./session";

/**
 * 어드민 자격.
 *
 * GitHub OAuth로 "이 사람이 누구인지"는 알 수 있지만, "어드민인지"는 우리가 정해야 한다.
 * 허용목록을 환경변수로 둔다 — 계정을 추가하려면 배포가 필요하지만, 그게 이 규모에서는
 * DB에 권한 테이블을 두는 것보다 안전하다.
 */

/** 설정이 비어 있으면 아무도 어드민이 아니다 — 실수로 열려 있는 것보다 낫다 */
export function adminLogins(): string[] {
  return (process.env.ADMIN_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** GitHub 로그인명은 대소문자를 구분하지 않는다 */
export function isAdminLogin(login: string): boolean {
  const allowed = adminLogins();
  return allowed.length > 0 && allowed.includes(login.trim().toLowerCase());
}

export function authSecret(): string | null {
  const secret = process.env.AUTH_SECRET;
  // 짧은 비밀키는 서명의 의미를 없앤다
  return secret && secret.length >= 32 ? secret : null;
}

/**
 * 현재 요청의 어드민 세션. 없으면 null.
 * 화면과 서버 액션이 이걸로 자격을 확인한다.
 */
export async function currentAdmin(): Promise<Session | null> {
  const secret = authSecret();
  if (!secret) return null;

  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(cookie, secret);
  if (!session) return null;

  // 쿠키를 발급한 뒤 허용목록에서 빠졌을 수 있다. 매 요청 다시 확인한다.
  return isAdminLogin(session.login) ? session : null;
}
