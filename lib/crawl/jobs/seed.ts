import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, enabledQueries } from "@/lib/crawl/settings";
import { searchCommits, SEARCH_PER_PAGE, MAX_SEARCH_PAGES } from "@/lib/crawl/github";

/**
 * 검색 잡 — 프론티어를 채운다. 파이프라인의 입구다.
 *
 * 신호(검색어)를 하나씩, 페이지를 하나씩 넘기며 본 위치를 커서에 남긴다. 검색은 분당
 * 30회로 묶여 있어 한 틱에 다 볼 수 없고, 애초에 다 볼 필요도 없다 — 다음 틱이 이어받는다.
 *
 * 재귀 크롤이 아니다. 프론티어는 여기서만 채워지고 가져온 문서에서 새 링크를 뽑아
 * 확장하지 않는다. 그래서 URL 정규화 폭발도 스팸 트랩도 없다.
 */

export type SeedCursor = {
  /** 보고 있던 신호의 label */
  signal: string;
  /** 다음에 볼 페이지 (1부터) */
  page: number;
};

export async function seedFrontier(ctx: JobContext<SeedCursor>): Promise<JobOutcome<SeedCursor>> {
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("crawl.seed_skipped", { reason: "disabled" });
    return { done: true };
  }

  const queries = enabledQueries(settings);
  if (queries.length === 0) {
    ctx.log("crawl.seed_skipped", { reason: "no_signals" });
    return { done: true };
  }

  /**
   * 커서가 가리키던 신호가 사라졌으면(꺼졌거나 지워졌으면) 처음부터 본다.
   * 없어진 이름을 붙들고 있으면 그 사이클은 아무것도 안 하고 끝난다.
   */
  const resumed = queries.findIndex((q) => q.label === ctx.cursor?.signal);
  let index = resumed === -1 ? 0 : resumed;
  let page = resumed === -1 ? 1 : (ctx.cursor?.page ?? 1);

  const since = windowStart(settings.discover.windowDays);
  let discovered = 0;
  let seen = 0;

  for (let visited = 0; visited < settings.discover.pagesPerTick; visited++) {
    if (!ctx.hasBudget()) break;

    const signal = queries[index];
    const result = await searchCommits({
      query: `${signal.query} committer-date:>=${since}`,
      page,
      sort: settings.discover.sort,
    });

    if (!result.ok) {
      if (result.error.kind === "rate_limited") {
        // 본 데까지만 남기고 물러난다 — 다음 틱이 같은 페이지부터 이어받는다
        ctx.log("crawl.seed_rate_limited", { signal: signal.label, page, discovered });
        return { done: false, cursor: { signal: signal.label, page } };
      }
      // 검색 자체가 실패하면 이 신호는 이번 사이클에 건너뛴다. 커서는 다음 신호를 가리킨다
      ctx.log("crawl.seed_failed", { signal: signal.label, page, error: result.error });
      const next = advance(queries, index);
      if (!next) return { done: true };
      ({ index, page } = next);
      await ctx.save({ signal: queries[index].label, page });
      continue;
    }

    const repos = [...new Set(result.value.items.map((item) => item.repository.full_name))];
    seen += repos.length;
    discovered += await crawl.enqueue(
      repos.map((repo) => ({ repo, signal: signal.label, priority: signal.priority })),
    );

    /**
     * 페이지가 덜 찼거나 검색이 돌려주는 한계에 닿았으면 이 신호는 여기까지다.
     * 다음 신호로 넘기고, 마지막 신호였으면 사이클을 끝낸다(커서가 비워져 다음 틱은 처음부터).
     */
    const exhausted = result.value.items.length < SEARCH_PER_PAGE || page >= MAX_SEARCH_PAGES;
    if (exhausted) {
      const next = advance(queries, index);
      if (!next) {
        ctx.log("crawl.seeded", { discovered, seen, cycle: "완료" });
        return { done: true };
      }
      ({ index, page } = next);
    } else {
      page++;
    }
    await ctx.save({ signal: queries[index].label, page });
  }

  ctx.log("crawl.seeded", { discovered, seen, signal: queries[index].label, page });
  return { done: false, cursor: { signal: queries[index].label, page } };
}

/** 다음 신호로. 마지막이었으면 null (사이클 완료) */
function advance(queries: { label: string }[], index: number): { index: number; page: number } | null {
  return index + 1 < queries.length ? { index: index + 1, page: 1 } : null;
}

/** 최근 N일 이내의 커밋만 본다 — 오래된 레포까지 긁으면 큐가 죽은 프로젝트로 찬다 */
function windowStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
