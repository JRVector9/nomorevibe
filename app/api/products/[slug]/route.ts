import { NextResponse } from "next/server";
import { updateSchema, formatIssues } from "@/lib/domain/products/schema";
import { updateProduct, deleteProduct } from "@/lib/domain/products/manage";
import { findBySlug } from "@/lib/domain/products/repository";
import { errorResponse, tooManyRequests, badJson } from "@/lib/http/respond";
import { rateLimit, clientIp } from "@/lib/rate-limit";

type Params = { params: Promise<{ slug: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  const product = await findBySlug(slug);
  if (!product || product.status === "banned") {
    return errorResponse({ kind: "not_found" });
  }
  // 토큰류는 응답에서 제외
  const { editTokenHash, verifyToken, ...publicFields } = product;
  void editTokenHash;
  void verifyToken;
  return NextResponse.json(publicFields);
}

export async function PATCH(req: Request, { params }: Params) {
  const { slug } = await params;
  if (!rateLimit(`edit:${clientIp(req)}`, 30, 60 * 60 * 1000)) return tooManyRequests();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badJson();
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatIssues(parsed.error) }, { status: 400 });
  }

  const result = await updateProduct(slug, { editToken: req.headers.get("x-edit-token") }, parsed.data);
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({ slug, updated: true });
}

export async function DELETE(req: Request, { params }: Params) {
  const { slug } = await params;
  const result = await deleteProduct(slug, { editToken: req.headers.get("x-edit-token") });
  if (!result.ok) return errorResponse(result.error);
  return NextResponse.json({ slug, deleted: true });
}
