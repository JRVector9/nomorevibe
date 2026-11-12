import { z } from "zod";

/**
 * 글 목록(RSS·Atom) 수집원 설정 — 크롤 설정 discover.feeds 의 한 줄(2026-11-12 운영 콘솔 조각 4a, 「수집원 추가」).
 * 순수 모듈이다(zod 만) — 크롤 설정 스키마와 화면이 함께 쓴다. 읽기·파싱은 lib/crawl/feed-sources.ts, 저장은 lib/crawl/feed-source-store.ts.
 *
 * GeekNews Show GN 은 이 목록에 들어가지 않는다 — 첫 수집원으로 코드에 있고(feed-sources.ts SHOW_GN_FEED), 켜짐·우선순위·AI 흔적은
 * 예전처럼 discover.showGn 이 정한다(크롤 설정 화면의 Show GN 줄). 여기는 화면에서 더한 수집원이다.
 */
export const FEED_SOURCES_MAX = 20;
/** 피드를 다시 읽는 주기(분) — 글 목록 작업(gn-show-seed)이 도는 주기보다 짧으면 작업 주기마다 읽는다 */
export const FEED_INTERVAL_MIN_MINUTES = 10;
export const FEED_INTERVAL_MAX_MINUTES = 24 * 60;

const httpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch { return false; }
};
/** class 이름 하나 이상(공백으로 나눔) — 제목 영역·제목 링크 선택자 */
const classList = z.string().trim().min(1).max(80).regex(/^-?[A-Za-z_][\w-]*(?:\s+-?[A-Za-z_][\w-]*)*$/, "class 이름만 적어 주세요");

/** 제품 링크를 찾는 방법 — 글 페이지의 제목 링크(선택자) 또는 피드 항목의 링크 */
export const feedLinkRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page-title"),
    /** 제목 영역(div·section)에 모두 있어야 하는 class */
    titleClass: classList,
    /** 그 영역 안의 제목 링크(a)에 있어야 하는 class */
    linkClass: classList,
    /** 작성자 본문 영역의 id — 제목 링크가 사이트일 때 같은 이름의 저장소를 이 안에서만 찾는다. 없으면 null */
    bodyId: z.string().trim().regex(/^[A-Za-z][\w-]{0,63}$/).nullable(),
  }).strict(),
  z.object({ kind: z.literal("entry-link") }).strict(),
]);
export type FeedLinkRule = z.infer<typeof feedLinkRuleSchema>;
export type FeedPageTitleRule = Extract<FeedLinkRule, { kind: "page-title" }>;

export const feedSourceSchema = z.object({
  /** 고정 열쇠 — 커서(jobs.cursor feeds.<id>)와 감사 줄이 이것을 쓴다 */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
  /** 이름 = 프론티어 signal(40자) — 다른 수집원·검색 신호와 겹치면 저장이 거절한다 */
  name: z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} .:_/-]+$/u, "글자·숫자·공백과 . : _ / - 만 쓸 수 있습니다"),
  url: z.string().trim().max(500).refine(httpUrl, "http(s) 주소를 적어 주세요"),
  /** 고를 글 — 제목이 이 말로 시작(대소문자 무시, 콜론 앞 공백 허용). 비우면 모든 글 */
  titlePrefix: z.string().trim().max(40),
  link: feedLinkRuleSchema,
  intervalMinutes: z.number().int().min(FEED_INTERVAL_MIN_MINUTES).max(FEED_INTERVAL_MAX_MINUTES),
  priority: z.number().int().min(0).max(1000),
  enabled: z.boolean(),
  /** 검색 신호의 requireEvidence 와 같다 — 글 목록 자체는 AI 제작 근거가 아니다 */
  requireEvidence: z.boolean().optional(),
}).strict();
export type FeedSourceConfig = z.infer<typeof feedSourceSchema>;

export const feedSourcesSchema = z.array(feedSourceSchema).max(FEED_SOURCES_MAX).superRefine((rows, context) => {
  const ids = new Set<string>(), names = new Set<string>();
  rows.forEach((row, index) => {
    if (ids.has(row.id)) context.addIssue({ code: "custom", message: "같은 열쇠의 수집원이 둘입니다", path: [index, "id"] });
    const name = row.name.toLowerCase();
    if (names.has(name)) context.addIssue({ code: "custom", message: "같은 이름의 수집원이 둘입니다", path: [index, "name"] });
    ids.add(row.id); names.add(name);
  });
});
