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
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { SESSION_HEADERS } from "@/lib/anti-scrape/session";
import { normalizeUrl } from "@/lib/net/normalize";

type Params = { params: Promise<{ slug: string }> };

/**
 * 밖으로 나가는 제품 필드.
 *
 * 전에는 토큰 둘만 빼고 행 전체를 내보냈다. products에 컬럼을 더할 때마다 기본이 공개였고,
 * 운영자가 누구에게 언제 클레임 초대를 보냈는지(claimInvitedAt)가 그렇게 익명 호출자에게
 * 나갔다. 여기 적은 것만 나간다 — 새 컬럼은 이 목록에 손대야 공개된다.
 *
 * 2026-11-14 외부 수집 방지: 이 JSON 은 우리 화면이 부르지 않는다(상세는 서버가 그린다). 부르는 곳은 스킬의
 * 클레임 확인(skill/SKILL.md 3장 — 이름·소개를 보여 주고 claimable·verify 를 본다)뿐이라 그만큼만 남긴다.
 * 막기 모드에서 세션 없으면 url도 빼고 가져오기 확인에 필요한 최소 필드만 준다.
 * 내부 id·설명·스택·메이커·저장소·출처·시각은 이 JSON에 넣지 않는다.
 */
function publicView(product: Product, minimal: boolean) {
  return {
    slug: product.slug,
    ...(minimal ? {} : { url: product.url }),
    name: product.name,
    tagline: product.tagline,
    category: product.category,
    status: product.status,
  };
}

export const GET = withRoute("products.get", async (req: Request, { params }: Params) => {
  const refused = await guardPublicApiRead(req, "products.get", () => productResponse(req, params, true));
  if (refused) return refused;
  return productResponse(req, params, false);
});

async function productResponse(req: Request, params: Params["params"], minimal: boolean) {
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") {
    return errorResponse({ kind: "not_found" });
  }
  const candidate = new URL(req.url).searchParams.get("url");
  const normalized = candidate === null ? null : normalizeUrl(candidate);
  const publicFields = {
    ...publicView(product, minimal),
    ...(candidate === null ? {} : { matches: normalized !== null
      && [product.url, product.repoUrl].some(url => url && normalizeUrl(url) === normalized) }),
  };
  // A full response must never be cached and served to a sessionless caller (or vice versa).
  const options = { headers: SESSION_HEADERS };

  /**
   * 우리가 대신 올린 제품은 검증 규약을 함께 준다.
   *
   * 검증 토큰은 비밀이 아니다 — 알아도 그 도메인에 배포할 수 없으면 쓸 수 없다.
   * 반대로 주인이 없는 제품에서 이것을 감추면 아무도 가져갈 수 없다. 주인이 있는
   * 제품은 등록할 때 이미 받았으므로 여기서 다시 줄 이유가 없다.
   */
  if (!isUnclaimed(product)) return NextResponse.json(publicFields, options);
  return NextResponse.json({
    ...publicFields,
    claimable: true,
    verify: verifyInstructions(siteOrigin(req), product.verifyToken, slug),
  }, options);
}

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
