import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { formatListTime } from "@/lib/format/time";
import { DEFAULT_MODEL_DEADLINES, DEFAULT_MODEL_DEFINITIONS, DEFAULT_MODEL_TIMEOUTS, type ModelDefinition } from "@/lib/llm/model-registry";
import { ROLE_LABELS } from "./contracts";
import { BUDGET_CALL_MARGIN_MS, DEFAULT_JOB_BUDGET_MS, DEFAULT_RUNTIME_SETTINGS, effectiveJobBudgetMs, JOB_CALL_ROUTES, JOB_LABELS, jobCallCeilingMs,
  resolveRuntimeSettings, routeCallCeilingMs, RUNTIME_BUDGET_MAX_MS, shortRuntimeSettingsVersion, storedSettingsVersion, type JobKnobName,
  type RuntimeSettings } from "./runtime-settings-schema";
import { latestRoleObservations, msToInput, RUNTIME_SETTINGS_ROLES, runtimeSettingsIssueMessage, storedLeaf, type AdminObservation, type AuditView,
  type LaneView, REVIEW_LADDER_ROUTE } from "./admin-runtime-settings";
import type { RuntimeSettingsRow } from "./runtime-settings";
import type { RoleSettingsApply, SettingsApply } from "./settings-apply";

/**
 * 「실시간 한도」(/admin/models/limits) 화면 모형 — 2026-11-11 개편(승인 시안 limits-mock, 소유자 「너가 권장하는 대로 해」).
 *
 * 예전 화면은 칸 약 104개를 저장 문서 구조(경로·사다리·번역·잡별 묶음·틱 예산)대로 늘어놓았다. 이 모형은 **AI 작업 한 줄**에
 * 그 작업이 실제로 읽는 칸(한 번 호출 상한·한 틱 시간·동시 호출·묶음)과 장부 24시간 실측(호출 수·p50/p99/최대·상한에서 끊김·미확정)을 나란히 둔다.
 * 읽는 코드가 없거나 다른 값이 덮어쓰는 칸은 그리지 않는다(저장 문서의 키는 그대로 두고 손대지 않는다 — 옛 문서도 그대로 읽힌다).
 * 경고는 「여유 15초」 같은 설정 규칙이 아니라 실측에서 고른 「지금 볼 것」이다(LIMITS_RULES 의 다섯 가지).
 *
 * 순수 — DB 없이 시험한다. 읽기는 admin-limits-repository.ts 가 한다. 클라이언트 폼은 여기서 만든 값(글자·숫자)만 받는다.
 */

// ---------- 작업 줄 정의 ----------

export type LimitsGroupId = "text" | "review" | "audit";
export const LIMITS_GROUP_LABELS: Readonly<Record<LimitsGroupId, string>> = { text: "글 작업", review: "심사", audit: "감사 · 쉬는 작업" };

/** 한 번 호출 상한이 어디서 오는가 */
type CapSpec =
  /** 경로 한도·상한·사다리 중 그 경로가 실제로 읽는 칸(routeCapPath) */
  | { kind: "route"; route: string; label?: string; note?: string }
  /** 잡별 묶음의 칸(소개 검수 callMs) */
  | { kind: "knob"; job: string; knob: JobKnobName }
  /** 코드에 고정된 값(읽기 전용) */
  | { kind: "fixed"; ms: number; note: string }
  /** 다른 줄의 값에서 나온다(읽기 전용) — 장부 분류용 상한은 잡의 호출 상한(jobCallCeilingMs) */
  | { kind: "derived"; job: string; note: string };
type TickSpec = { kind: "budget"; job: string } | { kind: "none"; text: string };
type ConcurrencySpec = { kind: "route"; route: string } | { kind: "text"; text: string; href?: string; knob?: { job: string; knob: JobKnobName; prefix: string } };
type DetailSpec = { kind: "knob"; job: string; knob: JobKnobName } | { kind: "maxTokens"; route: string; label?: string };

export type LimitsTaskSpec = Readonly<{
  id: string; group: LimitsGroupId; label: string; sub: string;
  /** 작업 ↔ 모델 순위(ai_task_models.task) — 「지금 모델」 */
  aiTask: string | null;
  /** 장부(model_capacity_requests.route_id) — 이 작업의 호출 */
  ledger: readonly string[];
  cap: CapSpec;
  /** 공급자마다 다른 상한(1차 심사: CLI 는 review-cli, Qwen 직접은 심사 사다리) — 장부 분류에만 쓴다 */
  providerCaps?: Readonly<Record<string, CapSpec>>;
  tick: TickSpec;
  concurrency: ConcurrencySpec;
  details: readonly DetailSpec[];
  /** 사람이 멈췄는지 볼 잡(비면 웹 요청·소비자) */
  jobs: readonly string[];
  note?: string;
}>;

const DEVICES_HREF = "/admin/models/devices";
const TASKS_HREF = "/admin/models/tasks#concurrency";
const knob = (job: string, name: JobKnobName): DetailSpec => ({ kind: "knob", job, knob: name });
const byDevice: ConcurrencySpec = { kind: "text", text: "장비 한도가 정함", href: DEVICES_HREF };
const ladderCap: CapSpec = { kind: "route", route: REVIEW_LADDER_ROUTE, label: "심사 호출 상한" };

