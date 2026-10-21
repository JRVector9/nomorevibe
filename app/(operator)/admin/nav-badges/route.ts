import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { withRoute } from "@/lib/http/handler";
import { navBadges } from "../badges";

/**
 * 메뉴 배지 — GET /admin/nav-badges. 공유 레이아웃은 화면을 옮길 때(<Link>) 다시 그려지지 않아 배지가 첫 화면의 수로 남았다.
 * AdminShell 이 화면을 옮길 때마다 이것을 부른다. 읽기만, 관리자만(화면과 같은 currentAdmin). at 은 이 수를 센 서버 시각.
 */
export const dynamic = "force-dynamic";

export const GET = withRoute("admin.nav_badges", async () => {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: "권한이 없습니다. 다시 로그인해주세요." }, { status: 403, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ badges: await navBadges(), at: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
});
