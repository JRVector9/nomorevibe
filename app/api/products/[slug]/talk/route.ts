import { NextResponse } from "next/server";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { errorResponse } from "@/lib/http/respond";
import { talkVisibility } from "@/lib/social/flags";
import { productTalk } from "@/lib/social/talk";
import { productTalkData, type ProductTalkResponse } from "@/lib/social/talk-wire";

type Params = { params: Promise<{ slug: string }> };

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/**
 * 상세 화제 띠(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에는 싣지 않고 브라우저가 여기서 받아 그린다(TalkBandSlot).
 * 자격 글(talk-score.ts)이 있을 때만 talk 를 준다. 화제 화면이 꺼져 있으면(관리자 미리보기도 아니면) 404.
 * 공개 API 읽기 관문을 그대로 거치고, 상세와 같은 짧은 읽기 캐시(publicRead "detail")를 쓴다.
 */
export const GET = withRoute("products.talk", async (req: Request, { params }: Params) => {
  const refused = await guardPublicApiRead(req, "products.talk");
  if (refused) return refused;
  const { slug } = await params;
  const { visible, preview } = await talkVisibility();
  // 관리자 미리보기 여부가 요청마다 달라 이 거절도 담지 않는다
  if (!visible) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const product = await publicRead("detail", ["identity", slug], () => getProductIdentity(slug));
  if (!product) return errorResponse({ kind: "not_found" });
  const talk = await publicRead("detail", ["talk", slug], () => productTalk(product.id, product.repoUrl, new Date()));
  return NextResponse.json({ preview, talk: talk?.qualifies && talk.posts.length ? productTalkData(talk) : null } satisfies ProductTalkResponse, { headers: NO_STORE });
});