/** 화면 순서 = 이 순서. id 는 줄의 닻(#row-<id>)과 「권장값 넣기」가 쓴다 */
export const LIMITS_TASKS: readonly LimitsTaskSpec[] = Object.freeze([
  // 글 작업
  { id: "reason-translate", group: "text", label: "사유 번역", sub: "심사 사유를 한국어로 옮깁니다", aiTask: "reason-translate", ledger: ["reason-translate"],
    cap: { kind: "route", route: "reason-translate" }, tick: { kind: "budget", job: "reason-translate" },
    concurrency: { kind: "text", text: "차례로 1건씩" },
    details: [knob("reason-translate", "minCallMs"), knob("reason-translate", "batch"), knob("reason-translate", "batchChars"), knob("reason-translate", "soloAttempts"),
      { kind: "maxTokens", route: "reason-translate" }], jobs: ["reason-translate"] },
  { id: "product-translate", group: "text", label: "공개 번역", sub: "공개 제품 글을 영어·중국어로 옮깁니다", aiTask: "product-translate", ledger: ["product-translate"],
    cap: { kind: "route", route: "product-translate" }, tick: { kind: "budget", job: "product-translate" },
    concurrency: { kind: "route", route: "product-translate" }, details: [{ kind: "maxTokens", route: "product-translate" }], jobs: ["product-translate"],
    note: "원문 글자 상한·묶음 글자·최대 시도는 공개 번역 화면에서 고칩니다." },
  { id: "product-tagline-ko", group: "text", label: "한국어 소개", sub: "공개 제품의 한 줄 소개를 한국어로 옮깁니다", aiTask: "product-tagline-ko",
    ledger: ["product-tagline-ko"], cap: { kind: "route", route: "product-tagline-ko" }, tick: { kind: "budget", job: "product-tagline-ko" },
    concurrency: { kind: "route", route: "product-tagline-ko" },
    details: [knob("product-tagline-ko", "minCallMs"), knob("product-tagline-ko", "batch"), knob("product-tagline-ko", "slowCallMs"), knob("product-tagline-ko", "soloAttempts")],
    jobs: ["product-tagline-ko"] },
  { id: "crawl-tagline", group: "text", label: "소개 생성", sub: "소개가 없는 후보의 한 줄 소개를 짓습니다", aiTask: "crawl-tagline", ledger: ["crawl-tagline"],
    cap: { kind: "route", route: "crawl-tagline" }, tick: { kind: "budget", job: "crawl-tagline" }, concurrency: { kind: "route", route: "crawl-tagline" },
    details: [knob("crawl-tagline", "minCallMs"), knob("crawl-tagline", "batch"), { kind: "maxTokens", route: "crawl-tagline" }], jobs: ["crawl-tagline"] },
  { id: "product-search-profile", group: "text", label: "검색 키워드", sub: "제품마다 검색 키워드를 짓습니다", aiTask: "product-search-profile",
    ledger: ["product-search-profile"], cap: { kind: "route", route: "product-search-profile" }, tick: { kind: "budget", job: "product-search-profile" },
    concurrency: { kind: "route", route: "product-search-profile" },
    details: [knob("product-search-profile", "minCallMs"), knob("product-search-profile", "batch"), { kind: "maxTokens", route: "product-search-profile" }],
    jobs: ["product-search-profile"] },
  { id: "product-search-verify", group: "text", label: "키워드 검수", sub: "지은 검색 키워드가 맞는지 봅니다", aiTask: "product-search-verify",
    ledger: ["product-search-verify"], cap: { kind: "route", route: "product-search-verify" }, tick: { kind: "budget", job: "product-search-verify" },
    concurrency: { kind: "route", route: "product-search-verify" },
    details: [knob("product-search-verify", "minCallMs"), knob("product-search-verify", "batch"), { kind: "maxTokens", route: "product-search-verify" }],
    jobs: ["product-search-verify"] },
  { id: "search-query-translate", group: "text", label: "검색어 번역", sub: "웹 검색어를 영어로 옮깁니다(웹 요청마다)", aiTask: "search-query-translate",
    ledger: ["search-query-translate"], cap: { kind: "route", route: "search-query-translate" }, tick: { kind: "none", text: "틱 없음 — 웹 요청" },
    concurrency: { kind: "text", text: "웹 요청마다" }, details: [{ kind: "maxTokens", route: "search-query-translate" }], jobs: [] },
  // 심사
  { id: "first-review", group: "review", label: "1차 심사", sub: "수집한 후보를 처음 읽고 승인·거절·보류를 정합니다", aiTask: "first-review", ledger: ["crawl-agent-review"],
    cap: { kind: "route", route: "review-cli", label: "CLI 호출 상한", note: "Qwen 직접 호출은 2차 심사 상한을 함께 씁니다" },
    providerCaps: { abcllm: ladderCap, "local-direct": ladderCap }, tick: { kind: "budget", job: "crawl-agent-review" }, concurrency: byDevice, details: [],
    jobs: ["crawl-agent-review"] },
  { id: "second-review", group: "review", label: "2차 심사", sub: "1차 결과를 투표자 셋이 다시 봅니다", aiTask: "second-review", ledger: ["second-review"],
    cap: { ...ladderCap, note: "1차 심사의 Qwen 직접 호출도 이 값을 씁니다" }, tick: { kind: "none", text: "소비자가 처리 — 틱 없음" },
    concurrency: { kind: "text", text: "작업 배정에서 정함", href: TASKS_HREF, knob: { job: "second-review", knob: "consumerConcurrency", prefix: "소비자 동시" } },
    details: [{ kind: "maxTokens", route: "gateway-review", label: "심사 응답 토큰 상한(1차 Qwen·2차 공통)" }], jobs: [] },
  { id: "human-review", group: "review", label: "사람 큐 심사", sub: "사람 몫 심사를 모델에 맡깁니다", aiTask: "human-review", ledger: ["local-human-deepseek"],
    cap: { kind: "route", route: "human-review" }, tick: { kind: "budget", job: "human-deepseek-review" }, concurrency: byDevice,
    details: [{ kind: "maxTokens", route: "human-review" }], jobs: ["human-deepseek-review"] },
  { id: "held-review-retry", group: "review", label: "보류 재심사", sub: "보류된 후보를 다시 봅니다", aiTask: "held-review-retry", ledger: ["local-held-qwen"],
    cap: { kind: "route", route: "held-review-retry" }, tick: { kind: "budget", job: "held-qwen-retry" }, concurrency: byDevice, details: [], jobs: ["held-qwen-retry"] },
  { id: "split-tiebreak", group: "review", label: "갈림 판정", sub: "2차 투표가 갈린 후보를 가립니다", aiTask: "split-tiebreak", ledger: ["local-qwen-tiebreak"],
    cap: { kind: "route", route: "split-tiebreak" }, tick: { kind: "budget", job: "split-tiebreak" }, concurrency: byDevice, details: [], jobs: ["split-tiebreak"] },
  { id: "split-confirm", group: "review", label: "갈림 확인", sub: "갈린 후보를 한 번 더 확인합니다", aiTask: "split-confirm", ledger: ["local-deepseek-confirm"],
    cap: { kind: "route", route: "split-confirm" }, tick: { kind: "budget", job: "split-confirm" }, concurrency: byDevice, details: [], jobs: ["split-confirm"] },
  { id: "publish-classify", group: "review", label: "발행 분류", sub: "발행 전에 카테고리를 고릅니다", aiTask: "publish-classify", ledger: ["crawl-publish-classify"],
    cap: { kind: "fixed", ms: 60_000, note: "코드에 고정(lib/crawl/publication-classify-pool.ts) — 남은 틱 시간이 더 짧으면 그만큼" },
    tick: { kind: "budget", job: "crawl-publish" },
    concurrency: { kind: "text", text: "작업 배정에서 정함", href: TASKS_HREF, knob: { job: "crawl-publish", knob: "classifierConcurrency", prefix: "동시 묶음" } },
    details: [], jobs: ["crawl-publish"] },
  // 감사·쉬는 작업
  { id: "product-audit", group: "audit", label: "제품 감사", sub: "사람이 연 발행분 감사와 변경 재판정", aiTask: "product-audit", ledger: ["product-audit"],
    cap: { kind: "derived", job: "product-audit", note: "1차 심사(CLI) 상한과 심사 호출 상한 중 긴 쪽" }, tick: { kind: "budget", job: "product-audit" },
    concurrency: byDevice, details: [], jobs: ["product-audit"] },
  { id: "audit-qwen", group: "audit", label: "Qwen 직접 감사", sub: "공개된 제품을 Qwen 으로 다시 감사합니다", aiTask: "audit-review", ledger: ["local-audit"],
    cap: { kind: "route", route: "product-audit", label: "Qwen 직접 감사 호출 상한" }, tick: { kind: "budget", job: "audit-qwen" }, concurrency: byDevice, details: [],
    jobs: ["audit-qwen"] },
  { id: "audit-second-opinion", group: "audit", label: "감사 2차 의견", sub: "감사 결과에 두 번째 의견을 붙이고 공개분을 다시 거릅니다",
    aiTask: "audit-second-opinion", ledger: ["local-second-opinion", "local-published-filter"], cap: { kind: "route", route: "audit-second-opinion" },
    tick: { kind: "budget", job: "audit-second-opinion" }, concurrency: byDevice, details: [], jobs: ["audit-second-opinion"] },
  { id: "screen-review", group: "audit", label: "화면 판별", sub: "제품 화면 사진을 보고 판별합니다", aiTask: "screen-review", ledger: ["local-screen"],
    cap: { kind: "route", route: "screen-review", note: "화면을 찍는 40초가 앞에 더 붙습니다" }, tick: { kind: "budget", job: "audit-screen-review" },
    concurrency: byDevice, details: [], jobs: ["audit-screen-review"] },
  { id: "product-intro-check", group: "audit", label: "소개 검수", sub: "AI 소개를 근거와 대조해 고칩니다", aiTask: "product-intro-check", ledger: ["product-intro-check"],
    cap: { kind: "knob", job: "product-intro-check", knob: "callMs" }, tick: { kind: "budget", job: "product-intro-check" }, concurrency: byDevice,
    details: [knob("product-intro-check", "minCallMs"), { kind: "maxTokens", route: "product-intro-check" }], jobs: ["product-intro-check"] },
] satisfies LimitsTaskSpec[]);

