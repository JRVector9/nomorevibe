import {Suspense} from 'react';
import Link from 'next/link';
import {getPopularGroups} from '@/lib/domain/products/popular';
import {popularHref} from '@/lib/domain/products/stars';
import {PopularFilter} from './PopularFilter';
import {logger} from '@/lib/observability/logger';

export async function PopularTiers({personal=false}:{personal?:boolean}){
 let groups;
 try{groups=await getPopularGroups(personal);}catch(error){
  logger.warn('home.popular_unavailable',{error});
  return <section className="popular-section" id="popular-projects"><h2>많이 쓰이는 프로젝트</h2><p role="status">목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p></section>;
 }
 return <section className="popular-section" id="popular-projects" aria-labelledby="popular-title">
  <div className="popular-heading"><div><span className="popular-eyebrow">GITHUB에서 주목받는</span><h2 id="popular-title">많이 쓰이는 프로젝트</h2>
   <p>스타 2천 이상, 10만 미만의 공개 프로젝트. 각 구간에서 관심을 모으는 제품을 만나보세요.</p></div>
   <Suspense><PopularFilter personal={personal}/></Suspense></div>
  <div className="popular-columns">{groups.map(group=><article className="popular-tier" key={group.key}>
   <header><h3>{group.label}</h3><span>★ {group.range}</span></header>
   {group.items.length?<ol>{group.items.map((p,index)=><li key={p.slug}>
    <span className="popular-rank" aria-hidden="true">{index+1}</span>
    <Link className="popular-project" href={`/p/${p.slug}`} title={`${p.name} — ${p.tagline}`}><strong>{p.name}</strong><span>{p.ownerType==='User'?'개인 계정':p.ownerType==='Organization'?'조직 계정':'계정 유형 미확인'}</span></Link>
    <span className="popular-stars" aria-label={`스타 ${p.stars.toLocaleString('ko-KR')}개`}>★ {p.stars.toLocaleString('ko-KR')}</span>
   </li>)}</ol>:<p className="popular-empty">아직 없음</p>}
   <Link className="popular-all" href={popularHref(group.key,personal)}>{group.total.toLocaleString('ko-KR')}개 모두 보기 <span aria-hidden="true">→</span></Link>
  </article>)}</div>
  <p className="popular-note">스타는 GitHub의 관심 표시이며 실제 이용자 수가 아닙니다. <Link href="/?metric=popular#popular-projects" scroll={false}>집계 기준</Link></p>
 </section>;
}
