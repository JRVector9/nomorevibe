import { desc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, products, takedownRequests, type Product } from "@/lib/db/schema";
import { repoGone } from "./repository";

/**
 * 검색엔진 색인 판단(2026-10-08 UX 감사 UX-08, 2026-10-09 운영자 결정 D1·D2).
 *
 * 상세 페이지의 robots(productIndexable)와 sitemap 의 조건(indexableProduct)이 같은 뜻이어야 한다 — 하나만 고치면
 * sitemap 에 실린 주소가 noindex 를 내거나, 색인해도 되는 페이지가 sitemap 에서 빠진다. 둘은 아래 규칙을 그대로 옮긴 것이고
 * 통합 테스트(tests/integration/product-indexing.test.ts)가 갈래마다 두 답이 같은지 본다.
 *
 * 1. 공개(seeded·verified)가 아니면 색인하지 않는다 — 차단(banned)·미검증(unverified).
 * 2. 처리되지 않은 내려달라는 요청(takedown_requests.handled_at is null)이 있으면 색인하지 않는다. 요청이 오는 즉시다(D1).
 *    둠(dismissed)으로 처리되면 다시 색인한다. 내림(removed)이면 차단돼 1번에 걸린다.
 * 3. 주인이 있는 제품(view.ts isUnclaimed 의 반대 — 등록하거나 클레임한 것)은 색인한다.
 *    단 설치형의 저장소가 사라졌다고 확정되면(repository.ts repoGone) 공개 목록이 가리는 것과 같이(notDown) 색인하지 않는다.
 *    웹사이트는 사이트가 살아 있을 수 있어 목록에 남으므로 색인도 남는다.
 * 4. 주인이 없는 제품(우리가 찾아 올린 것)은 셋을 모두 갖춰야 색인한다.
 *    - 개인 프로필(Profile)이 아니다 — 본인이 등록·클레임하기 전에는 noindex 를 지킨다(D2).
 *    - 저장소가 사라지지 않았다(repoGone 아님) — 근거가 그 저장소에 있으므로 사라지면 더는 확인할 수 없다.
 *      설치형이면 이미 공개 목록에서도 빠져 있다.
 *    - AI 근거가 확인됐다(confirmedAiEvidence): 제품 저장소의 마지막 완료·부분 루트 조사(agent_repository_scans,
 *      scope '', state complete·partial)가 이름을 아는 AI 코딩 도구의 흔적(observation 의 client)을 하나 이상 남겼다.
 *      홈 '무엇으로 만들었나'의 "흔적 있음" 수(home-pulse.ts)와 도구 거르기(observed-tool.ts)가 세는 것과 같다 —
 *      루트 지침 파일(CLAUDE.md·.cursor 등)·도구 설정·도구 이름이 붙은 커밋 서명. 도구를 알 수 없는 공유 형식(AGENTS.md 등)만
 *      있는 것은 들지 않는다. 흔적은 사용 주장이지 실행 증명이 아니다(상세 '무엇으로 만들었나'의 문구와 같다).
 *      관찰 사실 공개 설정(displayObservedFacts)과는 무관하다 — 보여 주는지가 아니라 근거가 있는지를 본다.
 *    "스팸 검사 통과"는 공개 상태로 충분하다: 발행 관문(publish.ts)이 스팸 판정(spam-signals.ts)을 지난 것만 올리고,
 *    하루 한 바퀴 스팸 재검사(jobs/products/spam-rescan.ts)가 공개분 중 걸린 것을 차단으로 내린다(1번에 걸린다).
 *    예외는 사람이 승인·차단 해제한 것과 스타 자동 승인(500★ 이상), 그리고 하루 자동 차단 한도(50건)를 넘겨 다음 날로
 *    밀린 것이다 — 앞의 둘은 사람·인기도가 대신 본 것이고, 한도 초과는 운영센터가 critical 로 알린다.
 *
 * 응답 없음(product_health 연속 실패)은 보지 않는다 — 공개 목록은 가리지만 하루 안팎에 저절로 돌아오는 상태라
 * 색인을 껐다 켰다 하면 검색엔진에서 오래 빠진다. 상세 페이지는 그동안에도 그대로 선다.
 */

