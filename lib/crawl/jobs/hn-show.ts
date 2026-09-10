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
const REACHABLE_HITS = (MAX_PAGE + 1) * HITS_PER_PAGE;

export type ShowHnCursor = {
  /**
   * 이 초보다 앞선 게시물은 모두 처리했다 (유닉스 초). 다음 조회는 이 초부터 다시 본다.
   * 같은 초의 게시물이 중단이나 페이지 경계로 갈라지면, "이 초 이후"만 보는 조회는 남은 것을
   * 영영 건너뛴다. 그래서 경계 초는 다시 읽고 seenIds 로 거른다.
   */
  seenUntil: number;
  /** seenUntil 초에 올라와 이미 처리한 게시물 ID. 경계 초를 다시 읽을 때 이것만 거른다 */
  seenIds?: string[];
  /**
   * 밀린 것이 1,000건을 넘어 반으로 나눈 구간의 끝 (유닉스 초, 포함).
   * 알골리아는 최신 1,000건까지만 넘겨주므로, 나누지 않으면 가장 오래된 쪽을 읽을 방법이 없다.
   * 이 끝까지 다 읽어야 구간을 확정하고 비운다.
   */
  windowTo?: number;
};

/** 알골리아가 돌려주는 것 중 우리가 쓰는 것만. 모르는 키는 zod가 버린다 */
const responseSchema = z.object({
  hits: z.array(z.object({
    objectID: z.string().max(40),
    created_at_i: z.number().int().positive(),
    url: z.string().max(2000).nullish(),
  })).max(HITS_PER_PAGE),
  nbPages: z.number().int().min(0).default(0),
  nbHits: z.number().int().min(0).optional(),
});
type ShowHnPage = z.infer<typeof responseSchema>;

/**
 * 조회 결과가 1,000건을 넘어 가장 오래된 쪽이 페이지 밖에 있는가.
 * nbPages 는 상한(10)에서 멈추므로 nbHits 로 판단하고, 없으면 상한에 닿았는지로 본다.
 */
const overflows = (page: ShowHnPage) => page.nbHits !== undefined ? page.nbHits > REACHABLE_HITS : page.nbPages > MAX_PAGE;
const processed = (cursor: ShowHnCursor, item: ShowHnPage["hits"][number]) =>
  item.created_at_i < cursor.seenUntil || item.created_at_i === cursor.seenUntil && (cursor.seenIds ?? []).includes(item.objectID);

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

function requestUrl(cursor: ShowHnCursor, page: number): string {
  const filters = [`created_at_i>=${cursor.seenUntil}`];
  if (cursor.windowTo !== undefined) filters.push(`created_at_i<=${cursor.windowTo}`);
  const params = new URLSearchParams({
    tags: "show_hn",
    // 쉼표로 이은 조건은 모두 만족해야 한다
    numericFilters: filters.join(","),
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
 *
 * 다만 마지막 페이지가 가장 오래된 것을 담으려면 결과가 1,000건 안이어야 한다. 넘치면
 * 구간을 반으로 나눠 오래된 쪽부터 읽는다 (GitHub 검색 창을 나누는 것과 같은 이유다).
 */
export async function seedFromShowHN(ctx: JobContext<ShowHnCursor>, request?: CappedRequest): Promise<JobOutcome<ShowHnCursor>> {
  const settings = await getSettings();
  if (!settings.enabled || !settings.discover.showHn.enabled) return { done: true };

  let cursor: ShowHnCursor = ctx.cursor ?? { seenUntil: Math.floor((Date.now() - FIRST_RUN_LOOKBACK_MS) / 1000) };

  let probe: ShowHnPage;
  for (;;) {
    const result = await fetchShowHN(requestUrl(cursor, 0), request);
    if (!result.ok) {
      ctx.log("crawl.show_hn_failed", { reason: result.reason, page: 0 });
      return { done: false, cursor };
    }
    probe = result.value;
    const upper = cursor.windowTo ?? Math.max(cursor.seenUntil, ...probe.hits.map((hit) => hit.created_at_i));
    // 한 초에 1,000건이 몰리면 더 나눌 수 없다. 그때는 읽을 수 있는 만큼 읽는다.
    if (!overflows(probe) || upper <= cursor.seenUntil) break;
    cursor = { ...cursor, windowTo: Math.floor((cursor.seenUntil + upper) / 2) };
    // 나눈 것도 진행이다. 끊겨도 다음 틱이 같은 구간을 다시 나누지 않게 남긴다.
    await ctx.save(cursor);
    if (!ctx.hasBudget()) return { done: false, cursor };
  }

  let discovered = 0;
  let examined = 0;
  const lastPage = Math.min(Math.max(probe.nbPages - 1, 0), MAX_PAGE);
  for (let number = lastPage; number >= 0; number--) {
    const result = number === 0 ? { ok: true as const, value: probe } : await fetchShowHN(requestUrl(cursor, number), request);
    if (!result.ok) {
      ctx.log("crawl.show_hn_failed", { reason: "page_fetch", page: number });
      return { done: false, cursor };
    }
    // 첫 조회와 지금 사이에 글이 올라오거나 지워지면 페이지가 밀린다. 이 페이지가 가장 오래된
    // 것이라는 보장이 없으므로 커서를 올리지 않고 다음 틱에 다시 센다.
    if (result.value.nbPages !== probe.nbPages || result.value.nbHits !== probe.nbHits) {
      ctx.log("crawl.show_hn_shifted", { page: number });
      return { done: false, cursor };
    }

    // 오래된 것부터 넣는다. 도중에 끊겨도 커서는 처리한 게시물까지만 올라간다.
    const items = [...result.value.hits].sort((a, b) => a.created_at_i - b.created_at_i).filter((item) => !processed(cursor, item));
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
      cursor = item.created_at_i > cursor.seenUntil
        ? { ...cursor, seenUntil: item.created_at_i, seenIds: [item.objectID] }
        : { ...cursor, seenIds: [...(cursor.seenIds ?? []), item.objectID] };
      await ctx.save(cursor);
    }
    examined += items.length;
    // 새로 넣은 것이 있으면 이번 틱은 여기까지다. 이미 본 경계 초의 글뿐인 페이지였다면 한 칸
    // 새로운 페이지로 간다 — 그대로 끝내면 다음 틱도 같은 페이지만 읽고 제자리에 머문다.
    if (items.length && number > 0) {
      ctx.log("crawl.show_hn_seeded", { discovered, examined, backlogPages: number, drained: false });
      return { done: false, cursor };
    }
  }

  // 0페이지까지 읽었다 — 이 구간에 남은 글이 없다.
  if (cursor.windowTo !== undefined) {
    cursor = { seenUntil: cursor.windowTo + 1 };
    await ctx.save(cursor);
    ctx.log("crawl.show_hn_seeded", { discovered, examined, backlogPages: 0, drained: false });
    return { done: false, cursor };
  }
  ctx.log("crawl.show_hn_seeded", { discovered, examined, backlogPages: 0, drained: true });
  // 훑을 것이 없어도 어디까지 읽었는지는 남긴다 — 잃으면 같은 게시물을 다시 읽는다.
  return { done: true, cursor };
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
