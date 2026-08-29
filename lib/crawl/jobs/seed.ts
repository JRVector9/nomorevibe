import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import * as crawl from "@/lib/crawl/repository";
import { normalizeUrl } from "@/lib/net/normalize";
import { getSettings, enabledQueries } from "@/lib/crawl/settings";
import {
  searchCommits,
  searchRepositories,
  SEARCH_PER_PAGE,
  MAX_SEARCH_PAGES,
  type GitHubFailure,
} from "@/lib/crawl/github";

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
  /** 레포 검색에서 배포 URL로 풀리지 않아 넣지 않은 수 — fetch 예산을 아낀 만큼이다 */
  let skippedNoHomepage = 0;

  for (let visited = 0; visited < settings.discover.pagesPerTick; visited++) {
    if (!ctx.hasBudget()) break;

    const signal = queries[index];
    const result = await searchSignal(signal, since, page, settings.discover.sort);

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

    const repos = [...new Set(result.value.deployed)];
    seen += repos.length;
    skippedNoHomepage += result.value.skipped;
    // builder를 여기서 굳힌다 — 발행 때 설정을 되짚으면 그 사이 바뀐 라벨에 추정이 걸린다
    discovered += await crawl.enqueue(
      repos.map((repo) => ({
        repo,
        signal: signal.label,
        builder: signal.builder,
        priority: signal.priority,
      })),
    );

    /**
     * 페이지가 덜 찼거나 검색이 돌려주는 한계에 닿았으면 이 신호는 여기까지다.
     * 다음 신호로 넘기고, 마지막 신호였으면 사이클을 끝낸다(커서가 비워져 다음 틱은 처음부터).
     */
    const exhausted = result.value.pageSize < SEARCH_PER_PAGE || page >= MAX_SEARCH_PAGES;
    if (exhausted) {
      const next = advance(queries, index);
      if (!next) {
        ctx.log("crawl.seeded", { discovered, seen, skippedNoHomepage, cycle: "완료" });
        return { done: true };
      }
      ({ index, page } = next);
    } else {
      page++;
    }
    await ctx.save({ signal: queries[index].label, page });
  }

  ctx.log("crawl.seeded", { discovered, seen, skippedNoHomepage, signal: queries[index].label, page });
  return { done: false, cursor: { signal: queries[index].label, page } };
}

type SignalPage = {
  /** 프론티어에 넣을 레포. 레포 검색이면 homepage가 URL로 풀리는 것만 */
  deployed: string[];
  /** 배포 URL로 풀리지 않아 뺀 수 */
  skipped: number;
  /** 페이지가 꽉 찼는지 보기 위한 원래 건수 */
  pageSize: number;
};

/**
 * 신호 종류에 맞는 검색을 타고 같은 모양으로 돌려준다.
 *
 * 커밋 검색은 결과에 레포 메타가 없어 그대로 넣는다 — 배포 여부는 fetch가 알아낸다.
 * 레포 검색은 homepage가 실려 오므로 URL로 풀리지 않는 것은 여기서 뺀다. 그 레포는 fetch까지
 * 가도 거부될 뿐이라, 예산만 쓰고 결과가 같다.
 */
async function searchSignal(
  signal: { kind: "commits" | "repositories"; query: string },
  since: string,
  page: number,
  sort: "relevance" | "recent",
): Promise<{ ok: true; value: SignalPage } | { ok: false; error: GitHubFailure }> {
  if (signal.kind === "repositories") {
    const result = await searchRepositories({ query: `${signal.query} pushed:>=${since}`, page, sort });
    if (!result.ok) return result;
    const deployed = result.value.items
      .filter((item) => isDeploymentUrl(item.homepage))
      .map((item) => item.full_name);
    return {
      ok: true,
      value: { deployed, skipped: result.value.items.length - deployed.length, pageSize: result.value.items.length },
    };
  }
  const result = await searchCommits({ query: `${signal.query} committer-date:>=${since}`, page, sort });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      deployed: result.value.items.map((item) => item.repository.full_name),
      skipped: 0,
      pageSize: result.value.items.length,
    },
  };
}

/**
 * homepage가 배포 URL로 풀리는지.
 *
 * GitHub의 homepage는 자유 입력이라 "soon"·"TBD" 같은 값이 온다. 비어 있지 않다는 것만 보면
 * 그런 레포까지 프론티어에 들어가 fetch 예산을 쓰고 닿지 않아 거부된다.
 *
 * 점 없는 호스트를 함께 거른다. normalizeUrl은 스킴이 없으면 https를 붙이므로 "soon"이
 * https://soon으로, "TBD"가 https://tbd로 풀린다 — 형식은 맞지만 공개 도메인이 아니다.
 */
function isDeploymentUrl(homepage: unknown): boolean {
  if (typeof homepage !== "string") return false;
  const normalized = normalizeUrl(homepage);
  return normalized !== null && new URL(normalized).hostname.includes(".");
}

/** 다음 신호로. 마지막이었으면 null (사이클 완료) */
function advance(queries: { label: string }[], index: number): { index: number; page: number } | null {
  return index + 1 < queries.length ? { index: index + 1, page: 1 } : null;
}

/** 최근 N일 이내의 커밋만 본다 — 오래된 레포까지 긁으면 큐가 죽은 프로젝트로 찬다 */
function windowStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
