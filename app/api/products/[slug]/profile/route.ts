import { NextResponse } from "next/server";
import { makerProfileSchema } from "@/lib/domain/evidence/contracts";
import { getMakerProfileResource, saveMakerProfile } from "@/lib/domain/evidence/repository";
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

export const GET = withRoute("products.evidence.profile.read", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  return makerResourceResponse({ profile: await getMakerProfileResource(slug, auth.product.id) });
});

export const PUT = withRoute("products.evidence.profile", async (request: Request, { params }: Params) => {
  const { slug } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "profile");
  if (limited) return limited;
  const body = await makerJson(request);
  if (!body.ok) return body.response;
  const parsed = makerProfileSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  const version = makerResourceVersion(request);
  if (!version.ok) return version.response;
  try {
    await saveMakerProfile({
      slug,
      productId: auth.product.id,
      actor: auth.actor,
      profile: parsed.data,
      expectedVersion: version.value,
    });
  } catch (error) {
    const response = makerResourcePreconditionResponse(error);
    if (response) return response;
    throw error;
  }
  return NextResponse.json({ slug, saved: true, evidence_label: "메이커 제공" });
});