/** 작업 줄에도, 「AI 밖 작업의 틱 시간」에도 그리지 않는 틱 예산 — 한 번도 돈 적 없음(사이트 근거 갱신) · 소비자가 일을 함(2차 심사) */
export const HIDDEN_BUDGET_JOBS: readonly string[] = Object.freeze(["product-site-evidence-refresh", "second-review"]);

// ---------- 화면 값 ----------

export type LimitsLevel = "bad" | "warn" | "info" | "ok" | "off";
/** 입력 칸 하나 — 이름 규약은 runtimeSettingsPatchFromForm(value:·initial:·stored:·reset:·auto:·initialAuto:) 그대로 */
export type LimitsField = {
  path: string; label: string; kind: "ms" | "int"; unit: string;
  /** 처음 그린 글자(ms 칸은 초). 값이 없던 칸도 실제로 쓰이는 값으로 채운다 — 빈칸을 그리지 않는다 */
  initial: string; defaultInput: string;
  /** 저장 문서에 이 키가 있다 */
  overridden: boolean;
  /** 화면 단위(초·건) 입력 범위 — 스키마 범위 안 */
  min: number; max: number;
  note?: string;
  /** ms 칸: 이보다 길게 적어도 실제 상한은 이 값(등록부 모델 상한) */
  ceilingMs: number | null;
};
export type LimitsBudgetField = LimitsField & {
  auto: boolean; autoAllowed: boolean;
  /** 저장 문서·코드 기본값에 예산이 있다(없으면 runner 기본 25초로 돈다) */
  declared: boolean;
  /** 「자동」 = 호출 상한(아래 칸 중 가장 긴 것, 모델 상한으로 자름) + 덧붙는 시간 + 자동 틱 여유 */
  autoFrom: { path: string | null; fixedMs: number | null; ceilingMs: number | null }[];
  autoExtraMs: number;
};
export type LimitsCap = { kind: "field"; field: LimitsField; note: string | null }
  /** 읽기 전용 — sources 가 있으면 다른 줄의 칸(1차 CLI·심사 상한)에서 화면이 바로 다시 센다 */
  | { kind: "text"; text: string; note: string | null; sources?: LimitsBudgetField["autoFrom"] };
export type LimitsTick = { kind: "field"; field: LimitsBudgetField } | { kind: "text"; text: string };
export type LimitsConcurrency = { kind: "field"; field: LimitsField } | { kind: "text"; text: string; href: string | null };
export type DeviceSlots = { deviceId: string; slots: number };

/** 장부 24시간 실측 — admin-limits-repository.ts readLimitsMeasurement 가 작업마다 모은다 */
export type LimitsTaskMeasure = {
  /** 정산된 호출(settled) — 보낸 시각부터 정산까지 */
  calls: number; p50Ms: number | null; p99Ms: number | null; maxMs: number | null;
  /** 정산된 호출 중 상한 - 1초 이상 걸린 것(상한에서 끊김) */
  cutAtCap: number;
  /** 결과 미확정이 된 호출(dispatch_indeterminate) */
  unknown: number;
  /** 미확정 중 시간·중단으로 끊긴(client_timeout·local_abort) 것이 상한 - 2초보다 짧았다 = 틱이 끝나며 끊김 */
  tickCut: number; tickCutMinMs: number | null; tickCutMaxMs: number | null;
  /** 미확정 중 상한 근처(상한 - 2초 이상)에서 끊긴 것 */
  unknownAtCap: number;
  /** 보내기 전에 취소된 예약(withdrawn, 보낸 적 없음) */
  cancelled: number;
};
export type LimitsMeasurement = {
  measuredAt: string;
  tasks: Readonly<Record<string, LimitsTaskMeasure>>;
  /** 작업 × 공급자 × 모델 × 장비 — 정산 호출 수 */
  mix: readonly { task: string; provider: string; model: string; groupId: string; calls: number }[];
  devices: readonly { deviceId: string; limitSlots: number; enabled: boolean; modelLimits: readonly { model: string; maxSlots: number }[] }[];
  policyRoutes: readonly { routeId: string; provider: string; model: string; groupId: string }[];
  /** name = 사용자가 정한 모델 이름(연결의 displayName·이름표). 옛 담긴 값에는 없다 — 그때는 model */
  ranks: readonly { task: string; slot: number; rank: number; model: string; enabled: boolean; name?: string | null }[];
};
/** 장부 SQL 에 넘기는 지도: 장부 route → 작업 줄·분류 상한(ms) */
export type LimitsMeasureMap = Record<string, { task: string; capMs: number | null; providers?: Record<string, number> }>;

export type LimitsRow = {
  id: string; anchor: string; group: LimitsGroupId; label: string; sub: string; note: string | null;
  /** 지금 모델 — 「1순위 X · 2순위 Y」 또는 24시간 장부의 모델 */
  models: string | null;
  /** 지금의 실제 호출 상한(ms) — 막대·규칙의 기준 */
  capMs: number | null;
  cap: LimitsCap; tick: LimitsTick; concurrency: LimitsConcurrency;
  details: LimitsField[];
  /** 「새 호출을 시작할 최소 남은 시간」 칸(틱 시간표를 그린다) */
  minCallPath: string | null;
  measure: LimitsTaskMeasure | null;
  status: { level: LimitsLevel; text: string; note: string | null };
  /** 이 줄의 잡이 모두 사람이 멈춘 상태(모르면 null) */
  paused: boolean | null;
  slots: DeviceSlots | null;
};
export type LimitsFill = { path: string; value: string; auto?: false };
export type LimitsTodo = { id: string; level: "bad" | "warn" | "info"; tag: string; rowId: string; task: string; title: string; evidence: string; fills: LimitsFill[] };
export type LimitsAdvancedRow = { job: string; label: string; role: string; roleLabel: string; field: LimitsBudgetField; lane: LaneView | null; supervisorFloorMs: number | null };
export type LimitsRoleDiag = { role: string; label: string; state: RoleSettingsApply["state"] | "unread"; version: string | null; observedAt: number | null;
  registryEnv: boolean; running: string[] };
export type LimitsView = {
  revision: number | null; version: string; shortVersion: string; updatedBy: string | null; updatedAt: string | null; rowError: string | null;
  readOnly: boolean; issues: string[];
  /** 자동 틱 여유(translation.product.jobMarginMs) — 「자동」 틱 = 호출 상한 + 이 값 */
  margin: LimitsField;
  groups: { id: LimitsGroupId; label: string; rows: LimitsRow[] }[];
  todos: LimitsTodo[];
  advanced: { role: string; roleLabel: string; rows: LimitsAdvancedRow[] }[];
  /** 심사 사다리의 선언 층 지금 값(초 글자) — 클라이언트 기한을 낮추면 저장이 순서를 맞춘다(deriveReviewLadder) */
  ladder: { gatewayMs: string; engineMs: string; relayMs: string };
  measuredAt: string | null; measureError: string | null;
  unknownHoldSeconds: number;
  apply: SettingsApply | null; roles: LimitsRoleDiag[];
  audit: AuditView[];
};

