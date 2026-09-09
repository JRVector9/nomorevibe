import { z } from "zod";
import * as crawl from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { fetchCapped, type CappedRequest } from "@/lib/net/fetch";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";

/**
 * Show HN 수집.
 *
 * GitHub 검색은 "레포 → 배포물이 있나?"를 역추적한다. Show HN은 반대다 — 만든 사람이
 * 직접 "배포했습니다" 하고 올린 목록이라, 우리가 찾는 것과 모양이 같다.
 *
 * 실측(2026-09-09, 최근 30일 1,000건): 하루 약 123건이 올라오고 그중 33%인 하루 약 11건이
 * 곧바로 github.com/owner/repo 를 가리킨다. 나머지 67%는 제품 사이트만 있어 레포를 알 수
 * 없다 — 개발에 AI를 썼다는 근거가 GitHub에서 나오므로 레포 없이는 판정할 수 없다.
 * 그래서 URL이 레포를 가리키는 것만 프론티어에 넣는다. 본문·댓글에서 레포를 캐는 것은
 * 게시물마다 요청이 하나 더 들고, 우리가 다루지 않는 남의 글을 읽는 일이라 하지 않는다.
 *
 * 인증이 없고 무료다. 우리 쪽 상한은 아래 상수로만 정한다.
 */
export const SHOW_HN_SIGNAL = "Show HN";
const ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const HITS_PER_PAGE = 100;
/** 한 번도 돈 적이 없을 때 거슬러 올라갈 기간. 알골리아 페이지 상한(1,000건) 안에 든다 */
const FIRST_RUN_LOOKBACK_MS = 7 * 86_400_000;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
/** 알골리아는 page*hitsPerPage < 1000 까지만 넘겨준다 */
const MAX_PAGE = 9;

export type ShowHnCursor = {
  /** 여기까지는 처리했다 (유닉스 초). 다음 조회는 이 시각 이후만 본다 — 다시 읽지 않는다 */
  seenUntil: number;
};

/** 알골리아가 돌려주는 것 중 우리가 쓰는 것만. 모르는 키는 zod가 버린다 */
const responseSchema = z.object({
  hits: z.array(z.object({
    objectID: z.string().max(40),
    created_at_i: z.number().int().positive(),
    url: z.string().max(2000).nullish(),
  })).max(HITS_PER_PAGE),
  nbPages: z.number().int().min(0).default(0),
});

/**
 * GitHub 사용자·조직 아래의 예약 경로. 레포 이름이 아니다.
 * (github.com/sponsors/x 같은 주소가 sponsors/x 라는 레포로 들어가면 안 된다)
 */
const RESERVED = new Set(["sponsors", "features", "about", "pricing", "topics", "collections",
  "trending", "orgs", "login", "settings", "marketplace", "apps", "enterprise", "explore",
  "notifications", "pulls", "issues", "search", "new", "organizations", "users"]);
const GITHUB_REPO = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:[/?#]|$)/i;

/** 제출된 주소가 레포를 가리킬 때만 레포 이름을 낸다. 추측하지 않는다 */
export function repoFromUrl(url: string | null | undefined): string | null {
  const match = GITHUB_REPO.exec(String(url ?? "").trim());
  if (!match) return null;
  const owner = match[1];
  const name = match[2].replace(/\.git$/i, "");
  if (RESERVED.has(owner.toLowerCase())) return null;
  // "." 과 ".." 은 경로이지 이름이 아니다
  if (!name || name === "." || name === "..") return null;
  const repo = `${owner}/${name}`;
  return repo.length <= 200 ? repo : null;
}

function requestUrl(after: number, page: number): string {
  const params = new URLSearchParams({
    tags: "show_hn",
    numericFilters: `created_at_i>${after}`,
    hitsPerPage: String(HITS_PER_PAGE),
    page: String(page),
  });
  return `${ENDPOINT}?${params}`;
}

/**
 * 밀린 것은 오래된 쪽부터 처리한다.
 *
 * 알골리아는 최신순으로만 준다. 밀려 있을 때 첫 페이지(최신)를 처리하고 seenUntil을 최신에
 * 맞추면 그 사이가 통째로 사라진다. 마지막 페이지부터 당기면 seenUntil이 오래된 쪽부터
 * 한 칸씩 올라가므로 끊겨도 건너뛰는 구간이 없다.
 */
export async function seedFromShowHN(ctx: JobContext<ShowHnCursor>, request?: CappedRequest): Promise<JobOutcome<ShowHnCursor>> {
  const settings = await getSettings();
  if (!settings.enabled || !settings.discover.showHn.enabled) return { done: true };

  const seenUntil = ctx.cursor?.seenUntil ?? Math.floor((Date.now() - FIRST_RUN_LOOKBACK_MS) / 1000);

  const probe = await fetchShowHN(requestUrl(seenUntil, 0), request);
  if (!probe.ok) {
    ctx.log("crawl.show_hn_failed", { reason: probe.reason, page: 0 });
    return { done: false, cursor: { seenUntil } };
  }
  if (!probe.value.hits.length) return { done: true, cursor: { seenUntil } };

  const oldestPage = Math.min(Math.max(probe.value.nbPages - 1, 0), MAX_PAGE);
  const page = oldestPage === 0 ? probe.value : await (async () => {
    const result = await fetchShowHN(requestUrl(seenUntil, oldestPage), request);
    return result.ok ? result.value : null;
  })();
  if (!page) {
    ctx.log("crawl.show_hn_failed", { reason: "page_fetch", page: oldestPage });
    return { done: false, cursor: { seenUntil } };
  }

  // 오래된 것부터 넣는다. 도중에 끊겨도 seenUntil 이 처리한 지점까지만 올라간다.
  const items = [...page.hits].sort((a, b) => a.created_at_i - b.created_at_i);
  let cursor: ShowHnCursor = { seenUntil };
  let discovered = 0;
  for (const item of items) {
    if (!ctx.hasBudget()) {
      await ctx.save(cursor);
      return { done: false, cursor };
    }
    const repo = repoFromUrl(item.url);
    if (repo) {
      discovered += await crawl.enqueue([{
        repo, signal: SHOW_HN_SIGNAL, builder: null, priority: settings.discover.showHn.priority,
      }]);
    }
    cursor = { seenUntil: Math.max(cursor.seenUntil, item.created_at_i) };
    await ctx.save(cursor);
  }

  const drained = oldestPage === 0;
  ctx.log("crawl.show_hn_seeded", { discovered, examined: items.length, backlogPages: oldestPage, drained });
  // 훑을 것이 없어도 어디까지 읽었는지는 남긴다 — 잃으면 같은 게시물을 다시 읽는다.
  return { done: drained, cursor };
}

type ShowHnResult =
  | { ok: true; value: z.infer<typeof responseSchema> }
  | { ok: false; reason: string };

async function fetchShowHN(url: string, request?: CappedRequest): Promise<ShowHnResult> {
  const response = await fetchCapped(url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, request });
  if (!response.ok) return { ok: false, reason: response.reason };
  if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
  try {
    const parsed = responseSchema.safeParse(JSON.parse(response.body.toString("utf8")));
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "invalid_response" };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
