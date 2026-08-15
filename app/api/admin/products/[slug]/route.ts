import { NextResponse } from "next/server";
import { banProduct } from "@/lib/domain/products/manage";
import { errorResponse } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";

type Params = { params: Promise<{ slug: string }> };

export const DELETE = withRoute("admin.ban", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || req.headers.get("authorization") !== `Bearer ${adminToken}`) {
    return NextResponse.json({ error: "권한이 없습니다" }, { status: 403 });
  }

  const result = await banProduct(slug);
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({ slug, status: "banned" });
});
