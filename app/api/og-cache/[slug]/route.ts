import { NextResponse } from "next/server";
import { getOgImage } from "@/lib/domain/products/repository";

type Params = { params: Promise<{ slug: string }> };

/** 등록 시 우리 저장소에 복사해둔 OG 이미지를 서빙 */
export async function GET(_req: Request, { params }: Params) {
  const { slug } = await params;
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const cached = await getOgImage(slug);
  if (!cached) {
    return NextResponse.json({ error: "이미지가 없습니다" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(cached.data), {
    headers: {
      "content-type": cached.contentType,
      "cache-control": "public, max-age=3600",
    },
  });
}
