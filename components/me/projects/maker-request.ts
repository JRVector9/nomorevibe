export type MakerResponse<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string };

/** 내 프로젝트 탭의 쓰기 요청 — 세션의 CSRF 토큰을 붙인다. 실패는 서버 오류 코드로 */
export async function makerRequest<T>(path: string, method: "POST" | "PUT", csrfToken: string, body: unknown): Promise<MakerResponse<T>> {
  try {
    const response = await fetch(path, { method, cache: "no-store", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null) as { error?: unknown } | null;
    if (response.ok) return { ok: true, status: response.status, data: data as T };
    return { ok: false, status: response.status, code: typeof data?.error === "string" ? data.error : "generic" };
  } catch {
    return { ok: false, status: 0, code: "generic" };
  }
}

const OWN_ERRORS = ["github_login_required", "invalid_repo_url", "repo_not_listed", "rate_limited", "not_a_member", "target_not_found", "reply_too_many_links"] as const;

type ErrorKey = `projects.error.${(typeof OWN_ERRORS)[number] | "session" | "invalid" | "generic"}`;

/** 오류 코드 → 문구 열쇠 */
export function makerErrorKey(code: string): ErrorKey {
  if ((OWN_ERRORS as readonly string[]).includes(code)) return `projects.error.${code as (typeof OWN_ERRORS)[number]}`;
  if (code === "login_required" || code === "invalid_csrf" || code === "invalid_origin") return "projects.error.session";
  if (code === "reply_invalid" || code === "intro_invalid" || code === "invalid_request" || code === "request_too_large") return "projects.error.invalid";
  return "projects.error.generic";
}
