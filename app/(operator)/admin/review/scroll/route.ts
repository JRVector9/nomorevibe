import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { listAdminReviewEntries, reviewQueueCauses } from "@/lib/crawl/admin-review";
import { decodeReviewCursor, encodeReviewCursor } from "@/lib/crawl/admin-review-cursor";
import { getSettings } from "@/lib/crawl/settings";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { readDelegateGroups } from "@/lib/crawl/delegate-groups-read";
import { prototypeReviewFilter, prototypeReviewNeeds, prototypeReviewOptions } from "../PrototypeReviewQuery";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  if (!await currentAdmin()) return NextResponse.json({ error: "다시 로그인한 뒤 목록을 확인하세요." }, { status: 403, headers });
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const filter = prototypeReviewFilter(params);
  let cursor;
  try {
    if (filter.second === "published") throw new Error("review_cursor_invalid");
    cursor = decodeReviewCursor(params.cursor ?? "", filter);
  } catch { return NextResponse.json({ error: "목록 조건이 바뀌었습니다. 새로고침해 다시 확인하세요." }, { status: 400, headers }); }
  try {
    const settings = await getSettings(), needs = prototypeReviewNeeds(filter);
    const [causes, overview, delegateGroups] = await Promise.all([needs.causes ? reviewQueueCauses(settings) : null,
      needs.overview ? humanQueueOverview(settings) : null, needs.delegate ? readDelegateGroups(settings) : null]);
    const options = prototypeReviewOptions(filter, causes, overview, delegateGroups);
    const page = await listAdminReviewEntries(settings, { ...options, cursor, limit: 30 });
    return NextResponse.json({ entries: page.entries, nextCursor: encodeReviewCursor(page.nextCursor, filter), observedAt: Date.now() }, { headers });
  } catch { return NextResponse.json({ error: "다음 목록을 읽지 못했습니다. 다시 시도하세요." }, { status: 503, headers }); }
}
