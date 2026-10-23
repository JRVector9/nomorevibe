import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { DEEPSEEK_REVIEW_MODEL } from "@/lib/crawl/deepseek-review-policy";
import { qwenDirectConfig, qwenDirectServerLabel, QWEN_DIRECT_DEFAULT_MODEL } from "@/lib/crawl/qwen-direct-review";
import { screenModelConfig, screenPromptConfig, visionModelName } from "@/lib/screen-review/vision-review";
import { screenRenderConfig } from "@/lib/screen-review/render-client";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { batchJobsForRole, batchOwnerForJob, catalogJobsForBatch, type BatchMode, type BatchRole } from "@/lib/jobs/batches";
import { jobStatusLabel, type ObservedJob } from "@/lib/jobs/status";
import { JOB_LABELS, ROLE_LABELS, type AgentStatus } from "@/lib/operations/contracts";
import type { ModelHealth } from "@/lib/operations/dashboard";
import type { RoleOverview } from "@/lib/operations/roles";
import { PIPELINE_STAGES, resolveModelSlots, type ModelSlot } from "@/lib/operations/stage-registry";
import { consumerOfInstance, type ConsumerName } from "@/lib/runtime/consumer-registry";
import { formatAgo, formatListTime } from "@/lib/format/time";
import { modelName, slotTitle } from "./dashboard/ModelCards";

/**
 * 조치 칸의 "누가 맡나" — 그 일을 하는 작업(카탈로그 잡)·서비스가 지금 어느 장비에서, 어떤 LLM 으로, 어떤 주기로 도는지.
 *
 * 새로 읽지 않는다. 조치와 같은 입력(역할 담당 lease · 서비스 관측 · 작업 표 · 크롤 설정 · AI 연결 관측 · 모델 1시간 집계)에서 모은다.
 * 장비는 역할을 쥔 워커(lease)와 건 단위 일꾼(consumer), 위치를 아는 모델 서버(M3 DeepSeek·임베딩, Qwen 직접 서버)다.
 * 화면(WorkOwnerButtons)에는 글자만 넘긴다 — 시각도 여기서 KST 글자로 바꾼다.
 */

/** 잡이 아닌 상시 서비스 */
export type WorkService = "connect-agent" | "web" | "scheduler" | "x-collector";
/** 조치 한 칸의 일을 맡는 것 — buildActions 가 단다. roles 는 역할 자체가 문제인 줄(예비가 일함·관측 끊김)로, 그 역할의 작업 전부다 */
export type ActionWork = { jobs?: readonly string[]; services?: readonly WorkService[]; roles?: readonly string[] };

export type OwnerTone = "ok" | "warn" | "bad";
export type HostRow = { instanceId: string; what: string; jobs: string[]; state: string; tone: OwnerTone | null; release: string | null; seen: string | null };
export type OwnerHost = { name: string; rows: HostRow[] };
export type ModelRow = { slot: string; job: string; provider: string; runsOn: string; source: string; stats: string | null };
export type OwnerModel = { name: string; full: string; rows: ModelRow[] };
export type OwnerJob = { name: string; label: string; role: string; lane: string; schedule: string; how: string;
  state: string | null; lastRun: string | null; lastSuccess: string | null; next: string | null };
export type WorkOwners = { hosts: OwnerHost[]; models: OwnerModel[]; jobs: OwnerJob[]; notes: string[] };

type Env = Readonly<Record<string, string | undefined>>;
type Instance = { role: string; instanceId: string; observedAt: string | Date; value: Record<string, unknown> };
type JobState = Partial<ObservedJob> & { lastSuccessAt?: Date | null; nextScheduledAt?: Date | null };
export type OwnerContext = {
  settings: Partial<Pick<CrawlSettings, "firstReview" | "secondReview" | "humanReview" | "qwenAuto">>;
  roles: Pick<RoleOverview, "role" | "ownerInstanceId" | "ownerKind" | "ownerRelease" | "secondsUntilExpiry">[] | null;
  instances: Instance[];
  jobs: ReadonlyMap<string, JobState>;
  batch: { mode: string; writerContractVersion: number } | null;
  agent: AgentStatus | undefined;
  models: Pick<ModelHealth, "key" | "label" | "calls1h" | "failed1h">[] | null;
  modelServers?: { name: string; ok: boolean }[] | null;
  now: string;
  env?: Env;
};

/**
 * 한 틱이 하는 일 — 카탈로그(lib/jobs/catalog.ts)·처리기(lib/jobs/registry.ts)의 설명을 사람이 읽는 한두 문장으로.
 * 카탈로그에 잡을 더하면 여기에도 적어야 한다(tests/operations-work-owners.test.ts).
 */
