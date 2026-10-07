import type { JobContext, JobOutcome } from "./runner";
import { seedFrontier } from "@/lib/crawl/jobs/seed";
import { seedFromShowHN } from "@/lib/crawl/jobs/hn-show";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
import { judgeCrawlDocuments } from "@/lib/crawl/jobs/judge";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";
import { checkGrokSession } from "@/lib/crawl/jobs/grok-session";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import { auditSearchHealth } from "@/lib/jobs/products/search-health";
import { refreshPublishedReadmes } from "@/lib/jobs/products/readme-refresh";
import { checkProductIntros } from "@/lib/jobs/products/intro-check";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { purgeRemovedProducts } from "@/lib/jobs/products/cdn-purge";
import { pingProducts } from "@/lib/jobs/products/uptime";
import { rollupClicks } from "@/lib/jobs/products/click-rollup";
import { refreshRankings } from "@/lib/jobs/products/ranking-refresh";
import { refreshAgentEvidenceJob } from "@/lib/jobs/products/agent-evidence-refresh";
import { refreshProductEvidenceJob } from "@/lib/jobs/products/evidence-refresh";
import { refreshProductStars } from "@/lib/jobs/products/stars-refresh";
import { refreshProductThumbnails } from "@/lib/jobs/products/thumbnail-refresh";
import { refreshProductSearchDocuments } from "@/lib/jobs/products/search-refresh";
import { refreshProductEmbeddings } from "@/lib/jobs/products/embedding-refresh";
import { refreshNews } from "@/lib/news/refresh";

/**
 * 이름 → 작업 매핑.
 *
 * 진입점(HTTP cron, CLI)이 이 목록만 보고 실행한다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 작업마다 커서 타입이 다르다
export type AnyJob = (ctx: JobContext<any>) => Promise<JobOutcome<any>>;

export const JOBS: Record<string, AnyJob> = {
  /**
   * 러너와 스케줄러 연결이 살아 있는지 확인하는 작업.
   * 실행될 때마다 카운터를 올리므로, 커서가 늘고 있으면 스케줄이 도는 것이다.
   */
  heartbeat: async (ctx) => {
    const count = ((ctx.cursor as { count?: number } | null)?.count ?? 0) + 1;
    await ctx.save({ count });
    ctx.log("heartbeat.tick", { count });
    return { done: false, cursor: { count } };
  },

  /** GitHub 검색으로 프론티어를 채운다 — 파이프라인의 입구 */
  "crawl-seed": seedFrontier,

  /** Show HN에서 배포를 알린 프로젝트를 프론티어에 넣는다 — 반대 방향의 입구 */
  "hn-show-seed": seedFromShowHN,

  /** 프론티어에서 꺼낸 레포의 원본(레포 메타 + 배포 페이지)을 확보한다 */
  "crawl-fetch": fetchCrawlDocuments,

  /** 수집한 원본에 현재 기준을 적용해 후보로 남긴다 */
  "crawl-judge": judgeCrawlDocuments,
  "crawl-agent-review": reviewCrawlCandidates,
  /** 1차와 다른 모델이 같은 입력을 따로 본다 — 엇갈리면 사람에게 */
  "second-review": secondReviewCandidates,
  /** 공개된 제품을 1차 심사 글로 다시 본다 — 찾아 적기만 하고, 내리는 것은 사람이다 */
  "product-audit": auditPublishedProducts,

  /** 통과한 후보를 seeded 제품으로 목록에 올린다 */
  "crawl-publish": publishCandidates,
  /** 내려간 제품의 Cloudflare 사본(상세·썸네일·목록)을 지운다 */
  "cdn-purge": (ctx) => purgeRemovedProducts(ctx),
  /** 심사 화면의 영어 사유를 미리 한국어로 옮겨 둔다 */
  "reason-translate": translateReasons,
  /** 소개가 없어 멈춘 후보의 한 줄 소개를 짓는다 — 목록에는 지은 것이라고 밝히고 올린다 */
  "crawl-tagline": writeTaglines,
  /** 공개 제품마다 한·영 검색 키워드를 적는다 */
  "product-search-profile": writeSearchProfiles,
  "product-search-verify": (ctx) => verifySearchKeywords(ctx),
  /** 공개 제품의 글을 의미 검색용 벡터로 바꿔 둔다 */
  "product-embedding": (ctx) => refreshProductEmbeddings(ctx),
  "product-search-health": auditSearchHealth,
  "product-readme-refresh": refreshPublishedReadmes,
  "product-intro-check": (ctx) => checkProductIntros(ctx),
  /** Grok 로그인 파일이 살아 있는지 — 짧은 호출 하나로 토큰을 갱신하고 관측에 남긴다 */
  "grok-session-check": (ctx) => checkGrokSession(ctx),

  /** 등재된 제품이 아직 떠 있는지 확인한다 (기록만 하고 목록은 건드리지 않는다) */
  "uptime-ping": pingProducts,

  /** 클릭 원천을 하루 단위로 굴리고 오래된 원천을 지운다 */
  "click-rollup": rollupClicks,

  /** 시즌 경계를 처리하고 공개 랭킹 스냅샷을 갱신한다 */
  "ranking-refresh": refreshRankings,

  /** 외부 근거와 내부 미디어를 bounded batch로 갱신한다 */
  "product-evidence-refresh": refreshProductEvidenceJob,
  "agent-evidence-refresh": refreshAgentEvidenceJob,
  "product-stars-refresh": refreshProductStars,
  "product-thumbnail-refresh": refreshProductThumbnails,
  /** 검색이 읽는 토픽·본문을 crawl_documents 와 맞춘다 */
  "product-search-refresh": refreshProductSearchDocuments,

  /** 회사 공식 피드에서 AI 소식을 모은다 — 제품 파이프라인과 따로 돈다 */
  "news-refresh": (ctx) => refreshNews(ctx),
};

export { JOB_NAMES } from "./catalog";