// ---------- 규칙 문턱 ----------

/** (a) 틱 끝에서 잘린 미확정이 이만큼 있어야 올린다 */
export const TICK_CUT_MIN = 3;
/** 미확정이 상한보다 이만큼 짧으면 상한이 아니라 틱이 끊었다 */
export const TICK_CUT_SLACK_MS = 2_000;
/** (c) 상한이 느슨하다고 보려면 이만큼 호출이 있어야 하고, 상한이 최대의 3배보다 크고 60초 넘게 남아야 한다 */
export const LOOSE_CAP_MIN_CALLS = 200;
export const LOOSE_CAP_FACTOR = 3;
export const LOOSE_CAP_MARGIN_MS = 60_000;
/** (d) 상한에서 끊긴 비율·건수 */
export const CAP_HIT_RATE = 0.01;
export const CAP_HIT_MIN = 5;
/** 이보다 적은 호출은 「자료 부족」 */
export const FEW_CALLS = 20;

// ---------- 도우미 ----------

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fmt = (value: number) => value.toLocaleString("ko-KR");
/** ms → "12초"(소수 한 자리까지, 10초 넘으면 정수) */
export function secondsText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = ms / 1000;
  return `${seconds >= 10 ? fmt(Math.round(seconds)) : String(Math.round(seconds * 10) / 10)}초`;
}
const roundUp = (ms: number, step: number) => Math.ceil(ms / step) * step;

/** 경로의 호출 상한이 저장되는 칸 — 사다리면 clientMs, 등록부 상한표(timeouts)에 있으면 그 칸, 아니면 경로 한도의 timeoutMs */
export function routeCapPath(route: string, settings: RuntimeSettings): string | null {
  if (DEFAULT_MODEL_DEADLINES[route] || settings.routes.deadlines[route]) return `routes.deadlines.${route}.clientMs`;
  if (route in DEFAULT_MODEL_TIMEOUTS || settings.routes.timeouts[route] !== undefined) return `routes.timeouts.${route}`;
  if (settings.routes.limits[route]) return `routes.limits.${route}.timeoutMs`;
  return null;
}
/** 그 경로를 맡은 등록부 모델의 상한 — 경로 값이 이보다 길면 이 값이 실제 상한이다(modelTimeoutMs 의 min). 사다리·상한표 경로는 없다 */
function routeModelCeilingMs(route: string, settings: RuntimeSettings, models: readonly ModelDefinition[]): number | null {
  const path = routeCapPath(route, settings);
  if (!path || !path.startsWith("routes.limits.")) return null;
  const limits = { ...settings.routes.limits, [route]: { ...settings.routes.limits[route], timeoutMs: RUNTIME_BUDGET_MAX_MS } };
  const ceiling = routeCallCeilingMs(route, { ...settings, routes: { ...settings.routes, limits } }, models);
  return ceiling !== null && ceiling < RUNTIME_BUDGET_MAX_MS ? ceiling : null;
}

const KNOB_FIELD: Readonly<Partial<Record<JobKnobName, { label: string; unit: string; note?: string }>>> = {
  minCallMs: { label: "새 호출을 시작할 최소 남은 시간", unit: "초", note: "틱에 이만큼 남아 있어야 새 호출을 시작합니다. 호출 상한보다 짧으면 늦게 시작한 호출이 틱 끝에서 잘립니다" },
  batch: { label: "한 번에 묶는 수", unit: "건" },
  batchChars: { label: "한 묶음 글자 수", unit: "자" },
  soloAttempts: { label: "이만큼 실패하면 혼자 보냄", unit: "회" },
  slowCallMs: { label: "느린 호출로 보는 시간", unit: "초", note: "호출이 이보다 오래 걸리면 다음 틱의 묶음을 줄입니다" },
  callMs: { label: "한 번 호출 상한", unit: "초" },
  consumerConcurrency: { label: "소비자 동시 업무", unit: "건" },
  classifierConcurrency: { label: "분류 동시 묶음", unit: "건" },
};
/** 잡별 묶음 손잡이의 스키마 범위(jobKnobsSchema) — 화면 단위(ms 칸은 초) */
const KNOB_RANGE: Readonly<Partial<Record<JobKnobName, [number, number]>>> = {
  batch: [1, 64], batchChars: [100, 30_000], minCallMs: [1, 600], slowCallMs: [1, 600], soloAttempts: [1, 10], callMs: [5, 600],
  consumerConcurrency: [1, 4], classifierConcurrency: [1, 4],
};

type BuildContext = { stored: Record<string, unknown>; settings: RuntimeSettings; models: readonly ModelDefinition[] };
const leafNumber = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

function limitsField(ctx: BuildContext, path: string, options: { label: string; unit: string; kind: "ms" | "int"; min: number; max: number; note?: string;
  /** 저장·기본값이 모두 없을 때 실제로 쓰이는 값(사람 큐 심사의 등록부 모델 상한 등) */
  fallbackValue?: number | null; ceilingMs?: number | null }): LimitsField {
  const value = leafNumber(storedLeaf(ctx.settings, path)) ?? options.fallbackValue ?? null;
  const base = leafNumber(storedLeaf(DEFAULT_RUNTIME_SETTINGS, path));
  const leaf = storedLeaf(ctx.stored, path);
  const toInput = (raw: number | null) => raw === null ? "" : options.kind === "ms" ? msToInput(raw) : String(raw);
  return { path, label: options.label, kind: options.kind, unit: options.unit, initial: toInput(value), defaultInput: toInput(base),
    overridden: leaf !== undefined && leaf !== null, min: options.min, max: options.max, ceilingMs: options.ceilingMs ?? null, ...(options.note ? { note: options.note } : {}) };
}

/** 틱 예산 칸 — auto 는 지금 풀이(초)를, 적지 않은 잡은 runner 기본 25초를 글자로 넣는다(빈칸을 그리지 않는다) */
export function budgetField(ctx: BuildContext, job: string, label: string): LimitsBudgetField {
  const path = `budgets.${job}`;
  const raw = ctx.settings.budgets[job], base = DEFAULT_RUNTIME_SETTINGS.budgets[job];
  const declared = raw !== undefined, auto = raw === "auto";
  const call = JOB_CALL_ROUTES[job];
  const ceiling = jobCallCeilingMs(job, ctx.settings, ctx.models);
  const value = effectiveJobBudgetMs(job, ctx.settings, ctx.models);
  const baseValue = base === undefined ? DEFAULT_JOB_BUDGET_MS : base === "auto" ? effectiveJobBudgetMs(job, DEFAULT_RUNTIME_SETTINGS, ctx.models) : base;
  const leaf = storedLeaf(ctx.stored, path);
  const autoFrom = !call ? [] : call.knob
    ? [{ path: `jobs.${job}.${call.knob}`, fixedMs: leafNumber(ctx.settings.jobs[job]?.[call.knob]), ceilingMs: null }]
    : [call.route, ...(call.orRoutes ?? [])].map(route => ({ path: routeCapPath(route, ctx.settings), fixedMs: routeCallCeilingMs(route, ctx.settings, ctx.models),
      ceilingMs: routeModelCeilingMs(route, ctx.settings, ctx.models) }));
  return { path, label: `${label} 틱 시간`, kind: "ms", unit: "초", initial: msToInput(value), defaultInput: msToInput(baseValue),
    overridden: leaf !== undefined && leaf !== null, min: 5, max: RUNTIME_BUDGET_MAX_MS / 1000, ceilingMs: null,
    ...(declared ? {} : { note: `적힌 값이 없어 기본 ${secondsText(DEFAULT_JOB_BUDGET_MS)}로 돕니다` }),
    auto, autoAllowed: ceiling !== null, declared, autoFrom, autoExtraMs: call?.extraMs ?? 0 };
}

