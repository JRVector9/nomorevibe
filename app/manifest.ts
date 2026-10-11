import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/copy/brand";
import { SITE_DESCRIPTION } from "@/lib/copy/share";
import { THEME_COLOR_LIGHT } from "@/lib/site";

/**
 * 웹 매니페스트(SEO-08) — 안드로이드 '홈 화면에 추가'의 이름·아이콘·바탕색.
 * 앱처럼 띄우지 않고 브라우저 탭으로 연다(display: browser) — 오프라인 지원이 없는데 앱인 척하지 않는다.
 * 아이콘은 public/icon-192.png·icon-512.png(로고의 빨간 점과 n). iOS 는 app/apple-icon.png 를 쓴다.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND,
    short_name: BRAND,
    description: SITE_DESCRIPTION,
    lang: "ko",
    start_url: "/",
    display: "browser",
    background_color: THEME_COLOR_LIGHT,
    theme_color: THEME_COLOR_LIGHT,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