/** 색인 판단에 드는 값 — 상세의 제품 행(detail-view.ts PublicProduct)에 indexingFields 를 더하면 모두 있다 */
export type IndexingFacts = Pick<Product, "status" | "source" | "claimedAt" | "accessMode" | "category"> & {
  /** repository.ts repoGoneField 로 읽은 값 */
  repoGone?: boolean;
  /** indexingFields.aiEvidence */
  aiEvidence: boolean;
  /** indexingFields.takedownPending */
  takedownPending: boolean;
};

/** 위 규칙의 JS 판 — 상세 generateMetadata 의 robots 가 쓴다. 참이면 색인해도 된다 */
export function productIndexable(product: IndexingFacts): boolean {
  if (product.status !== "seeded" && product.status !== "verified") return false;
  if (product.takedownPending) return false;
  const gone = product.repoGone === true;
  const owned = product.source !== "crawler" || product.claimedAt !== null;
  if (owned) return !(product.accessMode !== "website" && gone);
  return product.category !== "Profile" && !gone && product.aiEvidence;
}

/**
 * 처리되지 않은 내려달라는 요청이 있다. takedown_requests 의 열쇠가 slug 라 한 번 찾는다.
 *
 * products 아닌 표의 열은 별칭 글자로 쓴다 — drizzle 관계 조회(findFirst 의 extras)는 SQL 안의 열 객체를 모두
 * 바깥 products 로 바꿔 그린다(repository.ts spamAutoBanned 와 같은 방식).
 */
const takedownPending = sql`exists (select 1 from ${takedownRequests} t where t.slug = ${products.slug} and t.handled_at is null)`;

/**
 * AI 근거 확인(위 4번) — observed-tool.ts·home-pulse.ts 와 같은 "마지막 완료·부분 루트 조사".
 * 한 제품은 crawl_candidates(published_slug 색인) → agent_repository_scans(repository_key 색인) → 관찰(scan_id 색인)로 짚는다.
 * sitemap 처럼 여러 제품을 한꺼번에 가르면 플래너가 근거 있는 slug 집합을 한 번 만들어(hashed subplan) 맞춰 본다 —
 * 'published_slug is not null' 은 그때 발행되지 않은 후보(대부분)를 조사 조회에서 먼저 뺀다. 한 제품일 때는 뜻이 같다.
 */
const confirmedAiEvidence = sql`exists (
  select 1 from ${crawlCandidates} c
  join lateral (
    select s.id from ${agentRepositoryScans} s
     where s.repository_key = lower(c.repo) and s.state in ('complete', 'partial') and s.scope = ''
     order by s.completed_at desc nulls last, s.id desc limit 1
  ) latest on true
  where c.published_slug is not null and c.published_slug = ${products.slug}
    and exists (select 1 from ${agentRepositoryObservations} o where o.scan_id = latest.id and o.facts->>'client' is not null)
)`;

/** productIndexable 에 넘길 두 값을 제품 행과 함께 읽는다 — findFirst({ extras: { ...repoGoneField, ...indexingFields } }) */
export const indexingFields = {
  aiEvidence: sql<boolean>`${confirmedAiEvidence}`.as("ai_evidence"),
  takedownPending: sql<boolean>`${takedownPending}`.as("takedown_pending"),
};

/** 위 규칙의 SQL 판 — products 를 별칭 없이 읽는 쿼리의 where 에 쓴다(sitemap) */
export const indexableProduct = sql`(${products.status} in ('seeded', 'verified')
  and not ${takedownPending}
  and case when ${products.source} <> 'crawler' or ${products.claimedAt} is not null
    then not (${products.accessMode} <> 'website' and ${repoGone})
    else ${products.category} <> 'Profile' and not ${repoGone} and ${confirmedAiEvidence} end)`;

/**
 * sitemap 에 실을 제품 — 주소와 갱신 시각, 등재가 늦은 것부터. 파일 하나에 5만 개까지라(sitemaps.org) limit 을 그 아래로 둔다.
 * 공개 3.7만 건을 훑으며 제품마다 색인 하나씩 짚는다 — 요청마다 부르지 말고 담아 둔 값을 쓴다.
 */
export async function listIndexableSlugs(limit: number): Promise<{ slug: string; updatedAt: Date }[]> {
  return db
    .select({ slug: products.slug, updatedAt: products.updatedAt })
    .from(products)
    .where(indexableProduct)
    .orderBy(desc(sql`coalesce(${products.verifiedAt}, ${products.createdAt})`), products.slug)
    .limit(limit);
}