/** 경로·손잡이·고정 — 지금의 실제 호출 상한(ms) */
function capMsOf(spec: CapSpec, ctx: BuildContext): number | null {
  switch (spec.kind) {
    case "route": return routeCallCeilingMs(spec.route, ctx.settings, ctx.models);
    case "knob": return leafNumber(ctx.settings.jobs[spec.job]?.[spec.knob]);
    case "fixed": return spec.ms;
    case "derived": return jobCallCeilingMs(spec.job, ctx.settings, ctx.models);
  }
}

function capView(task: LimitsTaskSpec, ctx: BuildContext): LimitsCap {
  const spec = task.cap;
  if (spec.kind === "fixed") return { kind: "text", text: secondsText(spec.ms), note: spec.note };
  if (spec.kind === "derived") return { kind: "text", text: secondsText(capMsOf(spec, ctx)), note: spec.note, sources: budgetField(ctx, spec.job, task.label).autoFrom };
  if (spec.kind === "knob")
    return { kind: "field", note: null, field: limitsField(ctx, `jobs.${spec.job}.${spec.knob}`, { label: `${task.label} 호출 상한`, unit: "초", kind: "ms", min: 5, max: 600 }) };
  const path = routeCapPath(spec.route, ctx.settings);
  if (!path) return { kind: "text", text: secondsText(capMsOf(spec, ctx)), note: spec.note ?? null };
  const ceilingMs = routeModelCeilingMs(spec.route, ctx.settings, ctx.models);
  const effective = capMsOf(spec, ctx);
  const field = limitsField(ctx, path, { label: `${spec.label ?? `${task.label} 호출 상한`}`, unit: "초", kind: "ms",
    min: path.endsWith(".clientMs") ? 15 : 1, max: RUNTIME_BUDGET_MAX_MS / 1000, fallbackValue: effective, ceilingMs });
  // 값을 적지 않은 경로(사람 큐 심사)는 등록부 모델 상한이 실제 상한이다 — 숨은 값을 칸에 보인다
  const hidden = leafNumber(storedLeaf(ctx.settings, path)) === null && effective !== null
    ? `값을 적지 않아 등록부 모델 상한 ${secondsText(effective)}로 돕니다` : null;
  return { kind: "field", field, note: [hidden, spec.note].filter(Boolean).join(" · ") || null };
}

function concurrencyView(task: LimitsTaskSpec, ctx: BuildContext): LimitsConcurrency {
  const spec = task.concurrency;
  if (spec.kind === "route") return { kind: "field", field: limitsField(ctx, `routes.limits.${spec.route}.concurrency`,
    { label: `${task.label} 동시 호출`, unit: "건", kind: "int", min: 1, max: 64 }) };
  const value = spec.knob ? leafNumber(ctx.settings.jobs[spec.knob.job]?.[spec.knob.knob]) : null;
  return { kind: "text", text: spec.knob && value !== null ? `${spec.text} (지금 ${spec.knob.prefix} ${value})` : spec.text, href: spec.href ?? null };
}

function detailFields(task: LimitsTaskSpec, ctx: BuildContext): LimitsField[] {
  return task.details.flatMap((spec): LimitsField[] => {
    if (spec.kind === "maxTokens") {
      if (!ctx.settings.routes.limits[spec.route]) return [];
      return [limitsField(ctx, `routes.limits.${spec.route}.maxTokens`, { label: spec.label ?? "응답 토큰 상한", unit: "토큰", kind: "int", min: 1, max: 262_144 })];
    }
    const meta = KNOB_FIELD[spec.knob], range = KNOB_RANGE[spec.knob];
    if (!meta || !range || ctx.settings.jobs[spec.job]?.[spec.knob] === undefined) return [];
    return [limitsField(ctx, `jobs.${spec.job}.${spec.knob}`, { label: meta.label, unit: meta.unit, kind: spec.knob.endsWith("Ms") ? "ms" : "int",
      min: range[0], max: range[1], ...(meta.note ? { note: meta.note } : {}) })];
  });
}

/** 장부 SQL 의 지도 — 작업 줄의 장부 route 마다 분류 상한(공급자마다 다르면 providers) */
export function limitsMeasureMap(settings: RuntimeSettings, models: readonly ModelDefinition[] = DEFAULT_MODEL_DEFINITIONS): LimitsMeasureMap {
  const ctx: BuildContext = { stored: {}, settings, models };
  const map: LimitsMeasureMap = {};
  for (const task of LIMITS_TASKS) {
    const capMs = capMsOf(task.cap, ctx);
    const providers = task.providerCaps ? Object.fromEntries(Object.entries(task.providerCaps).flatMap(([provider, spec]) => {
      const value = capMsOf(spec, ctx);
      return value === null ? [] : [[provider, value]];
    })) : undefined;
    for (const route of task.ledger) map[route] = { task: task.id, capMs, ...(providers && Object.keys(providers).length ? { providers } : {}) };
  }
  return map;
}

/** 작업 줄의 장비 칸 수 — 24시간 장부가 쓴 장비(없으면 정책 route)마다 min(장비 칸, 그 모델의 상한) 중 가장 큰 것 */
function deviceSlots(task: LimitsTaskSpec, measurement: LimitsMeasurement | null): DeviceSlots | null {
  if (!measurement) return null;
  const used = measurement.mix.filter(row => row.task === task.id && row.calls > 0).map(row => ({ groupId: row.groupId, model: row.model }));
  const pairs = used.length ? used : measurement.policyRoutes.filter(route => task.ledger.includes(route.routeId)).map(route => ({ groupId: route.groupId, model: route.model }));
  let best: DeviceSlots | null = null;
  for (const pair of pairs) {
    const device = measurement.devices.find(entry => entry.deviceId === pair.groupId && entry.enabled);
    if (!device) continue;
    const modelCap = device.modelLimits.find(limit => limit.model === pair.model)?.maxSlots;
    const slots = Math.min(device.limitSlots, modelCap ?? device.limitSlots);
    if (!best || slots > best.slots) best = { deviceId: device.deviceId, slots };
  }
  return best;
}

/** 지금 모델 — 순위가 있으면 「1순위 X · 2순위 Y」(여러 칸이면 칸 수), 없으면 24시간 장부의 모델(호출 많은 순) */
function modelsText(task: LimitsTaskSpec, measurement: LimitsMeasurement | null): string | null {
  if (!measurement) return null;
  const ranks = measurement.ranks.filter(row => row.task === task.aiTask && row.enabled);
  const slots = [...new Set(ranks.map(row => row.slot))];
  const shown = (row: (typeof ranks)[number]) => row.name || row.model;
  if (slots.length > 1) return `${slots.length}칸 · ${[...new Set(ranks.filter(row => row.rank === 1).map(shown))].join(" · ")}`;
  if (ranks.length) return [...ranks].sort((a, b) => a.rank - b.rank).slice(0, 3).map(row => `${row.rank}순위 ${shown(row)}`).join(" · ");
  const seen = new Map<string, number>();
  for (const row of measurement.mix.filter(entry => entry.task === task.id)) seen.set(row.model, (seen.get(row.model) ?? 0) + row.calls);
  return seen.size ? [...seen].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([model]) => model).join(" · ") : null;
}

