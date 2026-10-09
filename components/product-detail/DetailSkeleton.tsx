/** 회색 막대 하나 — 실제 글자 자리의 크기로 */
const BAR = "animate-pulse rounded-[8px] bg-bg-soft";

/**
 * 상세 본문이 오는 동안의 머리 골격(2026-10-08 UX 감사 UX-38).
 *
 * 상세는 force-dynamic 이고 저장소 사실·근거를 여러 표에서 모아 읽는다 — 그동안 이전 화면 그대로라 눌린 것인지 알 수 없었다.
 * ProductHero 와 같은 자리(아이콘 80 · 이름 40 · 소개 20 · 메타 한 줄 · 단추 줄)와 사실 칸 줄만 그린다.
 *
 * loading.tsx 가 아니라 페이지 안의 Suspense 로 건다 — 구간 전체를 감싸는 loading 은 응답을 먼저 흘려보내
 * 없는 제품도 404 대신 200 을 낸다. 페이지가 제품을 먼저 찾고(없으면 404) 그다음에 이 골격을 흘린다(app/p/[slug]/page.tsx).
 */
export function DetailSkeleton() {
  return (
    <main aria-busy="true" aria-live="polite" className="wrap pb-14">
      <span className="sr-only">프로젝트를 불러오는 중</span>
      <div className={`mt-4 h-[18px] w-[180px] ${BAR}`} />
      <section className="border-b border-line pb-7 pt-6">
        <div className="flex flex-wrap items-start gap-[22px]">
          <div className={`h-20 w-20 shrink-0 rounded-[18px] ${BAR}`} />
          <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-2.5">
            <div className={`h-10 w-[240px] max-w-full ${BAR}`} />
            <div className={`h-[26px] w-[520px] max-w-full ${BAR}`} />
            <div className={`h-[19px] w-[360px] max-w-full ${BAR}`} />
            <div className="mt-2 flex flex-wrap gap-2">
              {["w-[120px]", "w-20", "w-20", "w-11"].map((width, index) => <div key={index} className={`h-11 rounded-full ${width} ${BAR}`} />)}
            </div>
          </div>
        </div>
      </section>
      <div className={`mt-7 h-[180px] max-w-[760px] rounded-[18px] border border-line ${BAR}`} />
    </main>
  );
}
