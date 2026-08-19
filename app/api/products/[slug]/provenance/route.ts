import { NextResponse } from "next/server";
import { makerProvenanceSchema } from "@/lib/domain/evidence/contracts";
import { getMakerProvenanceResource, replaceProductProvenance } from "@/lib/domain/evidence/repository";
import { formatIssues } from "@/lib/domain/products/schema";
import { withRoute } from "@/lib/http/handler";
import {
  allowMakerMutation,
  authorizeMakerRoute,
  makerJson,
  makerResourcePreconditionResponse,
  makerResourceResponse,
  makerResourceVersion,
} from "../maker-route";

type Params = { params: Promise<{ slug: string }> };

export const GET = withRoute("products.evidence.provenance.read", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  return makerResourceResponse(await getMakerProvenanceResource(slug, auth.product.id));
});

export const PUT = withRoute("products.evidence.provenance", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "provenance");
  if (limited) return limited;
  const body = await makerJson(request);
  if (!body.ok) return body.response;
  const parsed = makerProvenanceSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  if ([...parsed.data.agents, ...parsed.data.skills].some((item) => item.evidenceLevel !== "maker_reported")) {
    return NextResponse.json({ error: "메이커는 메이커 제공 근거만 제출할 수 있습니다" }, { status: 400 });
  }
  const version = makerResourceVersion(request);
  if (!version.ok) return version.response;
  try {
    await replaceProductProvenance({
      slug,
      productId: auth.product.id,
      actor: auth.actor,
      authority: "maker",
      provenance: parsed.data,
      expectedVersion: version.value,
    });
  } catch (error) {
    const response = makerResourcePreconditionResponse(error);
    if (response) return response;
    throw error;
  }
  return NextResponse.json({ slug, saved: true, evidence_label: "메이커 제공·미검증" });
});
