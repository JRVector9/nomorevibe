import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { CatalogRole } from "@/lib/jobs/catalog";
import type { StageKey as CompletionStageKey } from "./pipeline-completions";
import type { ThroughputStage } from "./throughput-model";
import type { ProgressStageKey } from "./worker-progress";

/**
 * 운영센터 흐름 단계 — 들어오는 곳(소스) → 심사 흐름 6단계 → 발행 후 보강(운영센터 개편 v8 PR2).
 *
 * 화면은 아직 이 표를 읽지 않는다. 레일 옆 칸·흐름 상세 탭(v8 PR5·PR6)이 읽는다.
 * DB 를 읽지 않는 순수 표다 — 잡과 역할은 lib/jobs/catalog.ts 를, 숫자 열쇠는 지금 모듈의 것을 그대로 가리킨다:
 * throughputKey(throughput.ts) · progressKey(worker-progress) · flowKey(pipeline.ts pipelineFlow) · completionKey(pipeline-completions.ts).
 * 카탈로그의 잡은 모두 한 단계에만 들어가거나 STAGE_EXCLUDED_JOBS 에 까닭과 함께 있어야 한다 — tests/stage-registry.test.ts 가 CI 에서 막는다.
 */
export type StageGroup = "source" | "review" | "enrichment";
/** pipelineFlow 의 단계 열쇠(lib/operations/pipeline.ts) */
export type FlowStageKey = "discover" | "fetch" | "judge" | "review" | "publish" | "public";

export type PipelineStageDef = Readonly<{
  key: string;
  group: StageGroup;
  /** 쉬운 말 */
  label: string;
  /** 코드 이름 — 새 요소는 "쉬운 말(코드)"로 함께 적는다 */
  code: string;
  /** 이 단계를 처리하는 카탈로그 잡 — X 는 없다 */
  jobs: readonly string[];
  /** 첫 잡의 역할. 같은 단계의 다른 잡은 다른 역할일 수 있다(공개 근거의 분리 역할 site-evidence, 발행 앞의 소개 짓기 text) */
  role: CatalogRole | null;
  /** 아직 이어지지 않은 소스(X) */
  connected: boolean;
  /** 흐름 상세의 보강 12칸에 제 칸이 있는 단계 — 나머지 보강은 "외 n"으로 묶인다 */
  headline?: true;
  throughputKey?: ThroughputStage["key"];
  progressKey?: ProgressStageKey;
  flowKey?: FlowStageKey;
  completionKey?: CompletionStageKey;
}>;

/** 열쇠는 글자 그대로 남긴다 — StageKey 가 단계 열쇠의 합집합이 되게 */
const stage = <K extends string>(def: Omit<PipelineStageDef, "key" | "connected"> & { key: K; connected?: false }) =>
  ({ connected: true, ...def }) as PipelineStageDef & { key: K };

