import { z } from "zod";

/**
 * 비상 운영 우선순위(PR16) — M3·mini가 모두 멈췄을 때 Oracle 1CPU 위에서 무엇을 먼저 들일지 정하는 순수 판정.
 * DB·프로세스·잡 pause·역할 lease 를 바꾸지 않고, 아직 어떤 실행기도 이 판정을 부르지 않는다(기본 비활성).
 * 순서: DB/제어 → 번역·연결 확인·발행후 반영 → 이미 승인된 발행 → 준비된 후보 심사 → 근거 → 신규 발굴
 * (로드맵 PR16 행, 설계 6.2 "독립 모델과 비상 작업 우선순위"). 사람 보류·keyword api-stop·X 읽기·API reserve·
 * Cloudflare 한도 같은 잡 안의 제어는 여기서 건드리지 않는다 — 들인 잡도 자기 제어를 그대로 지킨다.
 */
export type HostLiveness = "alive" | "down";
export type WriterState = "active" | "fenced" | "unreachable";
export type EmergencyMode = "normal" | "partial" | "full" | "recovering" | "hold";

const modeInputSchema = z.strictObject({ m3: z.enum(["alive", "down"]), mini: z.enum(["alive", "down"]),
  writer: z.enum(["active", "fenced", "unreachable"]), oracleTakeoverRoles: z.number().int().min(0).max(64) });

/**
 * down 은 그 host 의 역할 후보 heartbeat 가 lease 창을 넘겨 끊긴 것(DB 관측)이지 죽음의 증명이 아니다 — 앱 일의 소유권은
 * lease token 이 지킨다. writer 를 확실히 모르면(fenced·연결 불가) host 상태와 상관없이 hold: DB 쓰기·발행·자동 내림을 열지 않는다.
 * oracleTakeoverRoles 는 Oracle 이 평소 M3·mini 몫인데 지금 쥔 역할 수다. 돌아온 host 는 이를 선점하지 않으므로(계획 drain 뒤
 * 새 epoch) 그동안은 recovering 으로 비상 예산을 유지한다.
 */
export function classifyEmergencyMode(value: { m3: HostLiveness; mini: HostLiveness; writer: WriterState; oracleTakeoverRoles: number }):
  { mode: EmergencyMode; reason: string } {
  const parsed = modeInputSchema.safeParse(value);
  if (!parsed.success) throw new Error("emergency_mode_input_invalid");
  const input = parsed.data;
  if (input.writer !== "active") return { mode: "hold", reason: `writer_${input.writer}` };
  if (input.m3 === "down" && input.mini === "down") return { mode: "full", reason: "m3_and_mini_down" };
  if (input.oracleTakeoverRoles > 0) return { mode: "recovering", reason: "oracle_holds_takeover_roles" };
  if (input.m3 === "down" || input.mini === "down") return { mode: "partial", reason: input.m3 === "down" ? "m3_down" : "mini_down" };
  return { mode: "normal", reason: "all_alive" };
}

export const EMERGENCY_TIERS = ["control", "translation-uptime", "approved-publish", "prepared-review", "evidence", "discovery"] as const;
export type EmergencyTier = typeof EMERGENCY_TIERS[number];
/** model: 그 잡 용도로 검증된 독립 모델 경로가 있어야 한다. http: 공유 HTTP 몫을 쓴다. embedding: 같은 벡터 공간이 확인돼야 한다 */
type JobNeed = Readonly<{ tier: EmergencyTier; model?: true; http?: true; embedding?: true }>;

/**
 * 카탈로그 모든 잡의 비상 자리(테스트가 빠짐없음을 확인한다). suspended 는 비상 중 들이지 않을 뿐 pause·대기열·커서는
 * 그대로라 복귀 뒤 정상 일정으로 이어진다. 감사·검수 보강·집계·이미지·GitHub 보강, 자동 내림 재검사가 여기다.
 */
export const EMERGENCY_JOB_POLICY: Readonly<Record<string, JobNeed | "suspended">> = {
  heartbeat: { tier: "control" },
  "reason-translate": { tier: "translation-uptime", model: true },
  "product-tagline-ko": { tier: "translation-uptime", model: true },
  "product-translate": { tier: "translation-uptime", model: true },
  "uptime-ping": { tier: "translation-uptime", http: true },
  "cdn-purge": { tier: "translation-uptime", http: true },
  "product-search-refresh": { tier: "translation-uptime" },
  "product-embedding": { tier: "translation-uptime", embedding: true },
  "crawl-publish": { tier: "approved-publish", model: true },
  "crawl-judge": { tier: "prepared-review" },
  "crawl-agent-review": { tier: "prepared-review", model: true },
  "second-review": { tier: "prepared-review", model: true },
  "human-deepseek-review": { tier: "prepared-review", model: true },
  "crawl-tagline": { tier: "prepared-review", model: true },
  "product-site-evidence-refresh": { tier: "evidence", http: true },
  "product-evidence-refresh": { tier: "evidence", http: true },
  "news-refresh": { tier: "evidence", http: true },
  "crawl-seed": { tier: "discovery", http: true },
  "hn-show-seed": { tier: "discovery", http: true },
  "crawl-fetch": { tier: "discovery", http: true },
  "product-audit": "suspended", "product-intro-check": "suspended", "grok-session-check": "suspended",
  "product-search-profile": "suspended", "product-search-verify": "suspended", "product-repo-review": "suspended",
  "product-spam-rescan": "suspended", "github-feedback-delivery": "suspended", "github-integration-reconcile": "suspended",
  "product-search-health": "suspended", "click-rollup": "suspended", "ranking-refresh": "suspended",
  "product-thumbnail-refresh": "suspended", "agent-evidence-refresh": "suspended", "ai-level-refresh": "suspended",
  "product-stars-refresh": "suspended", "product-star-observation": "suspended", "product-readme-refresh": "suspended",
  "hn-talk": "suspended",
};

