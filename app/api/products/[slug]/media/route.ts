import { NextResponse } from "next/server";
import { makerMediaSchema } from "@/lib/domain/evidence/contracts";
import { replaceMakerMedia } from "@/lib/domain/evidence/maker";
import { formatIssues } from "@/lib/domain/products/schema";
import { withRoute } from "@/lib/http/handler";
import { allowMakerMutation, authorizeMakerRoute, makerJson } from "../maker-route";

type Params = { params: Promise<{ slug: string }> };

export const PUT = withRoute("products.evidence.media", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "media");
  if (limited) return limited;
  const body = await makerJson(request);
  if (!body.ok) return body.response;
  const parsed = makerMediaSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  const count = await replaceMakerMedia({
    slug,
    productId: auth.product.id,
    actor: auth.actor,
    media: parsed.data,
  });
  return NextResponse.json({ slug, queued: true, count }, { status: 202 });
});
