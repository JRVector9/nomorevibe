import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator } from "@/lib/i18n/dictionary";
import { localePath } from "@/lib/i18n/routing";
import {Suspense} from 'react';
import Link from 'next/link';
import {getPopularGroups} from '@/lib/domain/products/popular';
import {publicRead} from '@/lib/domain/products/public-reads';
import {popularHref} from '@/lib/domain/products/stars';
import {PopularFilter} from './PopularFilter';
import {PopularTierCards} from './PopularTierCards';
import {logger} from '@/lib/observability/logger';

/**
 * 홈 '많이 쓰이는 프로젝트' — GitHub 스타 구간마다 상위 3을 발견하기 카드로(2026-10-11 시안 안 C).
 * 예전 네 칸 순위 줄은 이름이 잘리고 소개·미리보기 그림이 없었다. 구간은 탭으로 고르고, 전체는 /popular 에서 본다.
 */
export async function PopularTiers({personal=false}:{personal?:boolean}){
 const locale=await getRequestLocale();
 const t=await getTranslator(locale,"browse");
 let groups;
 try{groups=await publicRead("list", ["popular-groups", personal], () => getPopularGroups(personal));}catch(error){
  logger.warn('home.popular_unavailable',{error});
  return <section className="popular-section" id="popular"><h2>{t("popular.title")}</h2><p role="status">{t("error.load")}</p></section>;
 }
 // 탭 부품(브라우저)에는 구간 이름·수·주소만 넘어간다. 카드는 서버 HTML 에 싣지 않는다 — 이 구획은 홈 목록 아래(첫 화면 밖)라
 // 첫 구간도 화면 가까이 오면, 다른 구간은 탭을 처음 고를 때 같은 출처 API 로 받는다(2026-11-15 공개 HTML 줄이기 2차)
 const tiers=groups.map(group=>({key:group.key,label:t(`tier.${group.key}`),range:t(`tierRange.${group.key}`),total:group.total,href:localePath(locale,popularHref(group.key,personal))}));
 return <section className="popular-section" id="popular" aria-labelledby="popular-title">
  <div className="row-head"><div><h2 id="popular-title" className="row-title">{t("popular.title")}</h2>
   <p className="row-note">{t("popular.homeNote")} · <Link prefetch={false} href={localePath(locale,"/?metric=popular#popular")} scroll={false}>{t("nav.methodology")}</Link></p></div>
   <div><Suspense><PopularFilter personal={personal}/></Suspense></div></div>
  <PopularTierCards groups={tiers} personal={personal}/>
 </section>;
}