export const JOB_HOW: Readonly<Record<string, string>> = {
  heartbeat: "스케줄러가 살아 있다는 관측만 남깁니다. 후보·제품은 처리하지 않습니다.",
  "crawl-seed": "GitHub 검색으로 새 저장소를 찾아 수집 대기열(프론티어)에 넣습니다. 검색 한도(분당 30회) 안에서 한 회차 몇 쪽씩 읽습니다.",
  "hn-show-seed": "Show HN 새 글에서 배포를 알린 프로젝트를 수집 대기열에 넣습니다(한 번에 100건 상한).",
  "hn-talk": "최근 72시간·10점 이상 HN 글 중 GitHub 를 가리킨 것을 점수와 함께 기록합니다. 수집 대기열에는 넣지 않습니다.",
  "bluesky-talk": "최근 72시간 Bluesky 게시물 중 GitHub 링크를 반응 수와 함께 기록합니다(회차당 요청 30번까지). 수집 대기열에는 넣지 않습니다.",
  "crawl-fetch": "수집 대기열에서 꺼낸 저장소의 원본(저장소 정보·배포 페이지)을 가져옵니다.",
  "crawl-judge": "가져온 원본에 규칙 기준을 적용해 심사 후보로 남깁니다. 모델을 부르지 않습니다.",
  "crawl-agent-review": "규칙을 통과한 후보를 1차 모델이 읽고 승인·거절·보류를 정합니다.",
  "second-review": "1차와 다른 모델이 같은 입력을 따로 봅니다. 엇갈리면 사람 몫으로 넘기고, 갈림 판가름이 켜져 있으면 Qwen 직접 서버에 한 번 더 묻습니다.",
  "human-deepseek-review": "사람 몫(직접 판단)으로 넘어온 후보를 M3 로컬 DeepSeek 이 대신 봅니다(관리자 스위치를 켰을 때만). 보류 재심사가 켜져 있으면 Qwen 직접 서버에 다시 묻습니다.",
  "product-audit": "사람이 연 감사가 있을 때 공개 제품을 1차 심사 글로 다시 봅니다. 거절 판정은 적기만 하고 내리는 것은 사람입니다. 새 후보가 기다리면 먼저 양보합니다.",
  "audit-screen-review": "글이 얇은 감사 거절을 화면 서버(m1-studio)에서 그려 글과 첫 화면을 Qwen 에 묻습니다. 따로 도는 줄이라 심사·감사를 막지 않습니다.",
  "crawl-publish": "승인된 후보의 카테고리를 AI 연결 서비스에 물어 정한 뒤 공개 목록에 올립니다. 분류를 못 하면 1시간 뒤 다시 합니다.",
  "cdn-purge": "내려간 제품의 Cloudflare 사본(상세·썸네일·목록)을 1분에 한 요청씩 지웁니다.",
  "github-feedback-delivery": "메이커가 동의한 GitHub 피드백만 보냅니다(기본 꺼짐).",
  "reason-translate": "심사 사유를 한국어로 옮깁니다(틱 55초, 한 번에 4건·1,600자까지).",
  "crawl-tagline": "소개가 없어 발행 앞에서 멈춘 후보의 한 줄 소개를 모델이 짓습니다. 다 지으면 발행 대기로 돌아갑니다.",
  "product-search-profile": "공개 제품마다 한·영 검색 키워드를 모델이 적습니다. 새 제품과 30일 지난 것만 봅니다.",
  "product-search-verify": "모델이 적은 검색 키워드를 다른 모델이 검수합니다.",
  "product-embedding": "제품 글을 의미 검색 벡터로 바꿉니다. 키워드가 바뀌면 다시 임베딩합니다. 게이트웨이를 쓰지 않습니다.",
  "product-repo-review": "저장소가 사라진 공개 제품의 github.com 을 다시 열어 정말 없으면 내립니다(5분마다 8건, 하루 100건까지). 옮겨 간 흔적이 있으면 사람 확인으로 남깁니다.",
  "product-tagline-ko": "공개 제품 소개를 한국어 한 줄로 옮깁니다(8건 묶음, 새 제품·홈에 보이는 제품 먼저).",
  "product-translate": "보이는 공개 제품의 정보를 정해진 양만큼 번역합니다.",
  "product-intro-check": "AI 소개와 쓸모없어 보이는 메이커 소개를 근거와 대조합니다. 근거로 알 수 없으면 사람 확인으로 남깁니다.",
  "grok-session-check": "Grok 로그인 토큰이 만료되지 않게 가장 짧은 호출을 한 번 합니다(심사에 Grok 을 쓸 때만).",
  "uptime-ping": "공개 웹사이트 제품을 열어 응답을 확인합니다(재확인 간격 6시간). 연속으로 실패하면 공개 목록에서 빼고, 401·403·429·999 는 살아 있는지 알 수 없어 세지 않습니다. 한 회차의 30% 넘게 실패하면 확인하는 서버 쪽 문제로 보고 판정을 보류합니다.",
  "click-rollup": "유효 방문을 한 시간 단위로 모읍니다. 끝나면 랭킹 갱신을 요청합니다.",
  "ranking-refresh": "방문 집계가 끝나면 순위를 다시 계산합니다.",
  "news-refresh": "공식 피드에서 AI 소식을 모읍니다.",
  "product-thumbnail-refresh": "프로젝트 이미지를 모읍니다.",
  "product-search-refresh": "검색 문서에서 낡은 행만 골라 고칩니다.",
  "github-integration-reconcile": "GitHub 연동의 해시·검색 사본을 읽기만 하며 대조합니다.",
  "product-search-health": "검색 데이터(누락·불일치·재시도 한도)를 읽기만 하며 점검합니다. 고치지 않습니다.",
  "product-spam-rescan": "공개 제품에 스팸·악성 배포 판정을 다시 태워 잡히면 내립니다(한 틱 1,000건, 하루 한도 있음).",
  "email-outbox-send": "알림 메일 발송함을 한 틱 20통까지 보냅니다. 하루가 지난 메일은 보내지 않고 닫습니다.",
  "email-weekly-digest": "주간 요약 메일을 고른 요일·시각(KST)이 지난 계정마다 묶습니다.",
  "notification-delisted": "팔로한 프로젝트가 내려가면 알림함에 적습니다.",
  "notification-category-digest": "팔로한 분야의 주간 묶음 알림을 넣습니다(월요일 KST).",
  "notification-prune": "90일 지난 알림을 지웁니다.",
  "product-evidence-refresh": "공개 제품의 근거 출처를 다시 읽어 갱신합니다.",
  "product-site-evidence-refresh": "공식 사이트 근거를 갱신합니다(분리 역할, versioned 방식에서만 돕니다).",
  "agent-evidence-refresh": "저장소 파일·커밋 서명으로 개발 AI 근거를 조사합니다. items 방식에서는 이 작업이 저장소별 대기열을 채우고, 제작 근거 consumer 들이 나눠 스캔합니다.",
  "ai-level-refresh": "저장소마다 AI 제작 단계(1·2·3단계)를 판정해 제품에 옮깁니다(GraphQL 10개 묶음).",
  "product-stars-refresh": "공개 제품의 GitHub 저장소를 하루에 한 번씩 모두 봅니다(있음·없음·빈 저장소·막힘과 스타, GraphQL 100개 묶음).",
  "product-star-observation": "KST 0·8·16시 앞 한 시간에 스타 수를 모아 8시간 관측을 남깁니다.",
  "product-readme-refresh": "다시 수집하며 무효가 된 README 를 틱마다 2개씩 새로 받습니다.",
  "maker-recheck": "운영자 확인 뒤 30일 지난 것의 GitHub 저장소 주인을 다시 봅니다(한 틱 20개).",
};

