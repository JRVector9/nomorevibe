import { NextResponse } from "next/server";
import { findBySlug } from "@/lib/domain/products/repository";
import { recordClick } from "@/lib/domain/products/clicks";
import { withRoute } from "@/lib/http/handler";
import { clientIp } from "@/lib/rate-limit";
import { siteOrigin } from "@/lib/site";

type Params = { params: Promise<{ slug: string }> };

/**
 * 제품으로 나가는 문.
 *
 * 목록에서 제품 주소로 바로 걸면 누가 무엇을 눌렀는지 알 수 없다. 한 번 거쳐 가게 해서
 * 세고 보낸다. JS 없이도 동작하고, 세는 쪽이 서버라 클라이언트가 조작할 수 없다.
 *
 * 차단된 제품은 내보내지 않는다 — 목록에서 내린 것을 링크로 우회할 수 있으면 내린 의미가 없다.
 */
export const GET = withRoute("products.go", async (req: Request, { params }: Params) => {
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") {
    return NextResponse.redirect(siteOrigin(req), { status: 302 });
  }

  await recordClick(slug, clientIp(req));
  return NextResponse.redirect(product.url, { status: 302 });
});