export const PIPELINE_STAGES = Object.freeze([
  // 들어오는 곳 — pipelineFlow 의 discover 는 소스 합계라 소스마다 잇지 않는다
  stage({ key: "github", group: "source", label: "GitHub 검색", code: "crawl-seed", jobs: ["crawl-seed"], role: "crawler" }),
  stage({ key: "show-hn", group: "source", label: "Show HN", code: "hn-show-seed", jobs: ["hn-show-seed"], role: "crawler" }),
  // X 는 시험 스크립트(lib/social/x-pilot.ts)만 있고 카탈로그 잡이 없다 — 연결은 v8 PR9
  stage({ key: "x", group: "source", label: "X", code: "x-pilot", jobs: [], role: null, connected: false }),

  // 심사 흐름 6단계
  stage({ key: "fetch", group: "review", label: "원본 수집", code: "crawl-fetch", jobs: ["crawl-fetch"], role: "crawler",
    throughputKey: "fetch", progressKey: "fetch", flowKey: "fetch", completionKey: "fetch" }),
  stage({ key: "judge", group: "review", label: "규칙 심사", code: "crawl-judge", jobs: ["crawl-judge"], role: "reviewer",
    throughputKey: "judge", progressKey: "judge", flowKey: "judge" }),
  stage({ key: "first", group: "review", label: "AI 1차", code: "crawl-agent-review", jobs: ["crawl-agent-review"], role: "reviewer",
    throughputKey: "first", progressKey: "first", completionKey: "ai1" }),
  stage({ key: "second", group: "review", label: "AI 2차", code: "second-review", jobs: ["second-review"], role: "reviewer",
    throughputKey: "second", progressKey: "second", completionKey: "ai2" }),
  // 심사 큐의 직접 판단(stage=human) — 관리자 스위치를 켜면 reviewer가 DeepSeek에 위임한다
  stage({ key: "human", group: "review", label: "사람 심사", code: "human-deepseek-review",
    jobs: ["human-deepseek-review"], role: "reviewer", flowKey: "review" }),
  // 소개 짓기(crawl-tagline)는 소개가 없어 발행 앞에서 멈춘 승인 후보의 한 줄을 짓는다 — 다 지으면 발행 대기로 돌아간다
  stage({ key: "publish", group: "review", label: "발행", code: "crawl-publish", jobs: ["crawl-publish", "crawl-tagline"], role: "publisher",
    throughputKey: "publish", progressKey: "publish", flowKey: "publish", completionKey: "publish" }),

  // 발행 후 보강 — 흐름 상세의 12칸
  stage({ key: "evidence", group: "enrichment", label: "공개 근거", code: "product-evidence-refresh",
    jobs: ["product-evidence-refresh", "product-site-evidence-refresh"], role: "crawler", headline: true, progressKey: "evidence" }),
  stage({ key: "agent-evidence", group: "enrichment", label: "개발 AI 근거", code: "agent-evidence-refresh", jobs: ["agent-evidence-refresh"],
    role: "crawler", headline: true, progressKey: "agent-evidence" }),
  stage({ key: "ai-level", group: "enrichment", label: "AI 단계", code: "ai-level-refresh", jobs: ["ai-level-refresh"], role: "crawler",
    headline: true, progressKey: "ai-level" }),
  stage({ key: "keywords", group: "enrichment", label: "키워드 짓기", code: "product-search-profile", jobs: ["product-search-profile"], role: "text", headline: true }),
  stage({ key: "keyword-verify", group: "enrichment", label: "키워드 검수", code: "product-search-verify", jobs: ["product-search-verify"], role: "text", headline: true }),
  stage({ key: "embedding", group: "enrichment", label: "의미 검색 벡터", code: "product-embedding", jobs: ["product-embedding"], role: "text", headline: true }),
  stage({ key: "product-translate", group: "enrichment", label: "제품 번역", code: "product-translate", jobs: ["product-translate"], role: "text", headline: true }),
  stage({ key: "reason-translate", group: "enrichment", label: "사유 번역", code: "reason-translate", jobs: ["reason-translate"], role: "text", headline: true }),
  stage({ key: "audit", group: "enrichment", label: "발행분 감사", code: "product-audit", jobs: ["product-audit", "audit-screen-review"], role: "reviewer",
    headline: true }),
  stage({ key: "stars", group: "enrichment", label: "저장소·스타", code: "product-stars-refresh", jobs: ["product-stars-refresh"], role: "crawler", headline: true }),
  // 진행 판정(worker-progress uptime)은 split claims 모드(0104 제품 단위 분담)에서만 나온다 — legacy 는 maintenance 생존·줄로 본다
  stage({ key: "uptime", group: "enrichment", label: "응답 점검", code: "uptime-ping", jobs: ["uptime-ping"], role: "maintenance", headline: true,
    progressKey: "uptime" }),
  stage({ key: "intro-check", group: "enrichment", label: "소개 검수", code: "product-intro-check", jobs: ["product-intro-check"], role: "reviewer", headline: true }),
  // 12칸 밖의 보강 — 카탈로그에 있는 나머지 발행 후 잡
  stage({ key: "tagline-ko", group: "enrichment", label: "한국어 소개", code: "product-tagline-ko", jobs: ["product-tagline-ko"], role: "text" }),
  stage({ key: "repo-review", group: "enrichment", label: "저장소 사라진 사이트 확인", code: "product-repo-review", jobs: ["product-repo-review"], role: "text" }),
  stage({ key: "star-observation", group: "enrichment", label: "8시간 스타 관측", code: "product-star-observation", jobs: ["product-star-observation"], role: "crawler" }),
  stage({ key: "readme", group: "enrichment", label: "README 갱신", code: "product-readme-refresh", jobs: ["product-readme-refresh"], role: "crawler" }),
  stage({ key: "thumbnail", group: "enrichment", label: "프로젝트 이미지", code: "product-thumbnail-refresh", jobs: ["product-thumbnail-refresh"], role: "maintenance" }),
  stage({ key: "search-refresh", group: "enrichment", label: "검색 데이터 갱신", code: "product-search-refresh", jobs: ["product-search-refresh"], role: "maintenance" }),
  stage({ key: "spam-rescan", group: "enrichment", label: "스팸 재검사", code: "product-spam-rescan", jobs: ["product-spam-rescan"], role: "maintenance" }),
]);