const SERVICES: Readonly<Record<WorkService, { label: string; role: string | null; schedule: string; how: string }>> = {
  "connect-agent": { label: "AI 연결 서비스", role: "connect-agent", schedule: "상시 — 발행 작업이 요청할 때",
    how: "발행 작업(crawl-publish)이 카테고리 분류를 요청하면 우선 모델로 답하고, 계정이 실패하면 예비 모델이 이어 받습니다. 1차·2차 심사는 이 서비스를 거치지 않습니다." },
  web: { label: "웹·관리자 서비스", role: "app", schedule: "상시 — 요청이 올 때",
    how: "M3·mini 웹이 함께 요청을 받습니다. 로그인 코드 메일은 요청을 받은 웹이 그 자리에서 보냅니다(작업이 아닙니다)." },
  scheduler: { label: "작업 일정 관리", role: "scheduler", schedule: "상시",
    how: "두 복제본이 작업 표의 주기대로 다음 실행 시각을 예약합니다. 역할 워커는 예약된 작업만 받아 돌립니다." },
  "x-collector": { label: "X 수집기", role: null, schedule: "하루 1회 — osaka-smoke 타이머",
    how: "Oracle 서버(osaka-smoke)의 타이머가 하루 한 번 X 를 검색해 후보 수와 게시물을 웹에 보고합니다. 웹은 보고를 받기만 합니다." },
};

