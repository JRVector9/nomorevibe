import { z } from "zod";

/**
 * 크롤 기준.
 *
 * 코드 상수가 아니라 데이터다. 어드민 화면에서 바꿀 수 있어야 하고, 바꾼 뒤 재배포 없이
 * 곧바로 적용돼야 한다. 원본(crawl_documents)을 보관하므로 판정 기준을 바꾸면
 * GitHub을 다시 긁지 않고 재판정된다 — 기준을 실험하는 비용이 거의 없다.
 *
 * 필터를 추가할 때는 이 스키마에 필드 하나와 기본값만 넣으면 된다. 마이그레이션은 없다
 * (jsonb 한 컬럼에 담기므로). 어드민 폼 검증도 같은 스키마를 쓴다.
 */

/** GitHub 검색 정렬. 표본 분포를 크게 바꾼다 */
export const searchSortSchema = z.enum(["relevance", "recent"]).describe(
  // 실측: 같은 100건에서 고유 레포가 relevance 63개 vs recent 2개.
  // recent는 방금 활발히 커밋한 소수 레포에 몰린다.
  "relevance는 레포가 넓게 흩어지고, recent는 최신 활동에 몰린다",
);

const discoverSchema = z.object({
  /** 켜져 있는 검색 신호. 신호별 수율을 비교하려면 개별로 끌 수 있어야 한다 */
  queries: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        /** GitHub 검색 문자열 */
        query: z.string().min(1).max(200),
        enabled: z.boolean(),
        /** 이 신호로 발견한 레포의 조사 우선순위 */
        priority: z.number().int().min(0).max(1000),
      }),
    )
    .min(1),
  /** 최근 N일 이내의 커밋만 본다 */
  windowDays: z.number().int().min(1).max(3650),
  sort: searchSortSchema,
  /** 한 틱에 볼 검색 페이지 수. rate limit(30회/분)을 고려해 낮게 유지한다 */
  pagesPerTick: z.number().int().min(1).max(10),
});

const judgeSchema = z.object({
  /**
   * 스타 상한. 넘으면 개인이 AI로 만든 제품이 아니라고 본다.
   * 하한이 아니라 상한인 것이 요지다 — 갓 배포한 제품은 정당하게 스타가 0개이므로
   * 하한을 두면 우리가 찾으려는 것부터 걸러진다.
   */
  maxStars: z.number().int().min(0).max(1_000_000),
  /** 하한. 0이 기본이다 */
  minStars: z.number().int().min(0).max(100_000),
  /** 마지막 푸시가 이보다 오래되면 죽은 프로젝트로 본다 */
  maxPushAgeDays: z.number().int().min(1).max(3650),
  excludeForks: z.boolean(),
  /** 조직 계정 레포를 제외할지. 개인이 조직 계정을 쓰는 경우도 있어 놓치는 것이 생긴다 */
  excludeOrganizations: z.boolean(),
  /** homepage가 이 도메인이면 배포물이 아니다 */
  blockedHomepageDomains: z.array(z.string().min(1).max(120)).max(200),
  /** 레포 이름이 이 패턴이면 제외 (* 와일드카드) */
  excludedRepoPatterns: z.array(z.string().min(1).max(120)).max(200),
  /** 규칙으로 못 가르면 needs_review로 보류할지, 그냥 거부할지 */
  holdAmbiguous: z.boolean(),
});

export const crawlSettingsSchema = z.object({
  /** 수집 자체를 멈추는 스위치. 무언가 잘못 돌 때 배포 없이 끊을 수 있어야 한다 */
  enabled: z.boolean(),
  discover: discoverSchema,
  judge: judgeSchema,
});

export type CrawlSettings = z.infer<typeof crawlSettingsSchema>;

/** 기본값. 실측을 근거로 잡았다 (수율 42%, 노이즈는 대형 OSS와 개인 홈페이지) */
export const DEFAULT_CRAWL_SETTINGS: CrawlSettings = {
  enabled: false, // 켜는 것은 명시적 행위여야 한다
  discover: {
    queries: [
      { label: "Claude 커밋 트레일러", query: "Co-authored-by: Claude", enabled: true, priority: 100 },
      { label: "Codex 커밋 트레일러", query: "Co-authored-by: Codex", enabled: false, priority: 90 },
    ],
    windowDays: 180,
    sort: "relevance",
    pagesPerTick: 2,
  },
  judge: {
    maxStars: 1000,
    minStars: 0,
    maxPushAgeDays: 180,
    excludeForks: true,
    excludeOrganizations: true,
    blockedHomepageDomains: [
      "github.com",
      "instagram.com",
      "x.com",
      "twitter.com",
      "linkedin.com",
      "medium.com",
      "notion.site",
      "youtube.com",
      "discord.gg",
      // 패키지·모드 등록처. 배포물이 아니라 배포물의 등록 페이지다 (실데이터에서 넷 다 나왔다)
      "npmjs.com",
      "crates.io",
      "modrinth.com",
      "pypi.org",
    ],
    excludedRepoPatterns: [
      "*.github.io",
      "dotfiles",
      "awesome-*",
      "*-portfolio",
      "*-blog",
      "*-resume",
      "*-personal-site",
      "*-personal-website",
    ],
    holdAmbiguous: true,
  },
};
