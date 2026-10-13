import {localizeProductList} from "@/lib/i18n/products";
import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator, getDictionary } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import { formatNumber } from "@/lib/i18n/format";
import Link from 'next/link';
import type { Metadata, ResolvingMetadata } from 'next';
import { localizedOpenGraph } from '@/lib/i18n/metadata';
import {canonicalAlternates} from '@/app/(public)/[locale]/(content)/page';
import {Icon} from '@/components/home/icons';
import {rankedCard} from '@/components/home/popular-cards';
import {RankedCards} from '@/components/home/RankedCards';
import {pageTitle} from '@/lib/copy/brand';
import {CATEGORY_LABELS} from '@/lib/domain/products/labels';
import {translatedCategory} from '@/components/home/i18n';
import {getPopularFacets,getPopularPage,type PopularFacets} from '@/lib/domain/products/popular';
import {STAR_TIERS,parsePopularParams,popularStateHref,type PopularState} from '@/lib/domain/products/stars';
import {logger} from '@/lib/observability/logger';
import {PopularList} from './PopularList';
import './popular.css';
export const dynamic='force-dynamic';
// 구간·거르기·정렬·보기(?tier= 등)는 같은 화면의 보기다 — 정식 주소는 /popular 하나(SEO-04)
export async function generateMetadata(props?: PageProps<"/[locale]/popular">, parent?: ResolvingMetadata): Promise<Metadata> {
 void props;
 const locale = await getRequestLocale();
 const t = await getTranslator(locale, "browse");
 const title = pageTitle(t("popular.title"));
 const description = t("popular.description");
 return {
  title, description, alternates: canonicalAlternates("/popular", locale),
  openGraph: { ...(await parent)?.openGraph, ...localizedOpenGraph(locale), title, description, url: localePath(locale, "/popular") },
 };
}

const SORTS=[{key:'stars',label:'popular.stars'},{key:'rising',label:'popular.rising'}] as const;
const VIEWS=[{key:'list',label:'nav.listView',icon:'list'},{key:'cards',label:'nav.cardView',icon:'grid'}] as const;

/**
 * 많이 쓰이는 프로젝트(2026-10-11 시안 보완안) — 발견하기·분야 화면과 같은 부품으로:
 * 구간은 정렬 탭 모양(.tabs), 'AI로 제작'·'개인 계정만'·분야는 칩(.chips, 누르면 나올 수), 정렬(스타 많은 순·요즘 많이 는 순)과 보기(목록·카드).
 * 목록 줄과 카드는 발견하기 카드의 커버(사이트 미리보기 그림)·이름·소개를 그대로 쓰고 저장(북마크)을 단다.
 */
