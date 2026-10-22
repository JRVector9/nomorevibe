/** Metadata only: importing this from the web must not load executable collectors. */
export type JobRole = "crawler" | "reviewer" | "publisher" | "text" | "maintenance";
export const JOB_ROLES: readonly JobRole[] = ["crawler", "reviewer", "publisher", "text", "maintenance"];
export type CatalogRole = JobRole | "scheduler" | "site-evidence";

/**
 * lane: 같은 역할 워커 안에서 따로 도는 줄. 역할 lease 는 하나라 워커를 늘려도 한 대만 일한다 — 줄이 다르면 한 프로세스 안에서
 * 동시에 돈다. 줄을 적지 않은 잡은 기본 줄(main)에서 차례로 돈다(scripts/worker.ts runWorker).
 */
export type JobLane = "main" | "sources" | "evidence" | "scan" | "stars" | "screen";
export const JOB_CATALOG: readonly { name: string; role: CatalogRole; intervalMs: number | null; lane?: JobLane; batchVersion?: 1 }[] = [
  { name: "heartbeat", role: "scheduler", intervalMs: null },
  /**
   * 검색 쿼터는 토큰 단위(30회/분 = 시간당 1,800페이지)라 워커를 늘려도 늘지 않는다.
   * 병목은 이 주기였다 — 15분 × 10페이지면 시간당 40페이지로 허용량의 2.2%만 썼다.
   * 3분으로 당겼더니 하루 5천 건이 들어와 1,287건이 자동 발행됐다 — 사람이 품질을 볼
   * 겨를이 없었다. 수집 속도는 발행 속도이기도 하다. 10분으로 되돌린다.
   */
  { name: "crawl-seed", role: "crawler", intervalMs: 10 * 60_000 },
  // 하루 약 123건이 올라온다. 30분이면 한 번에 100건 상한에 걸릴 일이 없다.
  { name: "hn-show-seed", role: "crawler", intervalMs: 30 * 60_000 },
  // HN 화제 글 기록 — 최근 72시간·10점 이상 GitHub 글을 한두 요청으로 다시 읽는다(lib/social/hn-talk.ts)
  { name: "hn-talk", role: "crawler", intervalMs: 30 * 60_000 },
  /**
   * Bluesky 화제 글 기록 — 최근 72시간 GitHub 링크 게시물을 모두 남긴다(lib/social/bluesky-talk.ts). 회차당 요청 30번까지·0.5초 간격,
   * 보통 새 글 1~2 + 반응 큰 글 3 + 다시 묻기 12 = 20번 안팎이다. 2시간마다(2026-10-22 사용자 결정 — 30분에서 늘림): 2시간 사이 새 글은
   * 보통 첫 쪽(100건) 안팎이고, 다시 묻기 300건이면 72시간 창의 글을 8시간 안팎에 한 번씩 다시 본다(공개 24시간 창 안)
   */
  { name: "bluesky-talk", role: "crawler", intervalMs: 2 * 60 * 60_000 },
  { name: "crawl-fetch", role: "crawler", intervalMs: 60_000 },
  { name: "crawl-judge", role: "reviewer", intervalMs: 5 * 60_000 },
  { name: "crawl-agent-review", role: "reviewer", intervalMs: 60_000 },
  // 2차 심사 — 1차와 다른 모델. 하루 수십~백여 건이라 5분이면 밀리지 않는다
  { name: "second-review", role: "reviewer", intervalMs: 60_000 },
  { name: "human-deepseek-review", role: "reviewer", intervalMs: 60_000 },
  /**
   * 발행분 감사 — 사람이 연 감사가 있을 때만 일한다. reviewer 에 둔 까닭은 잡이 역할 안에서
   * 차례로 돌기 때문이다(scripts/worker.ts). 1차 심사와 번갈아 돌 뿐 겹치지 않아, 공유 게이트웨이의
   * 동시 호출이 늘지 않는다. 새 후보가 기다리면 틱마다 먼저 양보한다(lib/crawl/jobs/product-audit.ts).
   */
  { name: "product-audit", role: "reviewer", intervalMs: 60_000 },
  /**
   * 화면 판별 — 글이 얇은(JS 로 그리는) 감사 거절을 화면 서버(m1-studio)로 그려 m1 Qwen 에 글+첫 화면으로 묻는다(lib/screen-review/job.ts).
   * 한 건이 그리기 수~40초 + 묻기 12~90초라 따로 도는 줄(screen)에 둔다 — 기본 줄의 심사·감사를 막지 않는다. 설정 qwenAuto.screenReview 를 켜야 일한다
   */
  { name: "audit-screen-review", role: "reviewer", intervalMs: 60_000, lane: "screen" },
  { name: "crawl-publish", role: "publisher", intervalMs: 5 * 60_000 },
  /**
   * 내려간 제품을 Cloudflare 에서 지운다(cdn_purges). 발행 워커는 5분마다 한 번 도는 잡뿐이라 한가하고,
   * 1분마다 한 요청이면 Free 요금제의 태그 지우기 한도(계정 전체 분당 5회)를 넘지 않는다.
   */
  { name: "cdn-purge", role: "publisher", intervalMs: 60_000 },
  // 사용자 동의와 제품별 binding을 확인한 outbox만 처리한다. 기본 플래그는 꺼져 있다.
  { name: "github-feedback-delivery", role: "publisher", intervalMs: 60_000 },
  // 사유 번역 — 전용 text 워커에서 1분마다 옮긴다(틱 55초, 한 번에 4건·1,600자까지)
  { name: "reason-translate", role: "text", intervalMs: 60_000 },
  /**
   * 소개 짓기 — 소개가 없어 멈춘 후보의 한 줄을 모델이 짓는다. 번역과 같은 자리(text 워커)에서
   * 1분마다 조금씩. 대기가 비면 곧 끝나고, 다 지으면 후보가 발행 대기로 돌아간다.
   */
  { name: "crawl-tagline", role: "text", intervalMs: 60_000 },
  /**
   * 검색 키워드 — 공개 제품마다 모델이 한·영 검색어를 적는다. 같은 text 워커에서 1분마다 조금씩.
   * 처음 1만8천 건을 채우는 데 하루쯤 걸리고, 그 뒤로는 새 제품과 30일 지난 것만 본다.
   */
  { name: "product-search-profile", role: "text", intervalMs: 60_000 },
  /** 검색 키워드 검수 — 게이트웨이의 Qwen3.8. 키워드 짓기와 같은 text 워커(2026-09-25 reviewer·Sonnet 에서 옮김) */
  { name: "product-search-verify", role: "text", intervalMs: 60_000 },
  /**
   * 의미 검색의 제품 벡터 — 서버 Mac 의 bge-m3(llama-server)로 임베딩한다. 키워드가 바뀌면 글이 바뀌어 다시 임베딩하므로
   * 키워드 짓기와 같은 text 워커에 둔다. 게이트웨이를 쓰지 않아 심사와 다투지 않는다.
   */
  { name: "product-embedding", role: "text", intervalMs: 60_000 },
  /**
   * 저장소가 사라진 공개 제품을 다시 본다 — github.com 을 지금 열어 정말 없으면 내린다(repo-review.ts, 2026-10-13 운영자 결정).
   * text 워커에서 5분마다 8건까지. 옮겨 간 흔적이 있으면 사람 확인, 하루 100건을 넘게 내리지는 않는다
   */
  { name: "product-repo-review", role: "text", intervalMs: 5 * 60_000 },
  /**
   * 한국어 한 줄 소개(UX-13) — 공개 제품의 소개를 게이트웨이 gpt-oss-120b 로 한국어 한 줄로 옮긴다. 같은 text 워커에서 1분마다
   * 8건 묶음으로. 새 제품·홈에 보이는 제품이 먼저고, 나머지 3만여 건은 하루이틀에 걸쳐 채운다(korean-tagline.ts)
   */
  { name: "product-tagline-ko", role: "text", intervalMs: 60_000 },
  // Bounded, visible-product demand only; independent of the paused introduction-review queue.
  { name: "product-translate", role: "text", intervalMs: 60_000 },
  /** 소개 검수 — AI 소개와 쓸모없어 보이는 메이커 소개를 Sonnet 이 근거와 대조한다. 새로 발행된 것부터 */
  { name: "product-intro-check", role: "reviewer", intervalMs: 60_000 },
  /** Grok 로그인 확인 — 6시간 토큰이 심사가 뜸한 사이 만료되지 않게 4시간마다 가장 짧은 호출 한 번(grok-cli 설정이 있을 때만) */
  { name: "grok-session-check", role: "reviewer", intervalMs: 4 * 60 * 60_000 },
  /**
   * 1분마다 15건 = 시간당 900건. 발행분 3,147건을 재확인 간격 6시간마다 보려면 시간당 525건이
   * 필요한데, 10분 주기(시간당 90건)로는 6시간 안에 17%만 볼 수 있었다.
   *
   * crawler가 아니라 maintenance에서 돈다. 워커는 역할 안의 잡을 하나씩 차례로 돌린다
   * (scripts/worker.ts). crawler는 1분짜리 셋(예산 25·25·20초)만으로 시간당 4,200초라 이미
   * 한 프로세스의 3,600초를 넘는다 — 여기에 1분 주기(시간당 1,500초)를 얹으면 수집이 더 밀린다.
   * maintenance는 1시간에 한 번 도는 집계(click-rollup, 뒤따르는 ranking-refresh)뿐이라 한가하고,
   * 잡 한도도 600초로 느린 틱을 견딘다. 집계가 도는 동안은 기다린다 — 한 시간에 10틱을 잃어도
   * 시간당 750건이라 6시간 재확인은 지킨다.
   */
  { name: "uptime-ping", role: "maintenance", intervalMs: 60_000 },
  { name: "click-rollup", role: "maintenance", intervalMs: 60 * 60_000 },
  // The rollup completion transaction requests ranking; there is no independent schedule.
  { name: "ranking-refresh", role: "maintenance", intervalMs: null },
  /**
   * AI 소식(공식 피드 18곳)은 한 시간에 한 번이면 된다 — 회사 발표는 하루 몇 건이다.
   * crawler는 이미 시간을 넘겨 쓰고 있어 한가한 maintenance에 둔다(위 uptime-ping 설명).
   */
  { name: "news-refresh", role: "maintenance", intervalMs: 60 * 60_000 },
  { name: "product-thumbnail-refresh", role: "maintenance", intervalMs: 60_000 },
  /**
   * 검색 문서 채우기. 낡은 행만 골라 고치므로 다 채운 뒤에는 매 틱이 조인 한 번(수십 ms)이다.
   * 한가한 maintenance 에 둔다 — crawler 는 이미 시간을 넘겨 쓰고 있다(위 uptime-ping 설명).
   */
  { name: "product-search-refresh", role: "maintenance", intervalMs: 60_000 },
  /** Read-only canonical hash / search-copy audit, independent of the text worker. */
  { name: "github-integration-reconcile", role: "maintenance", intervalMs: 15 * 60_000 },
  { name: "product-search-health", role: "maintenance", intervalMs: 15 * 60_000 },
  /**
   * 공개 제품에 스팸·악성 배포 판정을 다시 태워 잡히면 내린다(spam-rescan.ts). 한 틱 1,000건 — 공개분 한 바퀴가 3시간쯤,
   * 다 돌면 하루 쉬고, 판정 버전이 바뀌면 곧바로 다시 돈다. 저장된 원본만 읽으므로 한가한 maintenance 에 둔다.
   */
  { name: "product-spam-rescan", role: "maintenance", intervalMs: 5 * 60_000 },
  /**
   * 알림 메일(MY7) — 발송함을 1분마다 한 틱 20통까지 비우고, 주간 요약은 15분마다 고른 요일·시각(KST)이 지난 계정을 묶는다.
   * 발신 설정(LOGIN_EMAIL_*)이 없으면 둘 다 네트워크를 부르지 않는다. 한가한 maintenance 에 둔다.
   */
  { name: "email-outbox-send", role: "maintenance", intervalMs: 60_000 },
  { name: "email-weekly-digest", role: "maintenance", intervalMs: 15 * 60_000 },
  /**
   * 마이페이지 알림함(lib/jobs/me/notifications.ts) — 팔로한 프로젝트가 내려감(cdn_purges 를 따라 읽고, 닿지 않는 것을 본다),
   * 팔로한 분야 주간 묶음(월요일 00:00 KST 부터 하루 안에 — 기본 09:00 주간 메일 요약보다 먼저 넣는다. 주기 일정에는 시각이 없어 틱마다 시각을 본다), 90일 지난 알림 지우기.
   */
  { name: "notification-delisted", role: "maintenance", intervalMs: 5 * 60_000 },
  { name: "notification-category-digest", role: "maintenance", intervalMs: 15 * 60_000 },
  { name: "notification-prune", role: "maintenance", intervalMs: 60 * 60_000 },
  { name: "product-evidence-refresh", role: "crawler", lane: "sources", intervalMs: 60_000 },
  { name: "product-site-evidence-refresh", role: "site-evidence", intervalMs: 60_000, batchVersion: 1 },
  // 저장소 파일·커밋 서명 조사 — 틱마다 14초 남짓. 기본 줄에서 70초 간격으로 밀려(목표 60초) 따로 돈다(2026-10-10)
  { name: "agent-evidence-refresh", role: "crawler", intervalMs: 60_000, lane: "scan" },
  /**
   * AI 제작 근거 단계(1·2·3단계)를 저장소마다 판정해 제품 ai_level 에 옮긴다(ai-level-refresh.ts). 새 후보 → 새 공개 제품 → 사흘 지난 것.
   * GraphQL 10개 묶음(1점)을 한 틱 38초 안에서 — 공개분 첫 바퀴가 반나절, 그 뒤 하루 1만 3천 개쯤
   */
  // 크롤러 시간의 3분의 1을 썼다(2026-10-10 실측: 크롤러 90% 바쁨, crawl-fetch 60→70초 간격) — 따로 도는 줄에 둔다
  { name: "ai-level-refresh", role: "crawler", intervalMs: 60_000, lane: "evidence" },
  /**
   * 공개 제품의 GitHub 저장소를 하루 한 번 모두 본다(있음·없음·빈 저장소·막힘과 스타). GraphQL 100개씩 한 틱 4묶음까지,
   * 새 묶음은 틱 14초 안에서만 연다 — 기본 예산 25초 안에 끝나 수집 예산을 크게 늘리지 않는다(stars-refresh.ts).
   */
  { name: "product-stars-refresh", role: "crawler", intervalMs: 5 * 60_000 },
  // Only the hour before KST 00/08/16 collects; minute ticks resume/finalize the same frozen cycle.
  { name: "product-star-observation", role: "crawler", intervalMs: 60_000, lane: "stars" },
  // Crawler already owns GitHub authentication; two recrawl-invalidated READMEs per tick.
  { name: "product-readme-refresh", role: "crawler", intervalMs: 5 * 60_000 },
  /**
   * 운영자 확인 재확인(마이페이지 MY5) — 30일 지난 행만 한 틱 20개까지 GitHub 저장소 주인을 다시 본다. README 갱신과 같은 까닭으로
   * GitHub 수집 자격이 있는 crawler 에 둔다(maintenance 에는 GITHUB_COLLECTOR_SECRET·GITHUB_TOKEN 이 없다). 날짜 지난 행이 없으면 조회 한 번
   */
  { name: "maker-recheck", role: "crawler", intervalMs: 60 * 60_000 },
];

export const JOB_NAMES = JOB_CATALOG.map(job => job.name);
export function isJobName(name: string): boolean { return JOB_NAMES.includes(name); }
export function jobsForRole(role: JobRole): string[] {
  return JOB_CATALOG.filter(job => job.role === role && job.batchVersion !== 1).map(job => job.name);
}
/** 역할의 잡을 줄마다 — 기본 줄이 먼저, 각 줄 안은 카탈로그 차례. 빈 줄은 없다 */
export function lanesForRole(role: JobRole): string[][] {
  const lanes = new Map<JobLane, string[]>([["main", []]]);
  for (const job of JOB_CATALOG) {
    if (job.role !== role || job.batchVersion === 1) continue;
    const lane = job.lane ?? "main";
    lanes.set(lane, [...(lanes.get(lane) ?? []), job.name]);
  }
  return [...lanes.values()].filter((names) => names.length > 0);
}
