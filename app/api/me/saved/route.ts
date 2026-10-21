import { getPublicSession, PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { onPrimary } from "@/lib/db";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { SAVED_LIMIT } from "@/lib/me/contract";
import { listSaved, MERGE_BODY_BYTES, mergeSaved, readSavedJson, readSlugList, SAVED_FILTERS, SAVED_SORTS, savedSlugs } from "@/lib/me/saved";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { rateLimit } from "@/lib/rate-limit";

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

/**
 * 첫 로그인 합치기(L4) — 이 브라우저 저장 목록을 계정으로. 두 번 보내도 한 번만 들어간다.
 * 목록 주소에 둔다 — /api/me/saved/<이름> 은 모두 제품 주소(slug)라, 거기 고정 이름을 두면 같은 이름의 제품을 넣고 빼지 못한다
 */
export const POST = webWriteRoute(async (request: Request): Promise<Response> => {
  try {
    const user = await requirePublicMutation(request);
    if (!await onPrimary(() => rateLimit(`me-saved-merge:${user.id}`, 10, 60 * 60_000))) throw new PublicAuthError(429, "saved_rate_limited");
    const slugs = readSlugList(await readSavedJson(request, MERGE_BODY_BYTES), SAVED_LIMIT);
    return Response.json(await mergeSaved(user.id, slugs), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
