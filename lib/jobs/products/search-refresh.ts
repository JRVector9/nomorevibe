import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { SEARCH_PAGE_TEXT_CHARS } from "@/lib/domain/products/search";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";

/**
 * 검색 문서 채우기 — products.search_topics · search_page_text 를 원본과 맞춘다.
 *
 * 토픽(crawl_documents.repo_meta->'topics')과 배포 페이지 본문(page_meta->>'textSample')은
 * products 에 없다. 생성 컬럼 search_vector 는 같은 행만 볼 수 있어 저 둘을 옮겨 적어야 하고,
 * 옮겨 적은 값은 원본이 바뀌면 낡는다. 원본이 바뀌는 곳은 재수집(saveFetchedDocument)과
 * 생존 확인(refreshTextSample)이다 — 둘 다 products 를 건드리지 않는다.
 *
 * 이미 올라와 있는 것도 이 잡이 채운다. 프로드 발행분 10,751건 중 74%가 본문을 갖고 있는데
 * 검색이 한 번도 읽지 않았다(2026-09-18). 그 본문을 넣자 "회의록 요약" 0→32건,
 * "배경 제거" 1→62건, "코드 리뷰" 140→1,459건이 됐다.
 *
 * 커서가 없다. 낡은 행만 골라 고치므로 고칠수록 대상이 줄고, 다 고치면 매 틱이 조인 한 번으로
 * 끝난다 — 커서를 두면 바뀐 것이 없어도 표 전체를 계속 돈다.
 */

/** 한 틱에 고칠 수. 10,751건을 처음 채울 때 11틱(약 11분)이면 끝난다 */
const BATCH = 1_000;

/** 토픽을 공백으로 이은 글. 토픽이 없으면 null — 발행(publish.ts)이 넣는 값과 같은 모양이다 */
const TOPICS = sql`case when jsonb_typeof(d.repo_meta -> 'topics') = 'array'
  then (select string_agg(topic, ' ') from jsonb_array_elements_text(d.repo_meta -> 'topics') as t(topic))
  else null end`;

const PAGE_TEXT = sql`left(d.page_meta ->> 'textSample', ${SEARCH_PAGE_TEXT_CHARS})`;

export async function refreshProductSearchDocuments(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const rows = await db.execute<{ slug: string }>(sql`
    with stale as (
      select p.id, ${TOPICS} as topics, ${PAGE_TEXT} as page_text
        from products p
        join crawl_candidates c on c.published_slug = p.slug
        join crawl_documents d on d.repo = c.repo
       where p.search_topics is distinct from ${TOPICS}
          or p.search_page_text is distinct from ${PAGE_TEXT}
       order by p.id
       limit ${BATCH}
    )
    update products p
       set search_topics = stale.topics, search_page_text = stale.page_text
      from stale
     where p.id = stale.id
    returning p.slug`);

  const updated = [...rows].length;
  ctx.log("product_search.refreshed", { updated });
  return { done: updated < BATCH };
}