/** 실측 뒤 명시하는 값만 받는다(기본값 없음, host-budget 와 같은 원칙). 제어 단계는 이 예산 밖이다 — heartbeat 여유 */
export const budgetSchema = z.strictObject({ jobs: z.number().int().min(0).max(64), modelJobs: z.number().int().min(0).max(64),
  httpJobs: z.number().int().min(0).max(64), agingMs: z.number().int().min(1).max(86_400_000) });
const dueSchema = z.array(z.strictObject({ job: z.string().min(1).max(120), overdueMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }))
  .max(256).refine((rows) => new Set(rows.map((row) => row.job)).size === rows.length);

export type EmergencyPlanInput = Readonly<{
  mode: EmergencyMode;
  /** 지금 due 인 잡과 due 가 된 뒤 지난 시간 */
  due: readonly { job: string; overdueMs: number }[];
  /** DB 의 pause·api-stop 등 이미 멈춘 잡 — 비상 모드가 풀지 않는다(신규 발굴 중단 포함) */
  paused: ReadonlySet<string>;
  /** 이 잡 용도의 독립 모델 경로가 품질·비용 검증을 마친 잡 */
  verifiedModelJobs: ReadonlySet<string>;
  embedding: "legacy" | "semantic" | "degraded";
  /** host-budget.ts hostPressureDecision 결과(null 이면 여유) */
  hostPressure: string | null;
  budget: Readonly<z.infer<typeof budgetSchema>>;
}>;
export type EmergencyDeferReason = "paused_preserved" | "unknown_job" | "suspended" | "hold_control_only" | "host_pressure"
  | "model_unverified" | "embedding_not_semantic" | "budget_jobs" | "budget_model" | "budget_http";
export type EmergencyDecision = Readonly<{ job: string; tier: EmergencyTier | null; admitted: boolean; reason: "admitted" | EmergencyDeferReason }>;
export type EmergencyPlan = { active: false } | { active: true; decisions: EmergencyDecision[] };

/**
 * 비상 admission. 정상·부분 장애에서는 끼어들지 않는다(active false — 기존 일정 그대로).
 * 줄 세우기: 단계 순위에서 agingMs 마다 한 단계씩 당긴다(제어 아래로는 못 간다). 같은 순위는 오래 기다린 잡이 먼저다 —
 * 그래서 번역이 매분 due 여도 아래 단계 모델 잡이 (단계 차이 × agingMs) 뒤에는 차례를 얻는다. 그다음 단계·이름 순.
 */
export function planEmergencyAdmission(input: EmergencyPlanInput): EmergencyPlan {
  if (input.mode === "normal" || input.mode === "partial") return { active: false };
  const budget = budgetSchema.safeParse(input.budget);
  if (!budget.success) throw new Error("emergency_budget_invalid");
  const due = dueSchema.safeParse(input.due);
  if (!due.success) throw new Error("emergency_due_invalid");
  const { jobs, modelJobs, httpJobs, agingMs } = budget.data;
  const rows = due.data.map((row) => {
    const policy = Object.hasOwn(EMERGENCY_JOB_POLICY, row.job) ? EMERGENCY_JOB_POLICY[row.job] : undefined;
    const need = policy && policy !== "suspended" ? policy : null;
    const index = need ? EMERGENCY_TIERS.indexOf(need.tier) : EMERGENCY_TIERS.length;
    const rank = index === 0 ? 0 : Math.max(1, index - Math.floor(row.overdueMs / agingMs));
    return { ...row, policy, need, index, rank };
  }).sort((a, b) => a.rank - b.rank || b.overdueMs - a.overdueMs || a.index - b.index || (a.job < b.job ? -1 : a.job > b.job ? 1 : 0));
  const used = { jobs: 0, model: 0, http: 0 };
  const decisions = rows.map(({ job, policy, need }): EmergencyDecision => {
    const decide = (reason: EmergencyDecision["reason"]) => ({ job, tier: need?.tier ?? null, admitted: reason === "admitted", reason });
    if (input.paused.has(job)) return decide("paused_preserved");
    if (policy === undefined) return decide("unknown_job");
    if (!need) return decide("suspended");
    if (need.tier === "control") return decide("admitted");
    if (input.mode === "hold") return decide("hold_control_only");
    if (input.hostPressure !== null) return decide("host_pressure");
    if (need.model && !input.verifiedModelJobs.has(job)) return decide("model_unverified");
    if (need.embedding && input.embedding !== "semantic") return decide("embedding_not_semantic");
    if (used.jobs >= jobs) return decide("budget_jobs");
    if (need.model && used.model >= modelJobs) return decide("budget_model");
    if (need.http && used.http >= httpJobs) return decide("budget_http");
    used.jobs++;
    if (need.model) used.model++;
    if (need.http) used.http++;
    return decide("admitted");
  });
  return { active: true, decisions };
}
