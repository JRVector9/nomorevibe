import { NextResponse } from "next/server";
import { updateSchema, formatIssues } from "@/lib/domain/products/schema";
import { updateProduct, deleteProduct } from "@/lib/domain/products/manage";
import { findBySlug } from "@/lib/domain/products/repository";
import { isUnclaimed } from "@/lib/domain/products/view";
import { verifyInstructions } from "@/lib/domain/products/verify-contract";
import { errorResponse, tooManyRequests, badJson } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { siteOrigin } from "@/lib/site";

type Params = { params: Promise<{ slug: string }> };

export const GET = withRoute("products.get", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") {
    return errorResponse({ kind: "not_found" });
  }
  // 토큰류는 응답에서 제외
  const { editTokenHash, verifyToken, ...publicFields } = product;
  void editTokenHash;

  /**
   * 우리가 대신 올린 제품은 검증 규약을 함께 준다.
   *
   * 검증 토큰은 비밀이 아니다 — 알아도 그 도메인에 배포할 수 없으면 쓸 수 없다.
   * 반대로 주인이 없는 제품에서 이것을 감추면 아무도 가져갈 수 없다. 주인이 있는
   * 제품은 등록할 때 이미 받았으므로 여기서 다시 줄 이유가 없다.
   */
  if (!isUnclaimed(product)) return NextResponse.json(publicFields);
  return NextResponse.json({
    ...publicFields,
    claimable: true,
    verify: verifyInstructions(siteOrigin(req), verifyToken, slug),
  });
});

export const PATCH = withRoute("products.update", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  if (!(await rateLimit(`edit:${clientIp(req)}`, 30, 60 * 60 * 1000))) return tooManyRequests();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  }

  const result = await updateProduct(slug, { editToken: req.headers.get("x-edit-token") }, parsed.data);
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({ slug, updated: true });
});

export const DELETE = withRoute("products.delete", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  const result = await deleteProduct(slug, { editToken: req.headers.get("x-edit-token") });
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({ slug, deleted: true });
});
