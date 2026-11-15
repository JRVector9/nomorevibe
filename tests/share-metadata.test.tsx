import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SHARE_IMAGE, SITE_DESCRIPTION, SITE_SHARE, productShareCard, shareMetadata } from "@/lib/copy/share";
import { generateMetadata } from "@/app/(public)/[locale]/layout";
import LaunchPage from "@/app/(public)/[locale]/(content)/launch/page";

// /launch 는 요청마다 그린다(connection) — 정적 그리기에는 요청 맥락이 없다
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("server-only", () => ({}));
const rootMetadata = await generateMetadata({ params: Promise.resolve({ locale: "ko" }) });

/** 공유 미리보기(2026-10-08 점검 SEO-01·UX-07)와 약속 문구(UX-05) */
describe("공유 미리보기", () => {
  it("제품 상세의 공유 그림은 이름·요약만 그린 공유 카드(언어별 주소, 1200×630) — 표지(og-cache) 주소가 아니다", () => {
    expect(productShareCard("ko", "lcu", "LCU")).toEqual({ url: "/p/lcu/share-card.png", width: 1200, height: 630, alt: "LCU" });
    expect(productShareCard("en", "lcu", "LCU").url).toBe("/en/p/lcu/share-card.png");
    expect(productShareCard("ja", "lcu", "LCU").url).not.toContain("og-cache");
  });

  it("화면 공유 메타는 사이트 이름·한국어·큰 카드에 제목·설명·그림을 함께 싣는다", () => {
    const share = shareMetadata({ title: "LCU — nomorevibe", description: "로컬 우선 메모 앱" });
    expect(share.openGraph).toMatchObject({ siteName: "nomorevibe", locale: "ko_KR", title: "LCU — nomorevibe", description: "로컬 우선 메모 앱", images: [DEFAULT_SHARE_IMAGE] });
    expect(share.twitter).toMatchObject({ card: "summary_large_image", title: "LCU — nomorevibe", images: [DEFAULT_SHARE_IMAGE.url] });
  });

  it("루트 레이아웃은 절대 주소 기준과 기본 그림을 두고, 제목은 두지 않아 하위 화면이 홈 제목을 물려받지 않는다", () => {
    expect(rootMetadata.metadataBase).toBeInstanceOf(URL);
    expect(rootMetadata.openGraph).toEqual(SITE_SHARE.openGraph);
    expect(rootMetadata.openGraph).not.toHaveProperty("title");
    expect(rootMetadata.twitter).toMatchObject({ card: "summary_large_image" });
  });
});

describe("약속 문구(UX-05)", () => {
  it("사이트 설명은 '직접 확인한 것만'을 약속하지 않고 ✓의 뜻을 말한다", () => {
    expect(rootMetadata.description).toBe(SITE_DESCRIPTION);
    expect(SITE_DESCRIPTION).not.toContain("직접 확인한 것만");
    expect(SITE_DESCRIPTION).toContain("도메인 소유권을 확인하면 ✓");
  });

  it("/launch 는 공개 목록 전체가 검증된 것처럼 말하지 않는다", async () => {
    const html = renderToStaticMarkup(await LaunchPage());
    expect(html).not.toContain("검증된 제품만 공개 목록에 오릅니다");
    expect(html).not.toContain("확인한 것만 보여줍니다");
    expect(html).toContain("직접 등록한 프로젝트는 소유권 확인을 마쳐야 공개되고 ✓가 붙습니다");
    expect(html).toContain("확인한 곳에만 ✓를 붙입니다");
  });
});