/** 역할 lease 없이 같은 대기열을 건 단위로 나눠 맡는 일꾼(lib/runtime/consumer-registry.ts) — 그 일을 하는 잡 */
const JOB_CONSUMERS: Readonly<Record<string, ConsumerName>> = {
  "crawl-agent-review": "ai1", "second-review": "ai2", "uptime-ping": "uptime", "agent-evidence-refresh": "agent-scan",
};
const CONSUMER_LABELS: Readonly<Record<ConsumerName, string>> = {
  ai1: "1차 심사 consumer", ai2: "2차 심사 consumer", uptime: "연결 확인 consumer", "agent-scan": "제작 근거 consumer",
};

/** Qwen 직접 서버를 부르는 자동 단계(설정 qwenAuto)와 그 단계를 도는 잡 — 화면 판별(screenReview)은 따로 본다 */
const QWEN_STEPS = [
  ["auditSecondOpinion", "product-audit", "감사 두 번째 의견"], ["publishedFilter", "product-audit", "공개분 거르기"],
  ["splitTiebreak", "second-review", "2차 갈림 판가름"], ["heldRetry", "human-deepseek-review", "보류 재심사"],
] as const;

const NOTES = {
  schedule: "일정은 cron 이 아니라 scheduler 앱(복제 2대)이 작업 표의 주기대로 다음 실행을 예약하고, 그 역할을 맡은 워커가 받아 돌립니다. 같은 줄의 작업은 차례로, 다른 줄은 동시에 돕니다.",
  consumer: "consumer 는 역할 담당 없이 같은 대기열을 건 단위로 나눠 맡는 일꾼입니다. 제어 방식이 켜졌을 때만 일감을 가져갑니다.",
  env: "환경변수로 고르는 모델은 웹 프로세스 기준입니다. 워커 설정과 다르면 흐름 상세의 모델 자리 표(실제로 쓴 모델)가 맞습니다.",
};

/** 모델 1시간 집계(modelHealth)의 자리 → 그 모델을 부르는 잡 — "모델 호출이 자주 실패합니다" 칸이 쓴다 */
export const MODEL_HEALTH_JOBS: Readonly<Record<ModelHealth["key"], string>> = {
  first: "crawl-agent-review", second: "second-review", fallback: "second-review", keywords: "product-search-profile",
};

/** 진행 판정 한 줄의 잡 — 판정이 잡을 적지 않았으면 그 단계의 잡(stage-registry progressKey) */
export function progressStageJobs(row: { stage: string; job?: string }): string[] {
  return row.job ? [row.job] : [...(PIPELINE_STAGES.find((stage) => "progressKey" in stage && stage.progressKey === row.stage)?.jobs ?? [])];
}

const LEGACY_BATCH = { mode: "legacy", writerContractVersion: 0 } as const;
const LIVE_MS = 3_600_000;
const FRESH_MS = 45_000;
const n = (value: number) => value.toLocaleString("ko-KR");
const timeOf = (value: string | Date) => value instanceof Date ? value.getTime() : Date.parse(value);
const shortRelease = (value: unknown) => typeof value === "string" && value !== "unknown" ? value.slice(0, 7) : null;
const label = (job: string) => JOB_LABELS[job] ?? job;

/** 인스턴스 이름의 장비 — m3-crawler·agent-scan-consumer-m3 → M3, mini-crawler-standby → mini, …-oracle → Oracle */
export function hostName(instanceId: string): string {
  if (/(^|[-_.])m3([-_.]|$)/i.test(instanceId)) return "M3";
  if (/(^|[-_.])mini([-_.]|$)/i.test(instanceId)) return "mini";
  if (/oracle|osaka/i.test(instanceId)) return "Oracle";
  return instanceId;
}

/** "1분마다"·"2시간마다" — 주기가 없는 잡은 까닭을 적는다 */
function schedule(name: string, intervalMs: number | null | undefined): string {
  if (name === "ranking-refresh") return "주기 없음 — 방문 집계(click-rollup)가 끝나면 요청";
  if (!intervalMs) return "주기 없음";
  return intervalMs < 3_600_000 ? `${intervalMs / 60_000}분마다` : `${intervalMs / 3_600_000}시간마다`;
}

