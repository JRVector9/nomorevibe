import { NextResponse } from "next/server";
import { registerSchema, formatIssues } from "@/lib/domain/products/schema";
import { registerProduct } from "@/lib/domain/products/register";
import { verifyInstructions } from "@/lib/domain/products/verify-contract";
import { errorResponse, tooManyRequests, badJson } from "@/lib/http/respond";
import { withRoute } from "@/lib/http/handler";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { siteOrigin } from "@/lib/site";

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