// ---------- 장부 SQL 행 → 실측 ----------

/** 장부 SQL 한 번의 결과(작업마다·모델마다) — 순수 조립은 limitsMeasurementFromRows */
export type LimitsMeasureRows = { measuredAt: string; tasks: readonly TaskRow[]; mix: readonly MixRow[]; unknowns: readonly UnknownRow[];
  devices: readonly DeviceRow[]; policyRoutes: unknown; ranks: readonly RankRow[] };
type TaskRow = { task: string; calls: number | string; p50: number | string | null; p99: number | string | null; maxMs: number | string | null; cutAtCap: number | string };
type MixRow = { task: string; provider: string; model: string; groupId: string; calls: number | string };
type UnknownRow = { task: string; unknown: number | string; tickCut: number | string; tickMin: number | string | null; tickMax: number | string | null;
  atCap: number | string; cancelled: number | string };
type DeviceRow = { deviceId: string; limitSlots: number | string; enabled: boolean; modelLimits: unknown };
type RankRow = { task: string; slot: number | string; rank: number | string; model: string; enabled: boolean; name?: string | null };

const num = (value: number | string | null | undefined): number => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const numOrNull = (value: number | string | null | undefined): number | null => value === null || value === undefined ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/** 순수 — SQL 행을 화면 모형의 실측으로. 작업이 지도에 없으면 버린다 */
export function limitsMeasurementFromRows(input: LimitsMeasureRows): LimitsMeasurement {
  const tasks: Record<string, LimitsTaskMeasure> = {};
  const blank = (): LimitsTaskMeasure => ({ calls: 0, p50Ms: null, p99Ms: null, maxMs: null, cutAtCap: 0, unknown: 0, tickCut: 0, tickCutMinMs: null, tickCutMaxMs: null,
    unknownAtCap: 0, cancelled: 0 });
  for (const row of input.tasks) tasks[row.task] = { ...blank(), calls: num(row.calls), p50Ms: numOrNull(row.p50), p99Ms: numOrNull(row.p99), maxMs: numOrNull(row.maxMs),
    cutAtCap: num(row.cutAtCap) };
  for (const row of input.unknowns) {
    const entry = tasks[row.task] ?? blank();
    tasks[row.task] = { ...entry, unknown: num(row.unknown), tickCut: num(row.tickCut), tickCutMinMs: numOrNull(row.tickMin), tickCutMaxMs: numOrNull(row.tickMax),
      unknownAtCap: num(row.atCap), cancelled: num(row.cancelled) };
  }
  const routes = Array.isArray(input.policyRoutes) ? input.policyRoutes : [];
  return {
    measuredAt: input.measuredAt, tasks,
    mix: input.mix.map(row => ({ task: row.task, provider: row.provider, model: row.model, groupId: row.groupId, calls: num(row.calls) })),
    devices: input.devices.map(row => ({ deviceId: row.deviceId, limitSlots: num(row.limitSlots), enabled: row.enabled === true,
      modelLimits: (Array.isArray(row.modelLimits) ? row.modelLimits : []).flatMap(limit => limit && typeof limit === "object"
        && typeof (limit as { model?: unknown }).model === "string" && Number.isFinite(Number((limit as { max_slots?: unknown }).max_slots))
        ? [{ model: (limit as { model: string }).model, maxSlots: Number((limit as { max_slots: unknown }).max_slots) }] : []) })),
    policyRoutes: routes.flatMap(route => route && typeof route === "object" && typeof route.routeId === "string" && typeof route.groupId === "string"
      ? [{ routeId: String(route.routeId), provider: String(route.provider ?? ""), model: String(route.model ?? ""), groupId: String(route.groupId) }] : []),
    ranks: input.ranks.map(row => ({ task: row.task, slot: num(row.slot), rank: num(row.rank), model: row.model, enabled: row.enabled === true,
      ...(typeof row.name === "string" && row.name ? { name: row.name } : {}) })),
  };
}

// ---------- 규칙(「지금 볼 것」) ----------

type RuleInput = { task: LimitsTaskSpec; row: Omit<LimitsRow, "status">; settings: RuntimeSettings; holdSeconds: number; savedAt: string | null; now: Date };
type RuleResult = { todos: LimitsTodo[]; status: LimitsRow["status"] | null };
const inputMs = (field: LimitsField | null) => field && field.initial !== "" ? Math.round(Number(field.initial) * 1000) : null;
const msInput = (ms: number) => msToInput(ms);

/** (a) 틱이 끝나며 진행 중이던 호출이 잘려 결과 미확정 — 새 호출 시작 조건 ≥ 상한, 틱 시간 ≥ 시작 조건 + 상한 + 10초를 권한다 */
function tickCutRule({ task, row, holdSeconds, savedAt, now }: RuleInput): RuleResult {
  const m = row.measure, cap = row.capMs;
  if (!m || cap === null || m.tickCut < TICK_CUT_MIN || row.tick.kind !== "field") return { todos: [], status: null };
  const budget = row.tick.field, minCall = row.details.find(field => field.path === row.minCallPath) ?? null;
  const budgetNow = inputMs(budget) ?? 0, minCallNow = inputMs(minCall);
  const minCallRec = minCall && minCallNow !== null ? Math.max(minCallNow, cap) : null;
  const budgetRec = roundUp(Math.max(budgetNow, (minCallRec ?? cap) + cap + 10_000), 5_000);
  const fills: LimitsFill[] = [];
  if (minCall && minCallRec !== null && minCallRec !== minCallNow) fills.push({ path: minCall.path, value: msInput(minCallRec) });
  if (budgetRec !== budgetNow || budget.auto) fills.push({ path: budget.path, value: msInput(budgetRec), auto: false });
  const range = m.tickCutMinMs !== null && m.tickCutMaxMs !== null ? `${secondsText(m.tickCutMinMs)}~${secondsText(m.tickCutMaxMs)}` : "";
  const evidence = `24시간 미확정 ${fmt(m.unknown)}건 중 ${fmt(m.tickCut)}건이 상한 ${secondsText(cap)}보다 짧은 ${range}에 끊겼습니다. `
    + `미확정 한 건은 장비 칸 하나를 ${fmt(holdSeconds)}초 동안 막습니다.`;
  if (!fills.length) return { status: { level: "info", text: "바꾼 뒤 지켜봄", note: `설정은 이미 권장값 이상입니다${savedAt ? ` — 마지막 저장 ${formatListTime(savedAt, now)}` : ""}` },
    todos: [{ id: `${task.id}:tick-cut`, level: "info", tag: "확인할 것", rowId: task.id, task: task.label, title: "틱 끝에서 끊긴 호출이 있었지만 설정은 이미 권장값 이상입니다",
      evidence: `${evidence} 24시간 안의 끊김은 마지막 저장 전의 호출일 수 있습니다 — 내일 같은 숫자가 다시 보이면 그때 다시 봅니다.`, fills: [] }] };
  const rec = fills.map(fill => fill.path === budget.path ? `틱 시간 ${secondsText(budgetNow)}→${fill.value}초` : `새 호출 시작 조건 ${secondsText(minCallNow)}→${fill.value}초`);
  return { status: { level: "bad", text: "틱 끝에서 잘림", note: null }, todos: [{ id: `${task.id}:tick-cut`, level: "bad", tag: "고칠 것", rowId: task.id, task: task.label,
    title: "틱이 끝날 때 진행 중이던 호출이 잘려 결과 미확정이 됩니다", evidence: `${evidence} ${rec.join(", ")}를 권합니다.`, fills }] };
}

