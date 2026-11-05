import { currentAdmin } from "@/lib/auth/admin";
import { readRequestWorkspaceFeed } from "@/lib/operations/admin-request-workspace-feed";
import { requestFeedFilter } from "@/lib/operations/admin-request-workspace-feed-model";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "Vary": "Cookie" };
export async function GET(request: Request) {
  if (!await currentAdmin()) return Response.json({ error: "unauthorized" }, { status: 401, headers });
  const params = Object.fromEntries(new URL(request.url).searchParams), filter = requestFeedFilter(params);
  try {
    const result = await readRequestWorkspaceFeed(filter, params.cursor);
    if (result.failed.length) return Response.json({ error: "request_feed_unavailable" }, { status: 503, headers });
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error && error.message === "request_feed_cursor_invalid" ? "invalid_cursor" : "request_feed_unavailable" }, { status: error instanceof Error && error.message === "request_feed_cursor_invalid" ? 400 : 503, headers });
  }
}
