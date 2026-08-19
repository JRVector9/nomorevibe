import { NextResponse } from "next/server";
import { queueMakerRefresh } from "@/lib/domain/evidence/maker";
import { withRoute } from "@/lib/http/handler";
import { allowMakerMutation, authorizeMakerRoute } from "../maker-route";

type Params = { params: Promise<{ slug: string }> };

export const POST = withRoute("products.evidence.refresh.queue", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "refresh", 1);
  if (limited) return limited;
  await queueMakerRefresh({ slug, productId: auth.product.id, actor: auth.actor });
  return NextResponse.json({ queued: true }, { status: 202 });
});
