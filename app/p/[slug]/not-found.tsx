import Link from "next/link";

/**
 * 상세가 없을 때 — 없는 주소이거나 내려간 프로젝트(차단·내려달라는 요청)다(2026-10-08 UX 감사 UX-10).
 * 영어 기본 404 대신 그럴 수 있는 까닭과 다음 걸음(검색·홈)을 준다. 사이트 전체의 404 는 app/not-found.tsx 다.
 */
export default function ProductNotFound() {
  return (
    <main className="wrap">
      {/* 위아래 여백은 안쪽에 — .wrap 의 padding 이 바깥 여백 유틸리티를 덮는다(app/home.css) */}
      <section aria-labelledby="not-found-title" className="mx-auto flex max-w-[560px] flex-col gap-3 pb-14 pt-16">
        <h1 id="not-found-title" className="text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] text-fg">찾는 프로젝트가 없습니다</h1>
        <p className="text-[15px] leading-[1.6] text-fg-2">
          주소가 바뀌었거나, 운영자의 요청이나 게재 기준에 따라 내려간 프로젝트일 수 있습니다. 이름으로 다시 찾아보세요.
        </p>
        <form action="/" method="get" role="search" className="mt-2 flex gap-2">
          <label htmlFor="not-found-search" className="sr-only">프로젝트 검색</label>
          <input id="not-found-search" type="search" name="q" maxLength={200} autoComplete="off" placeholder="프로젝트, 도구, 아이디어 검색"
            className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-bg-card px-4 text-[15px] text-fg outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
          <button type="submit" className="min-h-11 shrink-0 rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white hover:opacity-90">검색</button>
        </form>
        <Link prefetch={false} href="/" className="inline-flex min-h-11 items-center self-start text-[14px] text-accent-ink hover:underline">홈으로 가기 ›</Link>
      </section>
    </main>
  );
}