/** (b) 작업의 동시 호출이 그 장비의 칸 수보다 크다 — 넘는 호출은 늘 칸을 기다리다 미뤄진다 */
function concurrencyRule({ task, row }: RuleInput): RuleResult {
  if (row.concurrency.kind !== "field" || !row.slots) return { todos: [], status: null };
  const current = Number(row.concurrency.field.initial);
  if (!Number.isFinite(current) || current <= row.slots.slots) return { todos: [], status: null };
  return { status: { level: "warn", text: "동시가 장비보다 큼", note: null }, todos: [{ id: `${task.id}:concurrency`, level: "warn", tag: "고칠 것", rowId: task.id, task: task.label,
    title: `동시 호출 ${current}이(가) 장비 칸 수(${row.slots.deviceId} ${row.slots.slots}칸)보다 큽니다`,
    evidence: `${row.slots.slots + 1}번째 호출부터는 늘 장비 칸을 기다리다 미뤄집니다. ${row.slots.slots}로 맞추기를 권합니다.`,
    fills: [{ path: row.concurrency.field.path, value: String(row.slots.slots) }] }] };
}

/** (c) 호출 상한이 실측 최대보다 훨씬 길다(낮은 우선) — 멈춘 호출 하나가 칸을 오래 붙잡는다 */
function looseCapRule({ task, row, settings }: RuleInput): RuleResult {
  const m = row.measure, cap = row.capMs;
  if (!m || cap === null || row.cap.kind !== "field" || m.calls < LOOSE_CAP_MIN_CALLS || m.maxMs === null || m.maxMs <= 0) return { todos: [], status: null };
  if (!(cap > LOOSE_CAP_FACTOR * m.maxMs && cap - m.maxMs >= LOOSE_CAP_MARGIN_MS)) return { todos: [], status: null };
  const rec = roundUp(Math.max(LOOSE_CAP_FACTOR * m.maxMs, 60_000), 30_000);
  if (rec >= cap) return { todos: [], status: null };
  const auto = row.tick.kind === "field" && row.tick.field.auto
    ? ` 틱 시간은 자동이라 함께 ${secondsText(rec + row.tick.field.autoExtraMs + settings.translation.product.jobMarginMs)}로 줄어듭니다.` : "";
  return { status: { level: "info", text: "상한이 느슨함", note: null }, todos: [{ id: `${task.id}:loose-cap`, level: "info", tag: "참고", rowId: task.id, task: task.label,
    title: `호출 상한 ${secondsText(cap)}가 실측보다 훨씬 깁니다`,
    evidence: `24시간 ${fmt(m.calls)}건 중 가장 긴 호출이 ${secondsText(m.maxMs)}였습니다. 멈춘 호출 하나가 ${secondsText(cap)}를 붙잡지 않도록 ${secondsText(rec)}를 권합니다.${auto}`,
    fills: [{ path: row.cap.field.path, value: msInput(rec) }] }] };
}

/** (d) 호출이 상한에서 끊긴다(1% 넘게) — 지금 값을 낮추면 더 끊긴다 */
function capHitRule({ task, row }: RuleInput): RuleResult {
  const m = row.measure, cap = row.capMs;
  if (!m || cap === null) return { todos: [], status: null };
  const hits = m.cutAtCap + m.unknownAtCap, total = m.calls + m.unknown;
  if (hits < CAP_HIT_MIN || !total || hits / total <= CAP_HIT_RATE) return { todos: [], status: null };
  const pct = Math.round(hits / total * 1000) / 10;
  return { status: { level: "info", text: "상한에 닿음", note: null }, todos: [{ id: `${task.id}:cap-hit`, level: "info", tag: "확인할 것", rowId: task.id, task: task.label,
    title: `호출의 ${pct}%가 상한 ${secondsText(cap)}에서 끊깁니다`,
    evidence: `24시간 ${fmt(total)}건 중 ${fmt(hits)}건입니다. 지금 값은 유지해도 되지만 더 낮추면 끊기는 호출이 늘어납니다.`, fills: [] }] };
}

/**
 * (e) 잡이 멈추지 않았는데 24시간 호출이 0건이고 예약은 있었다(보내기 전에 모두 취소) — 할 일이 없어 조용한 잡(예약도 없음)은 올리지 않는다.
 * 잡이 멈췄는지 모르면(잡 상태를 못 읽음) 올리지 않는다.
 */
function zeroCallsRule({ task, row }: RuleInput): RuleResult {
  const m = row.measure;
  if (!m || !task.jobs.length || row.paused !== false || m.calls > 0 || m.unknown > 0 || m.cancelled === 0) return { todos: [], status: null };
  return { status: { level: "info", text: "호출 없음 · 조사 필요", note: null }, todos: [{ id: `${task.id}:zero`, level: "info", tag: "확인할 것", rowId: task.id, task: task.label,
    title: "24시간 동안 호출이 0건입니다",
    evidence: `잡은 멈춰 있지 않고 예약 ${fmt(m.cancelled)}건이 모두 보내기 전에 취소됐습니다. 한도 문제가 아니라 잡 쪽 원인으로 보여 따로 조사가 필요합니다.`, fills: [] }] };
}

export const LIMITS_RULES = Object.freeze([tickCutRule, concurrencyRule, capHitRule, zeroCallsRule, looseCapRule]);
const LEVEL_ORDER: Readonly<Record<LimitsLevel, number>> = { bad: 0, warn: 1, info: 2, off: 3, ok: 4 };
const TAG_ORDER = (todo: LimitsTodo) => LEVEL_ORDER[todo.level] * 2 + (todo.tag === "참고" ? 1 : 0);

// ---------- 모형 ----------

export type LimitsViewInput = {
  row: RuntimeSettingsRow | null; rowError?: string | null; models?: readonly ModelDefinition[];
  apply?: SettingsApply | null; observations?: readonly AdminObservation[]; audit?: readonly AuditView[];
  measurement?: LimitsMeasurement | null; measureError?: string | null;
  /** 잡마다 사람이 멈췄는가(readJobPauses). 못 읽으면 null */
  pauses?: readonly { name: string; paused: boolean }[] | null;
  readOnly?: boolean; now?: Date;
};

