import type { Metadata } from "next";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { BRAND, SITE_TAGLINE } from "./brand";

/**
 * 공유 미리보기(Open Graph·Twitter) — 카카오톡·슬랙·X 에 링크를 붙이면 뜨는 그림과 글(2026-10-08 점검 SEO-01·UX-07).
 *
 * 그림 주소는 상대 경로로 둔다 — 루트 레이아웃의 metadataBase(siteOrigin)가 절대 주소로 바꾼다.
 * 파일 규칙(app/opengraph-image.png)을 쓰지 않는 까닭: 파일이 설정보다 앞서 상세의 제품 그림을 덮을 수 있다.
 */
export const DEFAULT_SHARE_IMAGE = { url: "/og/nomorevibe.png", width: 1200, height: 630, alt: `${BRAND} — ${SITE_TAGLINE}` };

/**
 * 사이트 설명 — 약속은 실제와 맞춘다(UX-05). 공개 목록은 대부분 공개 저장소에서 찾아 올린 것이고,
 * ✓ 는 메이커가 등록하고 도메인 소유권을 확인한 곳에만 붙는다(/launch 03 과 같은 말).
 */
export const SITE_DESCRIPTION =
  "AI 코딩 도구로 만든 공개 프로젝트를 찾아 모읍니다. 메이커가 /nomorevibe 로 등록하고 도메인 소유권을 확인하면 ✓가 붙습니다.";

/** 루트 레이아웃의 공유 기본값 — 제목·설명은 두지 않는다. 두면 하위 화면이 홈 제목을 물려받는다(얕은 병합). 없으면 <title>·설명을 쓴다 */
export const SITE_SHARE: Pick<Metadata, "openGraph" | "twitter"> = {
  openGraph: { siteName: BRAND, locale: "ko_KR", type: "website", images: [DEFAULT_SHARE_IMAGE] },
  twitter: { card: "summary_large_image", images: [DEFAULT_SHARE_IMAGE.url] },
};

/**
 * 제품 상세의 공유 그림 — 우리가 받아 둔 그 사이트의 대표 이미지(og)나 큰 README 그림일 때만 쓴다.
 * 아이콘·작은 그림(사이트 아이콘·GitHub 프로필·정사각 로고)은 미리보기 카드에서 뭉개지므로 사이트 기본 그림을 쓴다.
 */
export function productShareImage(ogImage: string | null | undefined): { url: string; width?: number; height?: number; alt?: string } {
  if (!ogImage?.startsWith("/api/og-cache/")) return DEFAULT_SHARE_IMAGE;
  const presentation = thumbnailPresentation(ogImage);
  const wide = presentation.kind === "og" || (presentation.kind === "repository_image" && !presentation.identity);
  return wide ? { url: ogImage, width: presentation.width, height: presentation.height } : DEFAULT_SHARE_IMAGE;
}

/** 화면 하나의 공유 메타 — openGraph 는 얕게 병합되므로 사이트 기본값(siteName·locale)을 함께 넣는다 */
export function shareMetadata({ title, description, image = DEFAULT_SHARE_IMAGE, type = "website" }: {
  title: string; description: string; image?: { url: string; width?: number; height?: number; alt?: string }; type?: "website" | "article";
}): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: { siteName: BRAND, locale: "ko_KR", type, title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}
