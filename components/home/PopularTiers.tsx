import { StarMetric } from '@/components/StarMetric';
import { ProductIcon } from '@/components/ProductIcon';
import {Suspense} from 'react';
import Link from 'next/link';
import {getPopularGroups} from '@/lib/domain/products/popular';
import {githubOwnerFromRepositoryUrl} from '@/lib/domain/products/github-owner';
import {popularHref} from '@/lib/domain/products/stars';
import {PopularFilter} from './PopularFilter';
import {logger} from '@/lib/observability/logger';

export async function PopularTiers({personal=false}:{personal?:boolean}){
 let groups;
 try{groups=await getPopularGroups(personal);}catch(error){
  logger.warn('home.popular_unavailable',{error});
  return <section className="popular-section" id="popular"><h2>많이 쓰이는 프로젝트</h2><p role="status">목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p></section>;
 }
 return <section className="popular-section" id="popular" aria-labelledby="popular-title">
  <div className="row-head"><div><h2 id="popular-title" className="row-title">많이 쓰이는 프로젝트</h2><p className="row-note">GitHub 스타 2천 이상 · 구간마다 상위 3</p></div>
   <div><Suspense><PopularFilter personal={personal}/></Suspense><Link prefetch={false} className="row-more" href="/?metric=popular#popular" scroll={false}>집계 기준 ›</Link></div></div>
  <div className="popular-columns">{groups.map(group=><article className="popular-tier" key={group.key}>
   <header><h3>{group.label}</h3><span>★ {group.range}</span></header>
   {group.items.length?<ol className="tier-list">{group.items.map((p,index)=>{
    const owner=githubOwnerFromRepositoryUrl(p.repoUrl);
    return <li key={p.slug} className="rank-row">
     <span className="rank-no">{index+1}</span>
     <ProductIcon name={p.name} ogImage={p.ogImage} size={28} />
     <span className="rank-name"><Link prefetch={false} href={`/p/${p.slug}`} title={p.name}>{p.name}</Link>{owner?<small>@{owner.login}</small>:null}</span>
     <StarMetric value={p} />
    </li>;
   })}</ol>:<p className="popular-empty">아직 없음</p>}
   <Link prefetch={false} className="popular-all" href={popularHref(group.key,personal)}>{group.total.toLocaleString('ko-KR')}개 모두 보기 <span aria-hidden="true">→</span></Link>
  </article>)}</div>
 </section>;
}
