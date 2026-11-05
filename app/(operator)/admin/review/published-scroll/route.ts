import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { decodePublishedReviewCursor } from "@/lib/crawl/published-review-cursor";
import { readPublishedReviewPage } from "@/lib/crawl/published-review-page";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  if (!await currentAdmin()) return NextResponse.json({ error: "다시 로그인한 뒤 목록을 확인하세요." }, { status: 403, headers });
  const params = new URL(request.url).searchParams;
  let after;
  try {
    if (params.getAll("cursor").length !== 1 || [...params.keys()].some(key => key !== "cursor" && key !== "q")) throw new Error("published_review_cursor_invalid");
    if (params.getAll("q").length > 1 || (params.get("q")?.length ?? 0) > 100) throw new Error("published_review_cursor_invalid");
    after = decodePublishedReviewCursor(params.get("cursor") ?? "", params.get("q") ?? "");
  } catch { return NextResponse.json({ error: "목록 조건을 확인하지 못했습니다. 새로고침해 다시 확인하세요." }, { status: 400, headers }); }
  try {
    const page = await readPublishedReviewPage(after, params.get("q") ?? "");
    return NextResponse.json({ rows: page.rows, nextCursor: page.nextCursor }, { headers });
  } catch { return NextResponse.json({ error: "다음 공개분을 읽지 못했습니다. 다시 시도하세요." }, { status: 503, headers }); }
}
