import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import { readModelCapacityReviewQueue } from "@/lib/operations/model-capacity-unknowns";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** A bounded primary read only when the operator opens the review drawer. */
export async function GET(request: Request) {
  if (!await currentAdmin()) return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 403, headers });
  const params = new URL(request.url).searchParams;
  const task = params.get("task"), model = params.get("model");
  const definition = task ? AI_TASKS.find(value => value.id === task) : null;
  if ((task !== null && !definition?.routeId) || (model !== null && (!model || model.length > 200))) {
    return NextResponse.json({ error: "검토 조건이 올바르지 않습니다." }, { status: 400, headers });
  }
  try {
    const queue = await readModelCapacityReviewQueue();
    if (queue.error) throw new Error("review_unavailable");
    return NextResponse.json({ queue: { ...queue, items: queue.items.filter(item =>
      (!definition || item.routeId === definition.routeId) && (model === null || item.model === model)) }, observedAt: new Date().toISOString() }, { headers });
  } catch { return NextResponse.json({ error: "미확정 기록을 읽지 못했습니다. 다시 시도하세요." }, { status: 503, headers }); }
}
