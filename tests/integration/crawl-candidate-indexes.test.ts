import { sql, type SQL } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ensureSchema } from './setup';

/**
 * 후보를 찾는 실제 조건이 인덱스를 탄다.
 *
 * published_slug 로 찾는 조회(lib/crawl/repository.ts refreshTextSample, lib/domain/products/recheck.ts)와
 * 상태로 거른 뒤 id 순으로 넘기는 조회(lib/crawl/admin-review.ts 심사 화면·갈래 집계)가 표를 통째로 훑지 않는지.
 * 운영과 비슷한 비율(발행 3%·보류 5%)로 채워 계획만 보고 전부 되돌린다.
 */
beforeAll(() => ensureSchema());

class Rollback extends Error {}

async function plans(queries: Record<string, SQL>): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`
        insert into crawl_candidates (repo, state, published_slug)
        select 'index-fixture/repo-' || g,
               case when g % 33 = 0 then 'published' when g % 20 = 0 then 'needs_review' else 'rejected' end,
               case when g % 33 = 0 then 'index-fixture-' || g end
          from generate_series(1, 20000) g`);
      await tx.execute(sql`analyze crawl_candidates`);
      for (const [label, query] of Object.entries(queries)) {
        const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain (costs off) ${query}`);
        result[label] = rows.map(row => row['QUERY PLAN']).join('\n');
      }
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result;
}

it('발행 slug 로 후보를 찾는 조회와 상태별 id 순 조회가 새 인덱스를 쓴다', async () => {
  const result = await plans({
    slug: sql`select repo from crawl_candidates where published_slug = ${'index-fixture-330'}`,
    queue: sql`select * from crawl_candidates where state = ${'needs_review'} and id > ${100} order by id asc limit 51`,
  });
  expect(result.slug).toContain('crawl_candidates_published_slug_idx');
  expect(result.queue).toContain('crawl_candidates_state_id_idx');
});