export type StageKey = (typeof PIPELINE_STAGES)[number]["key"];

/**
 * 흐름 단계가 아닌 카탈로그 잡과 그 까닭. 새 잡은 단계에 넣거나 여기에 까닭을 적어야 CI 가 통과한다.
 */
export const STAGE_EXCLUDED_JOBS: Readonly<Record<string, string>> = {
  heartbeat: "스케줄러가 살아 있다는 관측 — 후보·제품을 처리하지 않는다",
  "grok-session-check": "Grok 로그인 토큰 유지 — 심사 결과를 만들지 않는다",
  "product-search-health": "검색 데이터 자동 점검 — 읽기만 하고 고치지 않는 관측",
  "github-integration-reconcile": "GitHub 연동 재조회 — 읽기 전용 해시·검색 사본 대조",
  "click-rollup": "유효 방문 집계 — 방문 통계이지 제품 흐름이 아니다",
  "ranking-refresh": "랭킹 갱신 — 방문 집계가 끝나면 따라 도는 순위 계산",
  "news-refresh": "AI 소식 수집 — 제품 흐름과 따로인 공식 피드",
  "hn-talk": "HN 화제 글 기록 — 프론티어에 넣지 않는 SNS 관측",
  "bluesky-talk": "Bluesky 화제 글 기록 — 프론티어에 넣지 않는 SNS 관측",
  "cdn-purge": "내린 제품의 CDN 캐시 지우기 — 내린 뒤 정리",
  "github-feedback-delivery": "메이커 동의를 받은 GitHub 피드백 전송 — 사용자 요청 처리",
  "email-outbox-send": "알림 메일 보내기 — 사용자 알림 설정 처리, 제품 흐름이 아니다",
  "email-weekly-digest": "주간 요약 메일 묶기 — 사용자 알림 설정 처리, 제품 흐름이 아니다",
  "maker-recheck": "운영자 확인 재확인 — 계정과 저장소 주인 대조, 제품 흐름이 아니다",
  "notification-delisted": "팔로한 프로젝트 내려감 알림 — 내린 뒤 계정 알림함에 적기",
  "notification-category-digest": "팔로한 분야 주간 묶음 알림 — 공개 제품을 세기만 한다",
  "notification-prune": "90일 지난 알림 지우기 — 계정 알림함 정리",
};

export function stageForJob(job: string): PipelineStageDef | null {
  return PIPELINE_STAGES.find((row) => row.jobs.includes(job)) ?? null;
}

type ModelSettings = Pick<CrawlSettings, "firstReview" | "secondReview">;
type Env = Readonly<Record<string, string | undefined>>;

export type ModelSlot = Readonly<{
  stage: StageKey;
  /** 자리 열쇠 — 모든 자리에서 하나뿐 */
  key: string;
  /** 쉬운 말 */
  label: string;
  /** 설정 경로나 환경변수 이름 */
  code: string;
  provider: string | null;
  model: string | null;
  /** settings: 저장된 크롤 설정 · env: 이 프로세스의 환경변수 · default: 코드 기본값 · unset: 정해진 모델이 없음 */
  source: "settings" | "env" | "default" | "unset";
  /**
   * 호출마다 남는 기록이 없어 결과 행으로 센다 — 화면은 중립 색 참고로만 보인다(v8 검토 H).
   * 키워드 짓기도 결과 행으로 세지만 지금 모델 카드 4자리 판정을 그대로 두므로 근사로 두지 않는다.
   */
  approximated: boolean;
}>;

/**
 * 환경변수로 고르는 텍스트·벡터 모델 — 이름과 기본값은 각 잡 모듈의 상수와 같다(테스트가 모듈을 다시 읽어 견준다).
 * 환경변수는 이 프로세스의 것이다 — 웹과 워커의 환경이 다르면 관측한 모델(결과 행의 model)이 더 정확하다.
 */
