import { StarMetric } from '@/components/StarMetric';
import {Suspense} from 'react';
import Link from 'next/link';
import type {Metadata} from 'next';
import {pageTitle} from '@/lib/copy/brand';
import {getPopularPage} from '@/lib/domain/products/popular';
import {STAR_TIERS,parsePopularParams,popularHref} from '@/lib/domain/products/stars';
import {categoryLabel} from '@/lib/domain/products/labels';
import {formatCount} from '@/lib/format/number';
import {formatDay,formatPublicDate} from '@/lib/format/time';
import {PopularFilter} from '@/components/home/PopularFilter';
import {ProductTagline} from '@/components/ProductTagline';
import {logger} from '@/lib/observability/logger';
import {PopularCards} from './PopularCards';
import {TierTabs} from './TierTabs';
import './popular.css';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:pageTitle('많이 쓰이는 프로젝트'),description:'GitHub 스타 2천부터 10만 미만까지, 구간별로 살펴보는 공개 프로젝트.'};
export default async function PopularPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {tier,personal,page}=parsePopularParams(await searchParams);
 const selected=STAR_TIERS.find(t=>t.key===tier)!;
 const now=new Date();
 let result: Awaited<ReturnType<typeof getPopularPage>> | undefined;
 try{result=await getPopularPage(tier,personal,page);}catch(error){logger.error('popular.list_failed',{error});}
 return <main className="wrap popular-page">
  <Link prefetch={false} className="popular-back" href={`/${personal?'?personal=1':''}#popular`}>← 발견하기로 돌아가기</Link>
  <div className="popular-heading"><div><span className="popular-eyebrow">GITHUB에서 주목받는</span><h1>많이 쓰이는 프로젝트</h1><p>GitHub 스타 2천 이상 · 10만 미만</p></div>
   <Suspense><PopularFilter personal={personal}/></Suspense></div>
  <TierTabs current={tier} personal={personal} totals={result?.totals}/>
  {!result?<div className="popular-empty" role="status">목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</div>:<>
   <div className="popular-table-caption"><h2>스타 {selected.range} <span>{formatCount(result.total)}개</span></h2><p>스타 많은 순 · 한 페이지 15개</p></div>
   {/* 넓은 화면은 표, 좁은 화면(≤640px)은 카드 행 — 둘 중 하나만 보인다(popular.css) */}
   {result.items.length?<>
    <div className="popular-table-scroll" role="region" aria-label={`스타 ${selected.range} 프로젝트 표`} tabIndex={0}>
     <table className="popular-table"><thead><tr><th scope="col">#</th><th scope="col">프로젝트</th><th scope="col">소개</th><th scope="col">스타</th><th scope="col">계정</th><th scope="col">스타 확인일</th></tr></thead>
      <tbody>{result.items.map((p,index)=><tr key={p.slug}><td>{(result.page-1)*15+index+1}</td>
       <th scope="row"><Link prefetch={false} href={`/p/${p.slug}`}>{p.name}</Link><span>{categoryLabel(p.category)}</span></th><td><ProductTagline tagline={p.tagline} taglineKo={p.taglineKo} source={p.taglineSource} className="popular-description"/></td>
       <td className="popular-stars"><StarMetric value={p} /></td>
       <td>{p.ownerType==='User'?'개인':p.ownerType==='Organization'?'조직':'미확인'}</td><td><time dateTime={formatDay(p.starsAt,'')||undefined}>{formatPublicDate(p.starsAt,now,'미확인')}</time></td>
      </tr>)}</tbody>
     </table>
    </div>
    <PopularCards items={result.items} first={(result.page-1)*15+1}/>
   </>:<p className="popular-empty">아직 없음</p>}
   <nav className="popular-pagination" aria-label="페이지 이동">
    {result.page>1?<Link prefetch={false} href={popularHref(tier,personal,result.page-1)}>← 이전</Link>:<span aria-disabled="true">← 이전</span>}
    <span aria-live="polite">{result.page} / {result.pages} 페이지</span>
    {result.page<result.pages?<Link prefetch={false} href={popularHref(tier,personal,result.page+1)}>다음 →</Link>:<span aria-disabled="true">다음 →</span>}
   </nav>
  </>}
  <p className="popular-note"><Link prefetch={false} href="/?metric=popular">집계 기준</Link></p>
 </main>;
}
