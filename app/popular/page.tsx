import {Suspense} from 'react';
import Link from 'next/link';
import type {Metadata} from 'next';
import {getPublicObservedAgentFacts} from '@/lib/domain/products/detail-view';
import {getPopularPage} from '@/lib/domain/products/popular';
import {STAR_TIERS,parsePopularParams,popularHref} from '@/lib/domain/products/stars';
import {categoryLabel} from '@/lib/domain/products/labels';
import {PopularFilter} from '@/components/home/PopularFilter';
import {logger} from '@/lib/observability/logger';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'많이 쓰이는 프로젝트 — NoMoreVibe',description:'GitHub 스타 2천부터 10만 미만까지, 구간별로 살펴보는 공개 프로젝트.'};
export default async function PopularPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const {tier,personal,page}=parsePopularParams(await searchParams);
 const selected=STAR_TIERS.find(t=>t.key===tier)!;
 let result: Awaited<ReturnType<typeof getPopularPage>> | undefined;
 try{result=await getPopularPage(tier,personal,page);}catch(error){logger.error('popular.list_failed',{error});}
 const evidence=result?await getPublicObservedAgentFacts(result.items.map(p=>p.slug)).catch(()=>null):null;
 return <main className="wrap popular-page">
  <Link className="popular-back" href={`/${personal?'?personal=1':''}#popular-projects`}>← 발견하기로 돌아가기</Link>
  <div className="popular-heading"><div><span className="popular-eyebrow">GITHUB에서 주목받는</span><h1>많이 쓰이는 프로젝트</h1><p>스타 구간별로 비교하고, 마음에 드는 프로젝트의 제작 근거를 살펴보세요.</p></div>
   <Suspense><PopularFilter personal={personal}/></Suspense></div>
  <nav className="popular-tabs" aria-label="스타 구간">{STAR_TIERS.map((t,index)=><Link key={t.key} aria-current={tier===t.key?'page':undefined} href={popularHref(t.key,personal)}>
   <strong>{t.label}</strong><span>{t.range}</span>{result&&<b>{result.totals[index].toLocaleString('ko-KR')}</b>}</Link>)}</nav>
  {!result?<div className="popular-empty" role="status">목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</div>:<>
   <div className="popular-table-caption"><h2>{selected.label} <span>{result.total.toLocaleString('ko-KR')}개</span></h2><p>스타 많은 순 · 한 페이지 15개</p></div>
   <div className="popular-table-scroll" role="region" aria-label={`${selected.label} 프로젝트 표`} tabIndex={0}>
    <table className="popular-table"><thead><tr><th scope="col">#</th><th scope="col">프로젝트</th><th scope="col">한 줄 소개</th><th scope="col">스타</th><th scope="col">AI 흔적</th><th scope="col">계정</th><th scope="col">스타 확인일</th></tr></thead>
     <tbody>{result.items.length?result.items.map((p,index)=><tr key={p.slug}><td>{(result.page-1)*15+index+1}</td>
      <th scope="row"><Link href={`/p/${p.slug}`}>{p.name}</Link><span>{categoryLabel(p.category)}</span></th><td>{p.tagline}</td>
      <td className="popular-stars">★ {p.stars.toLocaleString('ko-KR')}</td><td className="popular-evidence">{evidence===null?<span>조회 지연</span>:evidence.get(p.slug)?.length?<><span>{Array.from(new Set(evidence.get(p.slug)!.map(f=>f.clientLabel.startsWith('미확인')?f.label:f.clientLabel))).slice(0,2).join(' · ')}</span><small>공개 저장소에서 관측</small>{Array.from(new Set(evidence.get(p.slug)!.flatMap(f=>[f.coverageLabel,f.relationshipLabel]).filter(Boolean))).map(label=><small key={label}>{label}</small>)}</>:<span>공개된 흔적 없음</span>}<Link href={`/p/${p.slug}#evidence`}>근거 보기 ↗</Link></td>
      <td>{p.ownerType==='User'?'개인':p.ownerType==='Organization'?'조직':'미확인'}</td><td><time>{p.starsAt?.slice(0,10)??'미확인'}</time></td>
     </tr>):<tr><td colSpan={7} className="popular-empty">아직 없음</td></tr>}</tbody>
    </table>
   </div>
   <nav className="popular-pagination" aria-label="페이지 이동">
    {result.page>1?<Link href={popularHref(tier,personal,result.page-1)}>← 이전</Link>:<span aria-disabled="true">← 이전</span>}
    <span aria-live="polite">{result.page} / {result.pages} 페이지</span>
    {result.page<result.pages?<Link href={popularHref(tier,personal,result.page+1)}>다음 →</Link>:<span aria-disabled="true">다음 →</span>}
   </nav>
  </>}
  <p className="popular-note">공개된 제품 중 접속 불가로 확인된 제품과 스타 10만 이상은 제외합니다. 스타는 이용자 수가 아닙니다. AI 흔적은 지침·설정·기여 표기의 관측이며 실제 사용을 증명하지 않습니다. <Link href="/?metric=popular">집계 기준</Link></p>
 </main>;
}