export const ENV_MODEL_SLOTS = [
  { stage: "publish", key: "tagline", label: "소개 짓기", env: "ABCLLM_TAGLINE_MODEL", fallback: "[MLX] qwen3.6-35b-heretic", provider: "abcllm", approximated: true },
  { stage: "keywords", key: "keywords", label: "키워드 짓기", env: "ABCLLM_PROFILE_MODEL", fallback: "[MLX] gpt-oss-120b", provider: "abcllm", approximated: false },
  { stage: "keyword-verify", key: "keyword-verify", label: "키워드 검수", env: "SEARCH_VERIFY_MODEL", fallback: "[supa] Qwen3.8-27B-NVFP4", provider: "abcllm", approximated: true },
  // 벡터 모델은 환경변수로 바꾸지 않는다 — 바꾸면 전부 다시 임베딩한다(embedding.ts EMBEDDING_MODEL)
  { stage: "embedding", key: "embedding", label: "의미 검색 벡터", env: null, fallback: "bge-m3-f16@daec91ff", provider: "llama-server", approximated: true },
  { stage: "product-translate", key: "product-translate", label: "제품 번역", env: "ABCLLM_MODEL", fallback: "[MLX] gpt-oss-120b", provider: "abcllm", approximated: true },
  { stage: "reason-translate", key: "reason-translate", label: "사유 번역", env: "ABCLLM_MODEL", fallback: "[MLX] gpt-oss-120b", provider: "abcllm", approximated: true },
  { stage: "intro-check", key: "intro-check", label: "소개 검수", env: "INTRO_CHECK_MODEL", fallback: "sonnet", provider: "claude-cli", approximated: true },
  { stage: "tagline-ko", key: "tagline-ko", label: "한국어 소개", env: "ABCLLM_MODEL", fallback: "[MLX] gpt-oss-120b", provider: "abcllm", approximated: true },
] as const satisfies readonly { stage: StageKey; key: string; label: string; env: string | null; fallback: string; provider: string; approximated: boolean }[];

/** CLI 모델 이름 규칙 — agent-review.ts reviewModel 과 같다 */
const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

/** 1차 심사자 — 설정이 있으면 그것, 없으면 CRAWL_REVIEW_MODEL(claude-cli). agent-review.ts firstReviewer 와 같다 */
function firstReviewSlot(settings: ModelSettings, env: Env) {
  if (settings.firstReview) return { code: "firstReview", provider: settings.firstReview.provider, model: settings.firstReview.model, source: "settings" as const };
  const model = env.CRAWL_REVIEW_MODEL?.trim();
  return model && CLI_MODEL.test(model)
    ? { code: "CRAWL_REVIEW_MODEL", provider: "claude-cli", model, source: "env" as const }
    : { code: "firstReview", provider: null, model: null, source: "unset" as const };
}

/**
 * 단계마다 쓰는 모델 자리 — 설정만으로 정해진다. 2차 투표·예비는 저장된 목록 전부라, 설정에 투표자를 더하면 자리도 생긴다.
 * 흐름 차례(PIPELINE_STAGES)대로, 같은 단계 안은 설정 차례대로 낸다.
 */
export function resolveModelSlots(settings: ModelSettings, env: Env = process.env): ModelSlot[] {
  const first = firstReviewSlot(settings, env);
  const slots: ModelSlot[] = [
    { stage: "first", key: "first", label: "주", ...first, approximated: false },
    ...settings.secondReview.voters.map((voter, index): ModelSlot => ({ stage: "second", key: `second-voter-${index + 1}`, label: `투표 ${index + 1}`,
      code: `secondReview.voters[${index}]`, provider: voter.provider, model: voter.model, source: "settings", approximated: false })),
    ...(settings.secondReview.fallbacks ?? []).map((voter, index): ModelSlot => ({ stage: "second", key: `second-fallback-${index + 1}`, label: `예비 ${index + 1}`,
      code: `secondReview.fallbacks[${index}]`, provider: voter.provider, model: voter.model, source: "settings", approximated: false })),
    // 새 감사는 시작할 때의 1차 심사자로 고정된다(product-audit.ts) — 도는 중인 감사의 모델은 product_audit_campaigns.model 이다
    { stage: "audit", key: "audit", label: "발행분 감사", ...first, approximated: false },
    ...ENV_MODEL_SLOTS.map((slot): ModelSlot => {
      const value = slot.env ? env[slot.env]?.trim() : undefined;
      return { stage: slot.stage, key: slot.key, label: slot.label, code: slot.env ?? "EMBEDDING_MODEL", provider: slot.provider,
        model: value || slot.fallback, source: value ? "env" : "default", approximated: slot.approximated };
    }),
  ];
  const order = new Map<string, number>(PIPELINE_STAGES.map((row, index) => [row.key, index]));
  return slots.sort((a, b) => order.get(a.stage)! - order.get(b.stage)!);
}
