import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CompactRow } from "@/components/home/CompactRow";
import { pageTitle } from "@/lib/copy/brand";
import { publicRead } from "@/lib/domain/products/public-reads";
import { getPublicList, type ProductListItem } from "@/lib/domain/products/view";
import { logger } from "@/lib/observability/logger";

/**
 * 없는 주소 — Next 기본 영어 404 대신 길을 낸다(2026-10-08 UX 감사 UX-10).
 *
 * 검색창, 지금 뜨는 프로젝트 다섯, 홈 링크. 내려간 프로젝트 주소로 들어온 사람도 여기로 온다(상세 전용 안내는 app/p/[slug]/not-found.tsx).
 * 404 응답에는 Next 가 noindex 를 붙인다.
 */
export const metadata: Metadata = {
  title: pageTitle("페이지를 찾을 수 없습니다"),
};

/** 홈 '지금 뜨는' 띠와 같은 목록·같은 담기 열쇠(app/page.tsx) — 없는 주소가 몰려도 DB 를 더 부르지 않는다 */
const RISING_COUNT = 5;

async function risingProjects(): Promise<ProductListItem[]> {
  try {
    return await publicRead("list", ["strip", RISING_COUNT], () => getPublicList(RISING_COUNT, { sort: "rising", rising: true }));
  } catch (error) {
    // 목록을 못 읽어도 안내와 검색창은 선다
    logger.warn("not_found.rising_unavailable", { error });
    return [];
  }
}

export default async function NotFound() {
  // 빌드 때 굳히지 않는다 — 그때는 DB 가 없어 빈 목록이 박히고, 헤더(검색어를 읽는다)가 브라우저에서야 그려진다
  await connection();
  const rising = await risingProjects();

  return (
    // 위아래 여백은 안쪽 상자에 — .wrap(app/home.css)이 레이어 밖 규칙이라 main 의 padding 유틸리티를 덮는다(error·global-error 도 같다)
    <main className="wrap">
      <div className="pb-16 pt-12">
        <h1 className="text-[26px] font-semibold tracking-tight">찾는 페이지가 없거나 내려갔습니다</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
          주소가 바뀌었거나 프로젝트가 목록에서 내려갔을 수 있습니다. 찾던 것을 검색해 보세요.
        </p>
        <form action="/" method="get" role="search" className="mt-6 flex max-w-[560px] gap-2">
          <label htmlFor="not-found-search" className="sr-only">프로젝트 검색</label>
          <input
            id="not-found-search"
            type="search"
            name="q"
            placeholder="프로젝트, 도구, 아이디어 검색"
            autoComplete="off"
            maxLength={200}
            className="h-11 min-w-0 flex-1 rounded-full bg-bg-soft px-5 text-[15px] text-fg placeholder:text-fg-2"
          />
          <button type="submit" className="h-11 shrink-0 rounded-full bg-fg px-5 text-[15px] font-medium text-bg-card hover:opacity-90">
            검색
          </button>
        </form>
        <p className="mt-4 text-[14px]">
          <Link prefetch={false} href="/" className="inline-flex min-h-11 items-center font-medium text-accent-ink underline underline-offset-4">
            홈으로 가기
          </Link>
        </p>
        <CompactRow id="rising" title="지금 뜨는 프로젝트" items={rising} trailing="category" more={{ href: "/#rising", label: "모두 보기" }} />
      </div>
    </main>
  );
}
