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
 let groups;
 try{groups=await getPopularGroups(personal);}catch(error){
  logger.warn('home.popular_unavailable',{error});
  return <section className="popular-section" id="popular"><h2>많이 쓰이는 프로젝트</h2><p role="status">목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p></section>;
 }
 const tiers=groups.map(group=>({key:group.key,label:group.label,range:group.range,total:group.total,href:popularHref(group.key,personal),
  items:group.items.map((item,index)=>rankedCard(item,index+1))}));
 return <section className="popular-section" id="popular" aria-labelledby="popular-title">
  <div className="row-head"><div><h2 id="popular-title" className="row-title">많이 쓰이는 프로젝트</h2>
   <p className="row-note">GitHub 스타 2천 이상 · 구간마다 상위 3 · <Link prefetch={false} href="/?metric=popular#popular" scroll={false}>집계 기준</Link></p></div>
   <div><Suspense><PopularFilter personal={personal}/></Suspense></div></div>
  <PopularTierCards groups={tiers} now={new Date().toISOString()}/>
 </section>;
}
