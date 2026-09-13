import { StarMetric } from '@/components/StarMetric';
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
  return <section className="popular-section" id="popular-projects"><h2>많이 쓰이는 프로젝트</h2><p role="status">목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p></section>;
 }
 return <section className="popular-section" id="popular-projects" aria-labelledby="popular-title">
  <div className="popular-heading"><div><span className="popular-eyebrow">GITHUB에서 주목받는</span><h2 id="popular-title">많이 쓰이는 프로젝트</h2>
   <p>스타 2천 이상, 10만 미만의 공개 프로젝트. 각 구간에서 관심을 모으는 제품을 만나보세요.</p></div>
   <Suspense><PopularFilter personal={personal}/></Suspense></div>
  <div className="popular-columns">{groups.map(group=><article className="popular-tier" key={group.key}>
   <header><h3>{group.label}</h3><span>★ {group.range}</span></header>
   {group.items.length?<ol>{group.items.map(p=>{
    const owner=githubOwnerFromRepositoryUrl(p.repoUrl);
    return <li key={p.slug}>
     <div className="popular-project-heading">
      <Link className="popular-project" href={`/p/${p.slug}`} title={p.name}><strong>{p.name}</strong></Link>
      <StarMetric value={p} compact />
     </div>
     {owner?<a className="popular-owner" href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title={`GitHub @${owner.login}`}>@{owner.login}</a>:<span className="popular-owner">GitHub 아이디 미확인</span>}
     <p className="popular-description" title={p.tagline}>{p.tagline || '소개가 아직 없습니다.'}</p>
    </li>;
   })}</ol>:<p className="popular-empty">아직 없음</p>}
   <Link className="popular-all" href={popularHref(group.key,personal)}>{group.total.toLocaleString('ko-KR')}개 모두 보기 <span aria-hidden="true">→</span></Link>
  </article>)}</div>
  <p className="popular-note">하루 한 번 갱신 · 증감은 이전 측정 대비 · —는 비교 수집 중. 스타는 실제 이용자 수가 아닙니다. <Link href="/?metric=popular#popular-projects" scroll={false}>집계 기준</Link></p>
 </section>;
}
