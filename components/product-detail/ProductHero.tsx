import type { ReactNode } from "react";
import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import { HeroActionsSlot, HeroBadgesSlot, HeroIconSlot, HeroMetaSlot, HeroTaglineNotes, type HeroFollowLabels } from "./DetailHeroSlots";

/**
 * 상세 머리 — 아이콘 80 · 이름 40 · 한 줄 소개 20 · 메타 한 줄 · 버튼.
 *
 * 서버 HTML 에는 이름(h1)과 요약(그 언어의 한 줄)만 글자로 둔다(2026-11-15 공개 HTML 이름·요약만, 문서 4.2).
 * 아이콘·배지·출처 줄·메타 줄(분야·스타·언어·주인·가동 상태)·단추는 같은 출처 API 로 받아 채운다(DetailHeroSlots) — 받는 동안은 같은 크기의 빈 자리.
 * 단추는 [제품 방문하기][GitHub][공유][저장] 넷이다(UX-31). 써보기 판(tryPanel)은 slug·이름만 받는 브라우저 부품이라 서버가 그대로 넘긴다.
 */
export function ProductHero({ teaser, tryPanel, followLabels = null }: {
  teaser: PublicTeaser;
  /** 써보기 판(components/feedback/TryPanel) — 단추 바로 아래. 써봤어요가 켜졌을 때만 넘긴다 */
  tryPanel?: ReactNode;
  /** 팔로 단추 글자(로그인 기능이 켜졌을 때만) — 메이커 단추 글의 주인 자리는 받은 뒤 채운다 */
  followLabels?: HeroFollowLabels;
}) {
  return (
    <section className="border-b border-line pb-7 pt-6">
      <div className="flex flex-wrap items-start gap-[22px]">
        <div className="shrink-0 overflow-hidden rounded-[18px] border border-line bg-bg-soft [&_img]:rounded-none [&_img]:border-0">
          <HeroIconSlot slug={teaser.slug} name={teaser.name} />
        </div>
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">{teaser.name}</h1>
            <HeroBadgesSlot slug={teaser.slug} />
          </div>
          <p className="max-w-[720px] text-[20px] leading-[1.35] tracking-[-0.01em] text-fg" lang={teaser.lang}>{teaser.summary}</p>
          <HeroTaglineNotes slug={teaser.slug} />
          <HeroMetaSlot slug={teaser.slug} followLabels={followLabels} />
          <HeroActionsSlot slug={teaser.slug} name={teaser.name} followLabels={followLabels} />
          {tryPanel}
        </div>
      </div>
    </section>
  );
}