/** 작업 한 줄 — 맡는 역할은 지금 batch 방식에서 정한다(분리 역할은 versioned 에서만) */
function jobRow(name: string, mode: BatchMode, ctx: OwnerContext): OwnerJob {
  const def = JOB_CATALOG.find((row) => row.name === name);
  const role: string | null = batchOwnerForJob(name, mode) ?? (def?.role === "scheduler" ? "scheduler" : null);
  const state = ctx.jobs.get(name);
  const nowMs = Date.parse(ctx.now);
  return {
    name, label: label(name),
    role: role ? `${ROLE_LABELS[role] ?? role}(${role})` : "맡는 역할 없음 — 작업을 비우는 중",
    lane: def?.lane && def.lane !== "main" ? `따로 도는 줄(${def.lane}) — 같은 역할의 다른 줄과 동시에` : "기본 줄 — 같은 역할의 다른 작업과 차례로",
    schedule: schedule(name, def?.intervalMs), how: JOB_HOW[name] ?? "",
    state: state ? jobStatusLabel({ lockedAt: null, requestedVersion: 0, processedVersion: 0, lastRunAt: null, lastError: null, notBefore: null, ...state }, nowMs) : "실행 기록 없음",
    lastRun: state?.lastRunAt ? formatListTime(state.lastRunAt, ctx.now) : null,
    lastSuccess: state?.lastSuccessAt ? formatListTime(state.lastSuccessAt, ctx.now) : null,
    next: state?.nextScheduledAt ? formatListTime(state.nextScheduledAt, ctx.now) : null,
  };
}

const lanesOf = (value: Record<string, unknown> | undefined) =>
  Array.isArray(value?.lanes) ? (value.lanes as { currentJob?: unknown }[]) : [];

/** 역할을 쥔 워커 — lease 가 있는 다섯 역할은 lease 의 주인, 분리 역할·scheduler 는 1시간 안에 관측된 인스턴스 */
function roleHostRows(role: string, jobs: string[], ctx: OwnerContext): HostRow[] {
  const nowMs = Date.parse(ctx.now);
  const what = `${ROLE_LABELS[role] ?? role} 역할`;
  const lease = ctx.roles?.find((row) => row.role === role);
  if (lease) {
    if (!lease.ownerInstanceId) return [{ instanceId: "—", what, jobs: jobs.map(label), state: "담당 없음", tone: "bad", release: null, seen: null }];
    const worker = ctx.instances.find((row) => row.role === role && row.instanceId === lease.ownerInstanceId);
    const expired = lease.secondsUntilExpiry !== null && lease.secondsUntilExpiry <= 0;
    const running = [worker?.value, ...lanesOf(worker?.value)].some((lane) => typeof lane?.currentJob === "string" && jobs.includes(lane.currentJob));
    const kind = lease.ownerKind === "standby" ? "예비" : lease.ownerKind === "primary" ? "주" : null;
    return [{ instanceId: lease.ownerInstanceId, what: kind ? `${what} 담당(${kind})` : `${what} 담당`, jobs: jobs.map(label),
      state: expired ? "담당 기한 지남" : running ? "지금 실행 중" : "다음 예약 대기",
      tone: expired ? "bad" : lease.ownerKind === "standby" ? "warn" : "ok",
      release: shortRelease(lease.ownerRelease), seen: worker ? formatAgo(worker.observedAt, ctx.now) : null }];
  }
  return ctx.instances.filter((row) => row.role === role && !consumerOfInstance(row.instanceId) && nowMs - timeOf(row.observedAt) <= LIVE_MS)
    .map((row) => ({ instanceId: row.instanceId, what, jobs: jobs.map(label),
      state: nowMs - timeOf(row.observedAt) <= FRESH_MS ? "관측 중" : "관측 지연", tone: nowMs - timeOf(row.observedAt) <= FRESH_MS ? "ok" as const : "warn" as const,
      release: shortRelease(row.value.release), seen: formatAgo(row.observedAt, ctx.now) }));
}

/** 같은 잡을 건 단위로 나눠 맡는 consumer — 1시간 안에 관측된 것만 */
function consumerHostRows(job: string, ctx: OwnerContext): HostRow[] {
  const consumer = JOB_CONSUMERS[job];
  if (!consumer) return [];
  const nowMs = Date.parse(ctx.now);
  return ctx.instances.filter((row) => consumerOfInstance(row.instanceId) === consumer && nowMs - timeOf(row.observedAt) <= LIVE_MS)
    .map((row) => {
      const fresh = nowMs - timeOf(row.observedAt) <= FRESH_MS;
      return { instanceId: row.instanceId, what: `${CONSUMER_LABELS[consumer]}(${consumer})`, jobs: [label(job)],
        state: !fresh ? "관측 지연" : row.value.state === "running" ? "건 처리 중" : row.value.state === "idle" ? "대기" : String(row.value.state ?? "관측 중"),
        tone: fresh ? "ok" as const : "warn" as const, release: shortRelease(row.value.release), seen: formatAgo(row.observedAt, ctx.now) };
    });
}

