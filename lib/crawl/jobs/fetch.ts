import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { fetchPage } from "@/lib/net/fetch";
import { normalizeUrl, extractPageMeta } from "@/lib/net/normalize";
import { resolveCanonical } from "@/lib/domain/products/register";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { getRepo } from "@/lib/crawl/github";

/**
 * 수집 잡 — 프론티어에서 꺼낸 레포의 원본을 확보한다.
 *
 * 레포 메타는 가공하지 않고 그대로 보관한다. 판정은 다음 잡이 하고, 기준이 바뀌면 이
 * 원본으로 다시 판정한다 — GitHub을 다시 긁지 않기 위해 둘을 나눠 둔 것이다.
 *
 * 순차로 돈다. 한 틱의 시간 예산 안에서 몇 개를 처리하느냐보다, 실패한 항목이 무엇이고
 * 왜 실패했는지가 지금은 더 중요하다. 처리량이 실제로 병목이면 그때 동시 실행을 올린다.
 */

/** 한 번에 꺼내는 프론티어 항목 수. 예산이 남으면 다음 묶음을 또 꺼낸다 */
const BATCH = 10;

export async function fetchCrawlDocuments(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("crawl.fetch_skipped", { reason: "disabled" });
    return { done: true };
  }

  let fetched = 0;
  let skipped = 0;
  let failed = 0;

  while (ctx.hasBudget()) {
    const entries = await crawl.dequeue(BATCH);
    if (entries.length === 0) {
      ctx.log("crawl.fetched", { fetched, skipped, failed, drained: true });
      return { done: true };
    }

    for (const entry of entries) {
      const result = await getRepo(entry.repo);

      if (!result.ok) {
        if (result.error.kind === "rate_limited") {
          /**
           * 남은 항목은 fetching 상태로 둔 채 물러난다. dequeue가 next_attempt_at이 지난
           * fetching 항목을 회수하므로 다음 틱이 그대로 이어받는다.
           */
          ctx.log("crawl.fetch_rate_limited", {
            fetched,
            resetAt: result.error.resetAt?.toISOString() ?? null,
          });
          return { done: false };
        }
        if (result.error.kind === "not_found") {
          // 지워졌거나 비공개로 바뀌었다 — 다시 시도할 이유가 없다
          await crawl.markFrontier(entry.repo, "skipped");
          skipped++;
          continue;
        }
        const reason = result.error.kind === "http"
          ? `GitHub ${result.error.status}`
          : `GitHub ${result.error.kind}`;
        await crawl.markFailed(entry.repo, reason);
        failed++;
        continue;
      }

      const repoMeta = result.value;
      const homepage = typeof repoMeta.homepage === "string" ? normalizeUrl(repoMeta.homepage) : null;
      const page = homepage ? await visit(homepage, settings.judge.docsGenerators) : null;

      await crawl.putDocument({
        repo: entry.repo,
        repoMeta,
        productUrl: page?.productUrl ?? homepage,
        pageStatus: page?.status ?? null,
        pageMeta: page?.meta ?? null,
      });
      await crawl.markFrontier(entry.repo, "done");
      fetched++;

      if (!ctx.hasBudget()) break;
    }
  }

  ctx.log("crawl.fetched", { fetched, skipped, failed, drained: false });
  return { done: false };
}

/**
 * 배포 URL을 확인한다.
 *
 * 닿지 않으면 상태를 0으로 남긴다. null은 "아직 확인 안 함"이라는 뜻이고, 판정은 그것을
 * 보류(needs_review)로 다룬다 — 확인해서 죽어 있는 것까지 사람에게 보내면 심사 큐가
 * 죽은 링크로 찬다.
 *
 * 리다이렉트로 도메인이 바뀌면 목적지를 기준값으로 삼는다. 메이커가 등록할 때와 같은
 * 기준이어야 "이미 등록된 URL"을 알아볼 수 있다.
 */
async function visit(url: string, docsGenerators: readonly string[]) {
  const page = await fetchPage(url);
  if (!page) return { productUrl: url, status: 0, meta: null };

  const productUrl = resolveCanonical(url, page.finalUrl);
  /**
   * 상대 경로는 실제로 받아온 주소(finalUrl) 기준으로 푼다. 기준값(productUrl)은 같은
   * 호스트 안의 경로 이동을 따라가지 않으므로, example.com → example.com/en/ 같은 경우
   * og:image의 상대 경로가 한 단계 위에서 풀려 404가 된다.
   */
  return {
    productUrl,
    status: page.status,
    meta: extractPageMeta(page.html, page.finalUrl, docsGenerators),
  };
}
