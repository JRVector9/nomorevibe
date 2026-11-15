import { onPrimary } from "@/lib/db";
import { rateLimitWindow } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";
import { publicApiMode } from "./control";
import { readSession, sessionConfig, SESSION_HEADERS, type SessionRequest } from "./session";

const WINDOW = 10 * 60_000;
/** All callers already passed the UA, cross-site and IP gates. Search-bot exemptions do not bypass sessions. */
export async function guardApiSession(request: SessionRequest, route: string): Promise<Response | null> {
  const config = sessionConfig();
  if (!config) return null;
  let mode;
  try { mode = await publicApiMode(); }
  catch { return Response.json({ error: "session_control_unavailable" }, { status: 503, headers: SESSION_HEADERS }); }
  const session = readSession(request, config.signingSecret);
  if (!session) {
    logger.info("anti_scrape.session_required", { route, mode });
    return mode === "observe" ? null : Response.json({ error: "api_session_required" }, { status: 401, headers: SESSION_HEADERS });
  }
  const cards = route === "products.cards" || route === "products.summaries";
  // Reserve the largest possible response for unknown list sizes; slugs= batches pay for each distinct slug (at most 60).
  const slugs = request.url ? new URL(request.url).searchParams.get("slugs") : null;
  const cost = route === "products.summaries" ? 100 : cards ? (slugs ? Math.max(1, Math.min(60, new Set(slugs.split(",").filter(Boolean)).size)) : 60) : 1;
  const limit = cards ? 600 : 60;
  try {
    const result = await onPrimary(() => rateLimitWindow(`api-session:${cards ? "cards" : "detail"}:${session.id}`, limit, WINDOW, cost));
    if (result.allowed) return null;
    logger.info("anti_scrape.session_limited", { route, mode, limit });
    return mode === "observe" ? null : Response.json({ error: "api_session_limited" }, { status: 429,
      headers: { ...SESSION_HEADERS, "Retry-After": String(result.retryAfterSeconds) } });
  } catch {
    logger.warn("anti_scrape.session_limit_unavailable", { route, mode });
    return mode === "observe" ? null : Response.json({ error: "session_limit_unavailable" }, { status: 503, headers: SESSION_HEADERS });
  }
}