/** 모델 자리 → 그 자리를 쓰는 잡. 소개 짓기만 발행 단계의 두 번째 잡이다 */
function slotJob(slot: ModelSlot): string | undefined {
  return slot.key === "tagline" ? "crawl-tagline" : PIPELINE_STAGES.find((row) => row.key === slot.stage)?.jobs[0];
}

function runsOn(provider: string | null, model: string): string {
  const runner = /^\[([^\]]+)\]/.exec(model)?.[1];
  if (provider === "abcllm") return `abcllm 게이트웨이${runner ? ` · 실행기 ${runner}` : ""}`;
  if (provider === "claude-cli") return "Claude CLI — 작업을 돌리는 워커 장비에서 실행";
  if (provider === "grok-cli") return "Grok CLI — 작업을 돌리는 워커 장비에서 실행";
  if (provider === "llama-server") return "M3 llama-server(launchd bot.brut.nmv-*)";
  return provider ?? "정해지지 않음";
}

function slotSource(slot: ModelSlot): string {
  if (slot.key === "embedding") return "코드 고정값 — 바꾸면 전부 다시 임베딩";
  if (slot.key === "audit") return "크롤 설정 firstReview — 새 감사를 열 때의 1차 심사자로 고정(진행 중인 감사의 모델은 감사 화면)";
  if (slot.source === "settings") return `크롤 설정 ${slot.code}`;
  if (slot.source === "env") return `환경변수 ${slot.code}(웹 기준)`;
  if (slot.source === "default") return `코드 기본값 — ${slot.code} 없음(웹 기준)`;
  return "정해진 모델 없음";
}

/** 모델 1시간 집계(modelHealth)의 자리 — 1차·2차 투표·2차 예비·키워드 짓기만 있다 */
function slotStats(slot: ModelSlot, ctx: OwnerContext): string | null {
  const key = slot.stage === "first" ? "first" : slot.key.startsWith("second-voter") ? "second" : slot.key.startsWith("second-fallback") ? "fallback"
    : slot.key === "keywords" ? "keywords" : null;
  const row = key ? ctx.models?.find((model) => model.key === key) : undefined;
  return row ? `최근 1시간(${row.label}) 호출 ${n(row.calls1h)} · 실패 ${n(row.failed1h)}` : null;
}

/** name 이 없으면 full 에서 실행기 표시를 뗀 것이 버튼 이름이다 */
type ModelEntry = { name?: string; full: string; row: ModelRow };
type HostEntry = { name: string; row: HostRow };

/** 잡 하나가 쓰는 LLM — 크롤 설정·환경변수의 모델 자리, M3 DeepSeek, Qwen 직접 서버, 화면 판별 */
function jobModels(job: string, slots: ModelSlot[], ctx: OwnerContext, env: Env): { models: ModelEntry[]; hosts: HostEntry[] } {
  const models: ModelEntry[] = [], hosts: HostEntry[] = [];
  for (const slot of slots) {
    if (slotJob(slot) !== job || !slot.model) continue;
    models.push({ full: slot.model, row: { slot: slotTitle(slot), job: label(job), provider: slot.provider ?? "—", runsOn: runsOn(slot.provider, slot.model),
      source: slotSource(slot), stats: slotStats(slot, ctx) } });
    if (slot.provider === "llama-server") {
      const server = ctx.modelServers?.find((row) => row.name === "embedding");
      hosts.push({ name: "M3", row: { instanceId: "llama-server", what: "모델 서버 — 의미 검색 벡터", jobs: [label(job)],
        state: server ? (server.ok ? "응답함" : "응답 없음") : "상태 미확인", tone: server ? (server.ok ? "ok" : "bad") : null, release: null, seen: null } });
    }
  }
  if (job === "human-deepseek-review" && ctx.settings.humanReview?.enabled) {
    models.push({ full: DEEPSEEK_REVIEW_MODEL, row: { slot: "사람 몫 대신 판단", job: label(job), provider: "m3-deepseek", runsOn: "M3 로컬 DeepSeek",
      source: "코드 고정값 · 크롤 설정 humanReview 켜짐", stats: null } });
    hosts.push({ name: "M3", row: { instanceId: "m3-deepseek", what: "모델 서버 — DeepSeek", jobs: [label(job)], state: "켜짐", tone: null, release: null, seen: null } });
  }
  const qwen = ctx.settings.qwenAuto;
  const qwenConfig = qwenDirectConfig(env);
  // 운영자가 붙인 이름(AUDIT_SECOND_OPINION_LABEL)이 먼저, 없으면 아는 Tailscale 장비 이름, 그것도 없으면 주소
  const qwenServer = env.AUDIT_SECOND_OPINION_LABEL?.trim() ? qwenDirectServerLabel(env) : serverName(qwenConfig?.baseUrl, qwenDirectServerLabel(env));
  for (const [step, owner, slot] of QWEN_STEPS) {
    if (owner !== job || !qwen?.[step]?.enabled) continue;
    const model = qwenConfig?.model ?? QWEN_DIRECT_DEFAULT_MODEL;
    models.push({ full: model, row: { slot, job: label(job), provider: "qwen-direct", runsOn: `Qwen 직접 서버 ${qwenServer}`,
      source: `크롤 설정 qwenAuto.${step} 켜짐 · 모델은 환경변수 AUDIT_SECOND_OPINION_MODEL(웹 기준)`, stats: null } });
    hosts.push({ name: qwenServer, row: { instanceId: qwenServer, what: "모델 서버 — Qwen 직접 호출", jobs: [label(job)], state: "켜짐", tone: null, release: null, seen: null } });
  }
  if (job === "audit-screen-review" && qwen?.screenReview?.enabled) {
    const config = screenModelConfig(env);
    const prompt = screenPromptConfig(config);
    const render = screenRenderConfig(env);
    const server = config ? serverName(config.baseUrl, new URL(config.baseUrl).host) : null;
    models.push({ full: config ? visionModelName(config.model, prompt!.version) : "설정 없음", row: { slot: "화면 판별", job: label(job), provider: "qwen-direct",
      runsOn: `Qwen 직접 서버 ${server ?? "설정 없음"} · 화면 서버 ${render ? new URL(render.baseUrl).host : "설정 없음(SCREEN_RENDER_URL)"}`,
      source: `크롤 설정 qwenAuto.screenReview 켜짐 · 판 ${prompt?.version ?? "설정 오류"} · 모델은 환경변수(웹 기준)`, stats: null } });
    if (server) hosts.push({ name: server, row: { instanceId: server, what: "모델 서버 — Qwen 화면 판별", jobs: [label(job)], state: "켜짐", tone: null, release: null, seen: null } });
  }
  return { models, hosts };
}

