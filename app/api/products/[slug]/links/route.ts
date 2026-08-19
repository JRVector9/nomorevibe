import { NextResponse } from "next/server";
import { makerLinksSchema } from "@/lib/domain/evidence/contracts";
import { replaceMakerLinks } from "@/lib/domain/evidence/repository";
import { formatIssues } from "@/lib/domain/products/schema";
import { withRoute } from "@/lib/http/handler";
import { allowMakerMutation, authorizeMakerRoute, makerJson } from "../maker-route";

type Params = { params: Promise<{ slug: string }> };

export const PUT = withRoute("products.evidence.links", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "links");
  if (limited) return limited;
  const body = await makerJson(request);
  if (!body.ok) return body.response;
  const parsed = makerLinksSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  await replaceMakerLinks({
    slug,
    productId: auth.product.id,
    actor: auth.actor,
    links: (body.value as { links: unknown }).links,
  });
  return NextResponse.json({ slug, saved: true, count: parsed.data.links.length });
});
