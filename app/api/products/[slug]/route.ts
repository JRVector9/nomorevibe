import { NextResponse } from "next/server";
import type { Product } from "@/lib/db/schema";
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

/**
 * 밖으로 나가는 제품 필드.
 *
 * 전에는 토큰 둘만 빼고 행 전체를 내보냈다. products에 컬럼을 더할 때마다 기본이 공개였고,
 * 운영자가 누구에게 언제 클레임 초대를 보냈는지(claimInvitedAt)가 그렇게 익명 호출자에게
 * 나갔다. 여기 적은 것만 나간다 — 새 컬럼은 이 목록에 손대야 공개된다.
 */
function publicView(product: Product) {
  return {
    id: product.id,
    slug: product.slug,
    url: product.url,
    name: product.name,
    tagline: product.tagline,
    description: product.description,
    category: product.category,
    builder: product.builder,
    stack: product.stack,
    ogImage: product.ogImage,
    makerName: product.makerName,
    repoUrl: product.repoUrl,
    status: product.status,
    source: product.source,
    claimedAt: product.claimedAt,
    verifyMethod: product.verifyMethod,
    verifiedAt: product.verifiedAt,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export const GET = withRoute("products.get", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") {
    return errorResponse({ kind: "not_found" });
  }
  const publicFields = publicView(product);

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
    verify: verifyInstructions(siteOrigin(req), product.verifyToken, slug),
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