export function buildLimitsView(input: LimitsViewInput): LimitsView {
  const models = input.models ?? DEFAULT_MODEL_DEFINITIONS, now = input.now ?? new Date();
  const stored = isPlainObject(input.row?.values) ? input.row!.values as Record<string, unknown> : {};
  const { settings, issues } = resolveRuntimeSettings(input.row?.values ?? null, { models });
  const ctx: BuildContext = { stored, settings, models };
  const measurement = input.measurement ?? null;
  const roles = latestRoleObservations(input.observations ?? []);
  const holdSeconds = settings.capacity.unknownHoldSeconds;
  const version = input.row ? storedSettingsVersion(input.row.values) : "default";
  const rowBudgetJobs = new Set<string>();

  const rows = LIMITS_TASKS.map((task): LimitsRow => {
    const tick: LimitsTick = task.tick.kind === "budget" ? { kind: "field", field: budgetField(ctx, task.tick.job, task.label) } : { kind: "text", text: task.tick.text };
    if (task.tick.kind === "budget") rowBudgetJobs.add(task.tick.job);
    const details = detailFields(task, ctx);
    const minCall = task.details.find(spec => spec.kind === "knob" && spec.knob === "minCallMs");
    const pauseStates = input.pauses ? task.jobs.map(job => input.pauses!.find(entry => entry.name === job)?.paused) : [];
    const paused = !task.jobs.length || !input.pauses || pauseStates.some(state => state === undefined) ? null : pauseStates.every(Boolean);
    const base: Omit<LimitsRow, "status"> = { id: task.id, anchor: `row-${task.id}`, group: task.group, label: task.label, sub: task.sub, note: task.note ?? null,
      models: modelsText(task, measurement), capMs: capMsOf(task.cap, ctx), cap: capView(task, ctx), tick, concurrency: concurrencyView(task, ctx), details,
      minCallPath: minCall?.kind === "knob" && details.some(field => field.path === `jobs.${minCall.job}.minCallMs`) ? `jobs.${minCall.job}.minCallMs` : null,
      measure: measurement ? measurement.tasks[task.id] ?? emptyMeasure() : null, paused, slots: deviceSlots(task, measurement) };
    return { ...base, status: { level: "ok", text: "정상", note: null } };
  });

  const todos: LimitsTodo[] = [];
  for (const row of rows) {
    const task = LIMITS_TASKS.find(entry => entry.id === row.id)!;
    if (!row.measure) { row.status = { level: "off", text: "측정 없음", note: null }; continue; }
    // 실측 규칙은 멈춤과 상관없이 24시간 근거로 본다(배포 창처럼 잠깐 멈춘 잡의 문제를 숨기지 않는다). 「호출 0건」만 멈추지 않은 잡에 올린다
    const results = LIMITS_RULES.map(rule => rule({ task, row, settings, holdSeconds, savedAt: input.row?.updatedAt ?? null, now }));
    for (const result of results) todos.push(...result.todos);
    const statuses = results.flatMap(result => result.status ? [result.status] : []).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    if (statuses.length) row.status = statuses[0];
    else if (row.paused) row.status = { level: "off", text: "쉬는 중", note: "잡을 사람이 멈춰 두었습니다. 다시 돌 때 쓸 값을 그대로 고칠 수 있습니다" };
    else if (row.measure.calls + row.measure.unknown === 0) row.status = { level: "off", text: "호출 없음",
      note: row.measure.cancelled ? null : "24시간 예약도 없었습니다 — 할 일이 없거나 연결이 끊긴 상태입니다" };
    else if (row.measure.calls + row.measure.unknown < FEW_CALLS) row.status = { level: "off", text: "자료 부족", note: null };
  }
  todos.sort((a, b) => TAG_ORDER(a) - TAG_ORDER(b));

  const groups = (Object.keys(LIMITS_GROUP_LABELS) as LimitsGroupId[]).map(id => ({ id, label: LIMITS_GROUP_LABELS[id], rows: rows.filter(row => row.group === id) }));

  // AI 밖(그리고 작업 줄에 없는) 잡의 틱 시간 — 고급 설정으로 접어 둔다
  const storedBudgets = isPlainObject(stored.budgets) ? Object.keys(stored.budgets) : [];
  const roleOrder = [...RUNTIME_SETTINGS_ROLES] as string[];
  const advancedRows = [...new Set([...Object.keys(DEFAULT_RUNTIME_SETTINGS.budgets), ...storedBudgets])]
    .filter(job => !rowBudgetJobs.has(job) && !HIDDEN_BUDGET_JOBS.includes(job))
    .map((job): LimitsAdvancedRow => {
      const role = JOB_CATALOG.find(entry => entry.name === job)?.role ?? "unknown";
      const observed = roles[role] ?? null;
      const lane = observed?.lanes?.find(entry => entry.jobs.includes(job)) ?? null;
      return { job, label: JOB_LABELS[job] ?? job, role, roleLabel: ROLE_LABELS[role] ?? role, field: budgetField(ctx, job, JOB_LABELS[job] ?? job),
        lane: lane ? { state: lane.state, currentJob: lane.currentJob, ageMs: lane.state === "running" && lane.startedAt !== null ? Math.max(0, now.getTime() - lane.startedAt) : null,
          budgetMs: lane.budgetMs ?? null } : null, supervisorFloorMs: observed?.jobMs ?? null };
    })
    .sort((a, b) => ((roleOrder.indexOf(a.role) + 1 || 99) - (roleOrder.indexOf(b.role) + 1 || 99)) || a.label.localeCompare(b.label, "ko"));
  const advanced = [...new Map(advancedRows.map(row => [row.role, { role: row.role, roleLabel: row.roleLabel, rows: advancedRows.filter(entry => entry.role === row.role) }])).values()];

  const ladder = settings.routes.deadlines[REVIEW_LADDER_ROUTE] ?? DEFAULT_MODEL_DEADLINES[REVIEW_LADDER_ROUTE];
  const roleDiags = RUNTIME_SETTINGS_ROLES.map((role): LimitsRoleDiag => {
    const applied = input.apply?.roles.find(entry => entry.role === role);
    const observed = roles[role] ?? null;
    return { role, label: ROLE_LABELS[role] ?? role, state: applied?.state ?? "unread", version: applied?.reportedVersion ?? null, observedAt: applied?.observedAt ?? null,
      registryEnv: observed?.registryEnv === true || applied?.registryEnv === true,
      running: (observed?.lanes ?? []).flatMap(lane => lane.state === "running" && lane.currentJob ? [JOB_LABELS[lane.currentJob] ?? lane.currentJob] : []) };
  });

  return {
    revision: input.row?.revision ?? null, version, shortVersion: shortRuntimeSettingsVersion(version), updatedBy: input.row?.updatedBy ?? null,
    updatedAt: input.row?.updatedAt ?? null, rowError: input.row ? null : input.rowError ?? "runtime_settings_row_missing",
    readOnly: input.readOnly === true || !input.row, issues: issues.map(runtimeSettingsIssueMessage),
    margin: limitsField(ctx, "translation.product.jobMarginMs", { label: "자동 틱 여유", unit: "초", kind: "ms", min: 5, max: 120 }),
    groups, todos, advanced,
    ladder: { gatewayMs: msToInput(ladder.gatewayMs), engineMs: msToInput(ladder.engineMs), relayMs: ladder.relayMs === null ? "" : msToInput(ladder.relayMs) },
    measuredAt: measurement?.measuredAt ?? null, measureError: measurement ? null : input.measureError ?? "measurement_unavailable",
    unknownHoldSeconds: holdSeconds, apply: input.apply ?? null, roles: roleDiags, audit: [...(input.audit ?? [])],
  };
}

function emptyMeasure(): LimitsTaskMeasure {
  return { calls: 0, p50Ms: null, p99Ms: null, maxMs: null, cutAtCap: 0, unknown: 0, tickCut: 0, tickCutMinMs: null, tickCutMaxMs: null, unknownAtCap: 0, cancelled: 0 };
}

/** 저장 여유(BUDGET_CALL_MARGIN_MS) — 화면이 「틱 시간 ≥ 상한 + 2초」를 알린다 */
export const LIMITS_BUDGET_CALL_MARGIN_MS = BUDGET_CALL_MARGIN_MS;