export default async function PopularPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const locale=await getRequestLocale();
 const [t,labels,dictionary]=await Promise.all([getTranslator(locale,"browse"),getTranslator(locale,"labels"),getDictionary(locale,"browse")]);
 const count=(n:number)=>formatNumber(n,locale);
 const state=parsePopularParams(await searchParams);
 const filters={personal:state.personal,ai:state.ai,category:state.category};
 const selected=STAR_TIERS.find(t=>t.key===state.tier)!;
 const now=new Date().toISOString();
 let result:Awaited<ReturnType<typeof getPopularPage>>|undefined;
 let facets:PopularFacets|undefined;
 try{[result,facets]=await Promise.all([getPopularPage(state.tier,filters,state.sort,state.page),getPopularFacets(state.tier,filters)]);}
 catch(error){logger.error('popular.list_failed',{error});}
 const narrowed=state.personal||state.ai||Boolean(state.category);
 const href=(patch:Partial<PopularState>)=>localePath(locale,popularStateHref(state,patch));
 const first=result?(result.page-1)*result.pageSize+1:1;
 const items=(await localizeProductList(result?.items??[],locale)).map((item,index)=>rankedCard(item,first+index));

 return <I18nProvider locale={locale} dictionaries={{browse:dictionary}}><main className="wrap popular-page">
  <nav aria-label={t("nav.breadcrumb")} className="popular-crumbs"><Link prefetch={false} href={localePath(locale,"/")}>{t("nav.discover")}</Link><span aria-hidden="true">›</span><span aria-current="page">{t("popular.title")}</span></nav>
  <div className="popular-heading">
   <h1>{t("popular.title")}</h1>
   <p>{t("popular.note")} · <Link prefetch={false} href={localePath(locale,"/?metric=popular")}>{t("nav.methodology")}</Link></p>
  </div>
  <div className="filter-top">
   <nav className="tabs popular-tier-tabs" aria-label={t("popular.tiers")}>
    {STAR_TIERS.map((tier,index)=>{const active=tier.key===state.tier;
     return <Link prefetch={false} key={tier.key} href={href({tier:tier.key})} className={`tab${active?' active':''}`} aria-current={active?'page':undefined}>
      {t(`tier.${tier.key}`)}{result&&<> <span className="tab-count">{count(result.totals[index])}</span></>}
     </Link>;})}
   </nav>
   <nav className="chips chips-ai" aria-label={t("nav.filters")}>
    <Link prefetch={false} href={href({ai:!state.ai})} className={`chip${state.ai?' chip-dark':''}`} aria-current={state.ai?'true':undefined}>
     {labels("ai.made")}{facets&&<> <span className="chip-count">{count(facets.ai)}</span></>}
    </Link>
    <Link prefetch={false} href={href({personal:!state.personal})} className={`chip${state.personal?' chip-dark':''}`} aria-current={state.personal?'true':undefined}>
     {t("popular.personal")}{facets&&<> <span className="chip-count">{count(facets.personal)}</span></>}
    </Link>
   </nav>
   <nav className="chips chips-filter popular-categories" aria-label={t("filter.category")}>
    <Link prefetch={false} href={href({category:null})} className={`chip${state.category?'':' chip-dark'}`} aria-current={state.category?undefined:'true'}>
     {t("filter.all")}{facets&&<> <span className="chip-count">{count(facets.all)}</span></>}
    </Link>
    {facets?.categories.filter(c=>c.category in CATEGORY_LABELS).map(({category,count:categoryCount})=>{const active=state.category===category;
     return <Link prefetch={false} key={category} href={href({category:active?null:category as PopularState['category']})} className={`chip${active?' chip-dark':''}`} aria-current={active?'true':undefined}>
      {translatedCategory(category,labels)} <span className="chip-count">{count(categoryCount)}</span>
     </Link>;})}
   </nav>
  </div>
  {!result?<div className="popular-empty" role="status">{t("error.load")}</div>:<section aria-labelledby="popular-list-title">
   <div className="popular-summary">
    <div>
     <h2 id="popular-list-title">{t("popular.range", { range:t(`tierRange.${selected.key}`),category:state.category?translatedCategory(state.category,labels):t("popular.allCategories"),count:count(result.total) })}</h2>
     <p>{t("popular.metricHint")} · {t(state.sort==='rising'?"popular.daily":"popular.stars")}</p>
    </div>
    <div className="popular-controls">
     <nav className="tabs tabs-sm" aria-label={t("nav.sort")}>
      {SORTS.map(sort=>{const active=state.sort===sort.key;
       return <Link prefetch={false} key={sort.key} href={href({sort:sort.key})} className={`tab${active?' active':''}`} aria-current={active?'true':undefined}>{t(sort.label)}</Link>;})}
     </nav>
     <nav className="tabs tabs-sm" aria-label={t("nav.view")}>
      {VIEWS.map(view=>{const active=state.view===view.key;
       return <Link prefetch={false} key={view.key} href={href({view:view.key})} className={`tab tab-icon${active?' active':''}`} aria-current={active?'true':undefined} aria-label={t(view.label)} title={t(view.label)}>
        <Icon name={view.icon} size={16}/>
       </Link>;})}
     </nav>
     {narrowed&&<Link prefetch={false} href={href({personal:false,ai:false,category:null})} className="clear-filters show">{t("filter.reset")}</Link>}
    </div>
   </div>
   {items.length===0?<p className="popular-empty">{t("popular.filteredEmpty")}</p>
    :state.view==='cards'?<RankedCards items={items} now={now}/>:<PopularList items={items} now={now}/>}
   {result.total>0&&<nav className="popular-pagination" aria-label={t("nav.pages")}>
    {result.page>1?<Link prefetch={false} href={href({page:result.page-1})}>‹ {t("nav.previous")}</Link>:<span aria-disabled="true">‹ {t("nav.previous")}</span>}
    <span aria-live="polite">{t("popular.position", { first:count(first),last:count(first+items.length-1),total:count(result.total) })}</span>
    {result.page<result.pages?<Link prefetch={false} href={href({page:result.page+1})}>{t("nav.next")} ›</Link>:<span aria-disabled="true">{t("nav.next")} ›</span>}
   </nav>}
  </section>}
 </main></I18nProvider>;
}
