import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { withRoute } from "@/lib/http/handler";
import { readModelPickerAvailability } from "@/lib/operations/model-picker-availability-read";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store" };

/** Existing ledger observations only: no engine calls, credentials or configuration writes. */
export const GET = withRoute("admin.model_picker_availability", async () => {
  if (!await currentAdmin()) return NextResponse.json({ ok: false, error: "관리자 로그인이 필요합니다." }, { status: 403, headers });
  try { return NextResponse.json({ ok: true, availability: await readModelPickerAvailability() }, { headers }); }
  catch { return NextResponse.json({ ok: false, error: "실시간 슬롯 상태를 읽지 못했습니다." }, { status: 503, headers }); }
});