/** 상시 서비스의 장비와 LLM */
function serviceOwners(service: WorkService, ctx: OwnerContext): { models: ModelEntry[]; hosts: HostEntry[] } {
  const info = SERVICES[service];
  const nowMs = Date.parse(ctx.now);
  const hosts: HostEntry[] = service === "x-collector"
    ? [{ name: "Oracle", row: { instanceId: "osaka-smoke", what: info.label, jobs: [info.label], state: "하루 보고로만 관측", tone: null, release: null, seen: null } }]
    : ctx.instances.filter((row) => row.role === info.role && !consumerOfInstance(row.instanceId) && nowMs - timeOf(row.observedAt) <= LIVE_MS)
      .map((row) => {
        const fresh = nowMs - timeOf(row.observedAt) <= FRESH_MS;
        return { name: hostName(row.instanceId), row: { instanceId: row.instanceId, what: info.label, jobs: [info.label],
          state: fresh ? "관측 중" : "관측 지연", tone: fresh ? "ok" as const : "warn" as const, release: shortRelease(row.value.release), seen: formatAgo(row.observedAt, ctx.now) } };
      });
  const models: ModelEntry[] = [];
  const config = service === "connect-agent" ? ctx.agent?.config : undefined;
  if (config) {
    const instance = hosts[0]?.row.instanceId ?? "connect-agent";
    for (const [slot, choice] of [["분류 · 우선", config.primary], ["분류 · 예비", config.fallback]] as const) {
      if (!choice) continue;
      models.push({ name: choice.model, full: `${choice.model} · ${choice.effort}`, row: { slot, job: info.label, provider: choice.model === "sonnet" ? "Claude 계정" : "Codex 계정",
        runsOn: `AI 연결 서비스(${instance})`, source: `AI 연결 적용 설정 v${ctx.agent?.configVersion ?? "?"}`, stats: null } });
    }
  }
  return { models, hosts };
}

const HOST_ORDER = ["M3", "mini", "Oracle"];
/**
 * 운영 컨테이너가 MagicDNS 를 풀지 못해 코드·환경변수에 Tailscale IP 로 적힌 모델 서버(qwen-direct-review.ts·deepseek-review-policy.ts) —
 * 버튼에는 장비 이름으로 보인다. 모르는 주소는 주소 그대로다
 */
const TAILSCALE_HOSTS: Readonly<Record<string, string>> = { "100.77.43.63": "gpu3090", "100.92.77.66": "M3", "100.111.160.31": "m1-studio" };
function serverName(baseUrl: string | undefined, fallback: string): string {
  try { return baseUrl ? TAILSCALE_HOSTS[new URL(baseUrl).hostname] ?? fallback : fallback; } catch { return fallback; }
}

