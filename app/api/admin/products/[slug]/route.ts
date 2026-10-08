import { NextResponse } from "next/server";
import { banProduct } from "@/lib/domain/products/manage";
import { errorResponse } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { bearerMatches } from "@/lib/auth/bearer";
import { recordAdminAction } from "@/lib/operations/admin-log";

type Params = { params: Promise<{ slug: string }> };

export const DELETE = withRoute("admin.ban", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  if (!bearerMatches(req.headers.get("authorization"), process.env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

  const result = await banProduct(slug);
  // 공유 토큰이라 사람 이름이 없다 — 'admin-token' 과 접속 주소로 남긴다
  await recordAdminAction("admin-token", { action: "product-ban", target: slug, detail: { from: "api" },
    ok: result.ok, error: result.ok ? null : result.error.kind }, "token");
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({ slug, status: "banned" });
});
