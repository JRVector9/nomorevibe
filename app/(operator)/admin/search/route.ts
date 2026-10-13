import { NextResponse } from "next/server";
import { currentAdmin } from "@/lib/auth/admin";
import { withRoute } from "@/lib/http/handler";
import { adminGlobalSearch } from "@/lib/operations/admin-search";

/**
 * 관리자 전역 검색 — GET /admin/search?q=… (⌘K 창이 부른다, ADM-05). 읽기만, 관리자만(화면과 같은 currentAdmin).
 * 결과는 사람마다·글자마다 달라 저장하지 않는다.
 */
export const dynamic = "force-dynamic";

export const GET = withRoute("admin.search", async (request: Request) => {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: "권한이 없습니다. 다시 로그인해주세요." }, { status: 403 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json(await adminGlobalSearch(q), { headers: { "cache-control": "no-store" } });
});