/** 조치 한 칸의 장비·LLM·작업 — 맡는 것이 하나도 없으면 null */
export function resolveWorkOwners(work: ActionWork | undefined, ctx: OwnerContext): WorkOwners | null {
  if (!work) return null;
  const env = ctx.env ?? process.env;
  const batch = ctx.batch ?? LEGACY_BATCH;
  const mode = batch.mode as BatchMode;
  const active = new Set(catalogJobsForBatch(batch).map((row) => row.name));
  const jobs = [...new Set([...(work.jobs ?? []), ...(work.roles ?? []).flatMap((role) => batchJobsForRole(role as BatchRole, mode))])]
    .filter((name) => active.has(name));
  const services = new Set(work.services ?? []);
  if (jobs.includes("crawl-publish")) services.add("connect-agent");

  const settings = ctx.settings;
  const slots = resolveModelSlots({ firstReview: settings.firstReview ?? null,
    secondReview: settings.secondReview ?? { voters: [], fallbacks: [] } } as Pick<CrawlSettings, "firstReview" | "secondReview">, env);

  const hostEntries: HostEntry[] = [], modelEntries: ModelEntry[] = [];
  // 같은 역할의 잡은 한 줄로 — 역할마다 그 역할이 맡은 이 칸의 잡
  const byRole = new Map<string, string[]>();
  for (const name of jobs) {
    const role = batchOwnerForJob(name, mode) ?? (JOB_CATALOG.find((row) => row.name === name)?.role === "scheduler" ? "scheduler" : null);
    if (role) byRole.set(role, [...(byRole.get(role) ?? []), name]);
    hostEntries.push(...consumerHostRows(name, ctx).map((row) => ({ name: hostName(row.instanceId), row })));
    const owned = jobModels(name, slots, ctx, env);
    hostEntries.push(...owned.hosts);
    modelEntries.push(...owned.models);
  }
  for (const [role, names] of byRole) hostEntries.unshift(...roleHostRows(role, names, ctx).map((row) => ({ name: row.instanceId === "—" ? "장비 미확인" : hostName(row.instanceId), row })));
  for (const service of services) {
    const owned = serviceOwners(service, ctx);
    hostEntries.push(...owned.hosts);
    modelEntries.push(...owned.models);
  }

  const hosts = new Map<string, HostRow[]>();
  for (const { name, row } of hostEntries) {
    const rows = hosts.get(name) ?? [];
    const same = rows.find((item) => item.instanceId === row.instanceId && item.what === row.what);
    if (same) same.jobs = [...new Set([...same.jobs, ...row.jobs])];
    else rows.push(row);
    hosts.set(name, rows);
  }
  const models = new Map<string, OwnerModel>();
  for (const { name: given, full, row } of modelEntries) {
    const name = given ?? modelName(full);
    const group = models.get(name) ?? { name, full, rows: [] };
    if (!group.rows.some((item) => item.slot === row.slot && item.job === row.job)) group.rows.push(row);
    models.set(name, group);
  }
  const rank = (name: string) => { const index = HOST_ORDER.indexOf(name); return index < 0 ? HOST_ORDER.length : index; };
  const jobRows = [...jobs.map((name) => jobRow(name, mode, ctx)),
    ...[...services].map((service): OwnerJob => ({ name: service, label: SERVICES[service].label, role: "상시 서비스", lane: "—",
      schedule: SERVICES[service].schedule, how: SERVICES[service].how, state: null, lastRun: null, lastSuccess: null, next: null }))];
  if (hosts.size === 0 && models.size === 0 && jobRows.length === 0) return null;

  const notes = [
    jobs.length > 0 && NOTES.schedule,
    hostEntries.some(({ row }) => consumerOfInstance(row.instanceId)) && NOTES.consumer,
    modelEntries.some(({ row }) => row.source.includes("웹 기준")) && NOTES.env,
  ].filter((note): note is string => typeof note === "string");
  return {
    hosts: [...hosts].map(([name, rows]) => ({ name, rows })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)),
    models: [...models.values()], jobs: jobRows, notes,
  };
}

/** 조치 칸마다 — 운영센터가 한 번 그릴 때 한 번 모은다 */
export function workOwnersByAction(items: readonly { key: string; work?: ActionWork }[], ctx: OwnerContext): Record<string, WorkOwners> {
  const result: Record<string, WorkOwners> = {};
  for (const item of items) {
    const owners = resolveWorkOwners(item.work, ctx);
    if (owners) result[item.key] = owners;
  }
  return result;
}
