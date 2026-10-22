import { NextResponse } from "next/server";
import { registerSchema, formatIssues } from "@/lib/domain/products/schema";
import { registerProduct } from "@/lib/domain/products/register";
import { verifyInstructions } from "@/lib/domain/products/verify-contract";
import { errorResponse, tooManyRequests, badJson } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { siteOrigin } from "@/lib/site";
import { agentClass, trackServer } from "@/lib/analytics/server";

export const POST = withRoute("products.register", async (req: Request) => {
  if (!(await rateLimit(`register:${clientIp(req)}`, 10, 60 * 60 * 1000))) return tooManyRequests();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  }

  const result = await registerProduct(parsed.data);
  if (!result.ok) return errorResponse(result.error);

  const { slug, editToken, verifyToken } = result.value;
  const origin = siteOrigin(req);
  // 방문 분석의 '등록이 들어왔다' — 스킬은 curl 로 부른다. 토큰·주소는 싣지 않는다
  trackServer("launch_submitted", { product_slug: slug, source: agentClass(req.headers.get("user-agent")) === "browser" ? "other" : "skill" },
    { request: req, identity: "auto" });
  return NextResponse.json(
    {
      slug,
      status: "unverified",
      page_url: `${origin}/p/${slug}`,
      edit_token: editToken,
      verify_token: verifyToken,
      verify: verifyInstructions(origin, verifyToken, slug),
    },
    { status: 201 },
  );
});
