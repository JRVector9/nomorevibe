import { NextResponse } from "next/server";
import {
  editMakerUpdate,
  makerUpdatePatchSchema,
  tombstoneMakerUpdate,
} from "@/lib/domain/evidence/maker";
import { formatIssues } from "@/lib/domain/products/schema";
import { withRoute } from "@/lib/http/handler";
import { allowMakerMutation, authorizeMakerRoute, makerJson } from "../../maker-route";

type Params = { params: Promise<{ slug: string; id: string }> };

function parsedId(value: string): number | null {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : null;
}

function mutationResponse(result: "updated" | "deleted" | "not_found" | "forbidden"): Response {
  if (result === "not_found") return NextResponse.json({ error: "업데이트를 찾을 수 없습니다" }, { status: 404 });
  if (result === "forbidden") return NextResponse.json({ error: "자동 감지 업데이트는 메이커가 수정할 수 없습니다" }, { status: 403 });
  return NextResponse.json({ [result]: true });
}

export const PATCH = withRoute("products.evidence.updates.edit", async (request: Request, { params }: Params) => {
  const { slug, id: idInput } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "updates");
  if (limited) return limited;
  const id = parsedId(idInput);
  if (!id) return NextResponse.json({ error: "잘못된 업데이트 ID입니다" }, { status: 400 });
  const body = await makerJson(request);
  if (!body.ok) return body.response;
  const parsed = makerUpdatePatchSchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  return mutationResponse(await editMakerUpdate({
    slug,
    id,
    productId: auth.product.id,
    actor: auth.actor,
    patch: parsed.data,
  }));
});

export const DELETE = withRoute("products.evidence.updates.delete", async (request: Request, { params }: Params) => {
  const { slug, id: idInput } = await params;
  const auth = await authorizeMakerRoute(request, slug);
  if (!auth.ok) return auth.response;
  const limited = await allowMakerMutation(request, auth.product.id, "updates");
  if (limited) return limited;
  const id = parsedId(idInput);
  if (!id) return NextResponse.json({ error: "잘못된 업데이트 ID입니다" }, { status: 400 });
  return mutationResponse(await tombstoneMakerUpdate({
    slug,
    id,
    productId: auth.product.id,
    actor: auth.actor,
  }));
});
