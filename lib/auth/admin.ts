import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession, type Session } from "./session";

/**
 * 어드민 자격.
 *
 * GitHub OAuth로 "이 사람이 누구인지"는 알 수 있지만, "어드민인지"는 우리가 정해야 한다.
 * 허용목록을 환경변수로 둔다 — 계정을 추가하려면 배포가 필요하지만, 그게 이 규모에서는
 * DB에 권한 테이블을 두는 것보다 안전하다.
 *
 * 로컬에서 GitHub 앱을 만들기 전에 화면을 보려면 ADMIN_LOCAL_LOGIN=1 로 연다.
 * 운영에는 넣지 않는다.
 */

export const LOCAL_ADMIN_LOGIN = "local";

export function adminLocalLoginEnabled(): boolean {
  return process.env.ADMIN_LOCAL_LOGIN === "1";
}

/** 설정이 비어 있으면 아무도 어드민이 아니다 — 실수로 열려 있는 것보다 낫다 */
export function adminLogins(): string[] {
  return (process.env.ADMIN_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** GitHub 로그인명은 대소문자를 구분하지 않는다 */
export function isAdminLogin(login: string): boolean {
  const normalized = login.trim().toLowerCase();
  if (adminLocalLoginEnabled() && normalized === LOCAL_ADMIN_LOGIN) return true;
  const allowed = adminLogins();
  return allowed.length > 0 && allowed.includes(normalized);
}

/**
 * 로컬 로그인의 운영자 이름(2026-10-08 UX 감사 ADM-21).
 *
 * 로컬 로그인은 모두 'local' 이라 작업 로그로 누가 했는지 알 수 없다. 진짜 로그인(Cloudflare Access·GitHub)을 붙이기
 * 전까지 각자 자기 이름을 적어 두면 작업 로그의 처리자로 남긴다(처리 방식은 그대로 'local'). 본인이 적은 이름이라
 * 신원 확인은 아니다. 로컬 로그인에는 세션 쿠키가 없어 이 쿠키 하나에 이름만 둔다.
 */
export const OPERATOR_COOKIE = "nmv_operator";
export const OPERATOR_NAME_MAX = 40;

/** 이름 다듬기 — 제어 문자를 빼고 공백을 하나로 모아 40자까지. 비면 null */
export function normalizeOperatorName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, OPERATOR_NAME_MAX).trim();
  return name || null;
}

/** 이 요청의 로컬 운영자 이름. 로컬 로그인이 아니거나 적지 않았으면 null */
export async function localOperatorName(): Promise<string | null> {
  if (!adminLocalLoginEnabled()) return null;
  return normalizeOperatorName((await cookies()).get(OPERATOR_COOKIE)?.value);
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
  if (adminLocalLoginEnabled()) {
    return { login: LOCAL_ADMIN_LOGIN, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60 };
  }

  const secret = authSecret();
  if (!secret) return null;

  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(cookie, secret);
  if (!session) return null;

  // 쿠키를 발급한 뒤 허용목록에서 빠졌을 수 있다. 매 요청 다시 확인한다.
  return isAdminLogin(session.login) ? session : null;
}
