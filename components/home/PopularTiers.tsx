import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator, getDictionary } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import {Suspense} from 'react';
import Link from 'next/link';
import {getPopularGroups} from '@/lib/domain/products/popular';
import {popularHref} from '@/lib/domain/products/stars';
import {PopularFilter} from './PopularFilter';
import {PopularTierCards} from './PopularTierCards';
import {rankedCard} from './popular-cards';
import {logger} from '@/lib/observability/logger';

/**
 * 홈 '많이 쓰이는 프로젝트' — GitHub 스타 구간마다 상위 3을 발견하기 카드로(2026-10-11 시안 안 C).
 * 예전 네 칸 순위 줄은 이름이 잘리고 소개·미리보기 그림이 없었다. 구간은 탭으로 고르고, 전체는 /popular 에서 본다.
 */
export async function PopularTiers({personal=false}:{personal?:boolean}){
 const locale=await getRequestLocale();
 const [t,dictionary]=await Promise.all([getTranslator(locale,"browse"),getDictionary(locale,"browse")]);
 let groups;
 try{groups=await getPopularGroups(personal);}catch(error){
  logger.warn('home.popular_unavailable',{error});
  return <section className="popular-section" id="popular"><h2>{t("popular.title")}</h2><p role="status">{t("error.load")}</p></section>;
 }
 const tiers=groups.map(group=>({key:group.key,label:t(`tier.${group.key}`),range:t(`tierRange.${group.key}`),total:group.total,href:localePath(locale,popularHref(group.key,personal)),
  items:group.items.map((item,index)=>rankedCard(item,index+1))}));
 return <I18nProvider locale={locale} dictionaries={{browse:dictionary}}><section className="popular-section" id="popular" aria-labelledby="popular-title">
  <div className="row-head"><div><h2 id="popular-title" className="row-title">{t("popular.title")}</h2>
   <p className="row-note">{t("popular.homeNote")} · <Link prefetch={false} href={localePath(locale,"/?metric=popular#popular")} scroll={false}>{t("nav.methodology")}</Link></p></div>
   <div><Suspense><PopularFilter personal={personal}/></Suspense></div></div>
  <PopularTierCards groups={tiers} now={new Date().toISOString()}/>
 </section></I18nProvider>;
}
