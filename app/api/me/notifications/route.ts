import { getPublicSession, PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { loadInbox } from "@/lib/me/inbox";

/** 알림함 — 최근 것부터 한 쪽. ?cursor= 는 앞 쪽 마지막 id, ?limit= 는 1~50(종은 5), ?locale= 의 말로 한 줄을 지어 보낸다 */
export async function GET(request: Request) {
  try {
    requirePublicAuthEnabled();
    const session = await getPublicSession(request);
    if (!session) throw new PublicAuthError(401, "login_required");
    const params = new URL(request.url).searchParams;
    const cursor = params.get("cursor"), limit = params.get("limit"), locale = params.get("locale");
    if ((cursor !== null && !/^[1-9][0-9]{0,14}$/.test(cursor)) || (limit !== null && !/^[1-9][0-9]?$/.test(limit))) throw new PublicAuthError(400, "invalid_request");
    const inbox = await loadInbox(session.user.id, isLocale(locale) ? locale : DEFAULT_LOCALE,
      { before: cursor ? Number(cursor) : undefined, limit: limit ? Number(limit) : undefined });
    return Response.json(inbox, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}
