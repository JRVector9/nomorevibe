import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { withRoute } from "@/lib/http/handler";
import { admissionHeadline } from "@/lib/operations/admission-headline";
import { readAdmissionStatus } from "@/lib/operations/admission-status";
import { navBadges } from "../badges";

/**
 * 메뉴 배지 — GET /admin/nav-badges. 공유 레이아웃은 화면을 옮길 때(<Link>) 다시 그려지지 않아 배지가 첫 화면의 수로 남았다.
 * AdminShell 이 화면을 옮길 때마다 이것을 부른다. 읽기만, 관리자만(화면과 같은 currentAdmin). unknown 은 이번에 셀 수 없었던 칸.
 * admission — 머리줄의 접수 표시(운영 콘솔 조각 4b). 서버에서 글자까지 만들어 보낸다(브라우저 묶음에 할 일 규칙 모듈을 싣지 않게). 못 읽으면 「셀 수 없음」.
 */
export const dynamic = "force-dynamic";

export const GET = withRoute("admin.nav_badges", async () => {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: "권한이 없습니다. 다시 로그인해주세요." }, { status: 403, headers: { "cache-control": "no-store" } });
  // 접수 읽기가 어떻게 실패해도(던짐 포함) 배지는 그대로 준다
  const [badges, admission] = await Promise.all([navBadges(), Promise.resolve().then(() => readAdmissionStatus()).catch(() => null)]);
  return NextResponse.json({ ...badges, admission: admissionHeadline(admission, Date.now()), at: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } });
});
