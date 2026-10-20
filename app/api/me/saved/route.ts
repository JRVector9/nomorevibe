import { getPublicSession, PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { listSaved, SAVED_FILTERS, SAVED_SORTS, savedSlugs } from "@/lib/me/saved";

/** 값이 없으면 기본, 모르는 값이면 400 */
function choice<T extends string>(value: string | null, choices: readonly T[], fallback: T): T {
  if (value === null || value === "") return fallback;
  if (!(choices as readonly string[]).includes(value)) throw new PublicAuthError(400, "invalid_request");
  return value as T;
}

/** 내 저장 목록 — 정렬·거르기·분야·커서. view=slugs 는 브라우저가 제 목록과 맞춰 볼 주소 전부 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    const params = new URL(request.url).searchParams;
    if (params.get("view") === "slugs") return Response.json({ slugs: await savedSlugs(session.user.id) }, { headers: PUBLIC_PRIVATE_HEADERS });
    const category = params.get("category") || null;
    if (category && category.length > 40) throw new PublicAuthError(400, "invalid_request");
    const locale = params.get("locale");
    const page = await listSaved(session.user.id, {
      sort: choice(params.get("sort"), SAVED_SORTS, "recent"),
      filter: choice(params.get("filter"), SAVED_FILTERS, "all"),
      category,
      cursor: params.get("cursor") || null,
    }, isLocale(locale) ? locale : DEFAULT_LOCALE);
    return Response.json(page, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
