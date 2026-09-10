/**
 * 발행분의 본문 글자를 채운다.
 *
 * 판정이 본문을 보게 됐는데(설치 유도 아님) 이미 발행된 것들은 그 값이 없던 시절에
 * 수집됐다. 생존 확인이 채우기는 하지만 시간당 900건이라 3천 건이면 3시간 반이 걸린다
 * — 기준을 고친 직후에 결과를 봐야 할 때는 그것도 늦다. 이 스크립트는 수 분에 끝난다.
 *
 * GitHub은 건드리지 않는다. 배포 주소만 열어 본문을 담는다 — API 쿼터를 쓰지 않고
 * 레포 메타도 그대로 둔다. 판정에 필요한 것은 본문뿐이다.
 *
 *   tsx --env-file=.env.local scripts/backfill-text-sample.ts            (몇 건인지만 센다)
 *   tsx --env-file=.env.local scripts/backfill-text-sample.ts --apply
 */
import { parseArgs } from "node:util";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, crawlCandidates, crawlDocuments } from "@/lib/db/schema";
import { fetchPage } from "@/lib/net/fetch";
import { extractTextSample, metaRefreshTarget } from "@/lib/net/normalize";
import { refreshTextSample } from "@/lib/crawl/repository";

/** 동시에 여는 수. 남의 서버를 두드리는 일이라 크게 벌리지 않는다 */
const CONCURRENCY = 6;

type Target = { slug: string; url: string };

async function pending(limit: number): Promise<Target[]> {
  return db
    .select({ slug: products.slug, url: crawlDocuments.productUrl })
    .from(products)
    .innerJoin(crawlCandidates, eq(crawlCandidates.publishedSlug, products.slug))
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(
      inArray(products.status, ["verified", "seeded"]),
      isNotNull(crawlDocuments.productUrl),
      sql`${crawlDocuments.pageMeta} ->> 'textSample' is null`,
    ))
    .orderBy(asc(products.slug))
    .limit(limit) as Promise<Target[]>;
}

/** 수집 잡과 같은 규칙으로 연다 — meta refresh 한 번 따라가고 본문을 뽑는다 */
async function sampleOf(url: string): Promise<string | null> {
  let page = await fetchPage(url, "background");
  if (!page) return null;
  const hop = metaRefreshTarget(page.html, page.finalUrl);
  if (hop) page = (await fetchPage(hop, "background")) ?? page;
  return extractTextSample(page.html);
}

async function main() {
  const { values } = parseArgs({ options: {
    apply: { type: "boolean", default: false },
    limit: { type: "string", default: "5000" },
  } });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");

  const targets = await pending(limit);
  console.log(`본문 없는 발행분 ${targets.length}건`);
  if (!values.apply) {
    console.log("--apply 를 붙이면 채웁니다. 지금은 세기만 했습니다.");
    return;
  }

  let filled = 0;
  let failed = 0;
  const queue = [...targets];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const target = queue.shift();
      if (!target) return;
      try {
        const sample = await sampleOf(target.url);
        if (sample) {
          await refreshTextSample(target.slug, sample);
          filled += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
      const done = filled + failed;
      if (done % 100 === 0) console.log(`  ${done}/${targets.length} · 채움 ${filled} · 실패 ${failed}`);
    }
  }));

  console.log(`끝. 채움 ${filled}건 · 열지 못함 ${failed}건`);
  console.log("열지 못한 것은 그대로 남습니다 — 생존 확인이 다음 바퀴에 다시 시도합니다.");
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
