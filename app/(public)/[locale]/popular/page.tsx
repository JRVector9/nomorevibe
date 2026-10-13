import Link from 'next/link';
import type {Metadata} from 'next';
import {canonicalAlternates} from '@/app/(public)/[locale]/page';
import {Icon} from '@/components/home/icons';
import {rankedCard} from '@/components/home/popular-cards';
import {RankedCards} from '@/components/home/RankedCards';
import {pageTitle} from '@/lib/copy/brand';
import {CATEGORY_LABELS,categoryLabel} from '@/lib/domain/products/labels';
import {getPopularFacets,getPopularPage,type PopularFacets} from '@/lib/domain/products/popular';
import {STAR_TIERS,parsePopularParams,popularStateHref,type PopularState} from '@/lib/domain/products/stars';
import {formatCount} from '@/lib/format/number';
import {logger} from '@/lib/observability/logger';
import {PopularList} from './PopularList';
import './popular.css';
export const dynamic='force-dynamic';
// 구간·거르기·정렬·보기(?tier= 등)는 같은 화면의 보기다 — 정식 주소는 /popular 하나(SEO-04)
export const metadata:Metadata={title:pageTitle('많이 쓰이는 프로젝트'),description:'GitHub 스타 2천부터 10만 미만까지, 구간별로 살펴보는 공개 프로젝트.',alternates:canonicalAlternates('/popular')};

const SORTS=[{key:'stars',label:'스타 많은 순'},{key:'rising',label:'요즘 많이 는 순'}] as const;
const VIEWS=[{key:'list',label:'목록으로 보기',icon:'list'},{key:'cards',label:'카드로 보기',icon:'grid'}] as const;

/**
 * 많이 쓰이는 프로젝트(2026-10-11 시안 보완안) — 발견하기·분야 화면과 같은 부품으로:
 * 구간은 정렬 탭 모양(.tabs), 'AI로 제작'·'개인 계정만'·분야는 칩(.chips, 누르면 나올 수), 정렬(스타 많은 순·요즘 많이 는 순)과 보기(목록·카드).
 * 목록 줄과 카드는 발견하기 카드의 커버(사이트 미리보기 그림)·이름·소개를 그대로 쓰고 저장(북마크)을 단다.
 */
export default async function PopularPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const state=parsePopularParams(await searchParams);
 const filters={personal:state.personal,ai:state.ai,category:state.category};
 const selected=STAR_TIERS.find(t=>t.key===state.tier)!;
 const now=new Date().toISOString();
 let result:Awaited<ReturnType<typeof getPopularPage>>|undefined;
 let facets:PopularFacets|undefined;
 try{[result,facets]=await Promise.all([getPopularPage(state.tier,filters,state.sort,state.page),getPopularFacets(state.tier,filters)]);}
 catch(error){logger.error('popular.list_failed',{error});}
 const narrowed=state.personal||state.ai||Boolean(state.category);
 const href=(patch:Partial<PopularState>)=>popularStateHref(state,patch);
 const first=result?(result.page-1)*result.pageSize+1:1;
 const items=result?.items.map((item,index)=>rankedCard(item,first+index))??[];

 return <main className="wrap popular-page">
  <nav aria-label="경로" className="popular-crumbs"><Link prefetch={false} href="/">발견하기</Link><span aria-hidden="true">›</span><span aria-current="page">많이 쓰이는 프로젝트</span></nav>
  <div className="popular-heading">
   <h1>많이 쓰이는 프로젝트</h1>
   <p>GitHub 스타 2천 이상 10만 미만 · 구간마다 스타 많은 순 · <Link prefetch={false} href="/?metric=popular">집계 기준</Link></p>
  </div>
  <div className="filter-top">
   <nav className="tabs popular-tier-tabs" aria-label="스타 구간">
    {STAR_TIERS.map((tier,index)=>{const active=tier.key===state.tier;
     return <Link prefetch={false} key={tier.key} href={href({tier:tier.key})} className={`tab${active?' active':''}`} aria-current={active?'page':undefined}>
      {tier.label}{result&&<> <span className="tab-count">{formatCount(result.totals[index])}</span></>}
     </Link>;})}
   </nav>
   <nav className="chips chips-ai" aria-label="거르기">
    <Link prefetch={false} href={href({ai:!state.ai})} className={`chip${state.ai?' chip-dark':''}`} aria-current={state.ai?'true':undefined}>
     AI로 제작{facets&&<> <span className="chip-count">{formatCount(facets.ai)}</span></>}
    </Link>
    <Link prefetch={false} href={href({personal:!state.personal})} className={`chip${state.personal?' chip-dark':''}`} aria-current={state.personal?'true':undefined}>
     개인 계정만{facets&&<> <span className="chip-count">{formatCount(facets.personal)}</span></>}
    </Link>
   </nav>
   <nav className="chips chips-filter popular-categories" aria-label="분야">
    <Link prefetch={false} href={href({category:null})} className={`chip${state.category?'':' chip-dark'}`} aria-current={state.category?undefined:'true'}>
     전체{facets&&<> <span className="chip-count">{formatCount(facets.all)}</span></>}
    </Link>
    {facets?.categories.filter(c=>c.category in CATEGORY_LABELS).map(({category,count})=>{const active=state.category===category;
     return <Link prefetch={false} key={category} href={href({category:active?null:category as PopularState['category']})} className={`chip${active?' chip-dark':''}`} aria-current={active?'true':undefined}>
      {categoryLabel(category)} <span className="chip-count">{formatCount(count)}</span>
     </Link>;})}
   </nav>
  </div>
  {!result?<div className="popular-empty" role="status">목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</div>:<section aria-labelledby="popular-list-title">
   <div className="popular-summary">
    <div>
     <h2 id="popular-list-title">★ {selected.range} · {state.category?categoryLabel(state.category):'전체 분야'} {formatCount(result.total)}개</h2>
     <p>★ 옆 초록 숫자는 지난 확인보다 늘어난 스타 · {state.sort==='rising'?'하루 평균으로 많이 는 순':'스타 많은 순'}</p>
    </div>
    <div className="popular-controls">
     <nav className="tabs tabs-sm" aria-label="정렬">
      {SORTS.map(sort=>{const active=state.sort===sort.key;
       return <Link prefetch={false} key={sort.key} href={href({sort:sort.key})} className={`tab${active?' active':''}`} aria-current={active?'true':undefined}>{sort.label}</Link>;})}
     </nav>
     <nav className="tabs tabs-sm" aria-label="보기">
      {VIEWS.map(view=>{const active=state.view===view.key;
       return <Link prefetch={false} key={view.key} href={href({view:view.key})} className={`tab tab-icon${active?' active':''}`} aria-current={active?'true':undefined} aria-label={view.label} title={view.label}>
        <Icon name={view.icon} size={16}/>
       </Link>;})}
     </nav>
     {narrowed&&<Link prefetch={false} href={href({personal:false,ai:false,category:null})} className="clear-filters show">필터 초기화</Link>}
    </div>
   </div>
   {items.length===0?<p className="popular-empty">이 조건에 맞는 프로젝트가 없습니다.</p>
    :state.view==='cards'?<RankedCards items={items} now={now}/>:<PopularList items={items} now={now}/>}
   {result.total>0&&<nav className="popular-pagination" aria-label="페이지 이동">
    {result.page>1?<Link prefetch={false} href={href({page:result.page-1})}>‹ 이전</Link>:<span aria-disabled="true">‹ 이전</span>}
    <span aria-live="polite">{formatCount(first)}–{formatCount(first+items.length-1)}위 / {formatCount(result.total)}</span>
    {result.page<result.pages?<Link prefetch={false} href={href({page:result.page+1})}>다음 ›</Link>:<span aria-disabled="true">다음 ›</span>}
   </nav>}
  </section>}
 </main>;
}
