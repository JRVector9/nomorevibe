import { z } from "zod";
import { ai1GatewayServingContractSchema, resolveAi1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { ai2GatewayServingContractSchema, resolveAi2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { batchPolicyHash, batchPolicySchema } from "@/lib/jobs/batches";
import { modelCapacityPolicyHash, modelCapacityPolicySchema, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { cliServingContractSchema, resolveCliServingContract, type CliProvider } from "@/lib/llm/cli-serving-contract";
import { crawlTaglineServingContractSchema, resolveCrawlTaglineServingContract } from "@/lib/llm/crawl-tagline-serving-contract";
import { productTaglineKoServingContractSchema, resolveProductTaglineKoServingContract } from "@/lib/llm/product-tagline-ko-serving-contract";
import { productTranslationServingContractSchema, resolveProductTranslationServingContract } from "@/lib/llm/product-translation-serving-contract";
import { reasonTranslationServingContractSchema, resolveReasonTranslationServingContract } from "@/lib/llm/reason-translation-serving-contract";
import { resolveSearchVerifyServingContract, searchVerifyServingContractSchema } from "@/lib/llm/search-verify-serving-contract";
import { resolveTextProfileServingContract, textProfileServingContractSchema } from "@/lib/llm/text-profile-serving-contract";
import { resolveWebsearchQueryServingContract, websearchQueryServingContractSchema } from "@/lib/llm/websearch-query-serving-contract";
import { httpOriginPolicyHash, httpOriginPolicySchema } from "@/lib/net/http-origin-policy";

/**
 * 운영자 제어 CLI(PR06d)의 순수 부분 — 인자, 판정(dry-run 계획), 출력. DB·파일·네트워크 없음.
 * 계획은 안내다. 실행 때 잠근 행으로 같은 계획을 다시 세우고, 최종 거절 권한은 각 repository 전환 함수의 가드에 있다.
 */

export const CONTROL_STAGES = ["ai1", "ai2"] as const;
export type ControlStage = typeof CONTROL_STAGES[number];
const MODES = {
  stage: ["legacy", "draining", "items"], capacity: ["disabled", "draining", "open"],
  http: ["disabled", "draining", "open"], batch: ["legacy", "draining", "versioned"],
  // 제작 근거 스캔(agent_scan_control, 0104) — stage 와 같은 뜻의 legacy·draining·items
  "agent-scan": ["legacy", "draining", "items"],
} as const;
type Area = keyof typeof MODES;

/** 명령별 필수 옵션. 모든 전환 명령은 여기에 --operator·--reason이 더 붙는다. */
const SPECS = {
  "stage drain": ["stage", "from-mode", "expect-epoch"],
  "stage complete": ["stage", "draining-from", "to", "expect-epoch"],
  "stage contract": ["stage", "expect-contract", "expect-epoch"],
  "capacity policy": ["file", "from-mode", "expect-epoch", "expect-revision"],
  "capacity mode": ["to", "from-mode", "expect-epoch", "expect-revision"],
  "http policy": ["file", "from-mode", "expect-epoch", "expect-revision"],
  "http mode": ["to", "from-mode", "expect-epoch", "expect-revision"],
  "batch policy": ["file", "expect-epoch", "expect-policy-hash"],
  "batch contract": ["expect-contract", "expect-epoch"],
  "batch drain": ["from-mode", "expect-epoch"],
  "batch complete": ["draining-from", "to", "expect-epoch"],
  "agent-scan contract": ["expect-contract", "expect-epoch"],
  "agent-scan drain": ["from-mode", "expect-epoch"],
  "agent-scan complete": ["draining-from", "to", "expect-epoch"],
} as const;
export type TransitionName = keyof typeof SPECS;
const FLAGS = new Set(["execute", "json", "allow-deferred-routes", "allow-stalled-stage"]);
const OPERATOR = /^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,119}$/;

export type ControlOptions = { stage: ControlStage; to: string; fromMode: string; drainingFrom: string; file: string;
  expectEpoch: number; expectRevision: number; expectContract: number; expectPolicyHash: string | null; operator: string; reason: string };
export type ControlCommand =
  /** area 가 있으면 그 칸만 보인다(`agent-scan status`) */
  | { name: "status"; json: boolean; area?: "agent-scan" }
  | { name: TransitionName; area: Area; execute: boolean; json: boolean; allowDeferredRoutes: boolean; allowStalledStage: boolean;
    options: Partial<ControlOptions> };
export type TransitionCommand = Extract<ControlCommand, { area: Area }>;

function fail(code: string): never { throw new Error(code); }
const integer = (value: string, min: number, code: string) => {
  const parsed = /^(0|[1-9]\d*)$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : fail(code);
};

/** --key=value와 값 없는 flag만 받는다. 모르는·중복 옵션과 URL 인자는 거절한다(DB URL은 환경변수로만). */
export function parsePipelineControlArgs(args: readonly string[]): ControlCommand {
  if (args.some(arg => arg.includes("://"))) fail("pipeline_control_url_argument_rejected");
  const areaStatus = args[0] === "agent-scan" && args[1] === "status";
  const status = args[0] === "status" || areaStatus;
  const name = status ? "status" : `${args[0]} ${args[1]}`;
  if (!status && !Object.hasOwn(SPECS, name)) fail("pipeline_control_unknown_command");
  const required: readonly string[] = status ? [] : [...SPECS[name as TransitionName], "operator", "reason"];
  const allowed = new Set([...required, "json", ...(status ? [] : ["execute"]), ...(name === "capacity mode" ? ["allow-deferred-routes"] : []),
    ...(name === "stage complete" ? ["allow-stalled-stage"] : [])]);
  const values = new Map<string, string>(), flags = new Set<string>();
  for (const arg of args.slice(args[0] === "status" ? 1 : 2)) {
    const match = /^--([a-z-]+)(?:=([^\n]*))?$/.exec(arg);
    if (!match || !allowed.has(match[1])) fail("pipeline_control_unknown_option");
    const [, key, value] = match;
    if (FLAGS.has(key) ? value !== undefined : !value) fail("pipeline_control_invalid_option");
    if (values.has(key) || flags.has(key)) fail("pipeline_control_duplicate_option");
    if (FLAGS.has(key)) flags.add(key); else values.set(key, value);
  }
  if (status) return { name: "status", json: flags.has("json"), ...(areaStatus ? { area: "agent-scan" as const } : {}) };
  for (const key of required) if (!values.has(key)) fail(`pipeline_control_missing_${key.replace(/-/g, "_")}`);
  const area = args[0] as Area, options: Partial<ControlOptions> = {};
  const mode = (key: string) => {
    const value = values.get(key)!;
    return (MODES[area] as readonly string[]).includes(value) ? value : fail(`pipeline_control_invalid_${key.replace(/-/g, "_")}`);
  };
  for (const key of values.keys()) {
    const value = values.get(key)!;
    switch (key) {
      case "stage": options.stage = (CONTROL_STAGES as readonly string[]).includes(value) ? value as ControlStage : fail("pipeline_control_invalid_stage"); break;
      case "to": options.to = mode(key); break;
      case "from-mode": options.fromMode = mode(key); break;
      case "draining-from": options.drainingFrom = mode(key); break;
      case "file": options.file = value; break;
      case "expect-epoch": options.expectEpoch = integer(value, 1, "pipeline_control_invalid_expect_epoch"); break;
      case "expect-revision": options.expectRevision = integer(value, 1, "pipeline_control_invalid_expect_revision"); break;
      case "expect-contract": options.expectContract = integer(value, 0, "pipeline_control_invalid_expect_contract"); break;
      case "expect-policy-hash": options.expectPolicyHash = value === "none" ? null
        : /^[a-f0-9]{64}$/.test(value) ? value : fail("pipeline_control_invalid_expect_policy_hash"); break;
      case "operator": options.operator = OPERATOR.test(value) ? value : fail("pipeline_control_invalid_operator"); break;
      case "reason": options.reason = value.length <= 300 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
        ? value : fail("pipeline_control_invalid_reason"); break;
    }
  }
  return { name: name as TransitionName, area, execute: flags.has("execute"), json: flags.has("json"),
    allowDeferredRoutes: flags.has("allow-deferred-routes"), allowStalledStage: flags.has("allow-stalled-stage"), options };
}

const OVERRIDES = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"] as const;
/** 앱 기본 DATABASE_URL로 대체하지 않는다. libpq 우회 변수가 하나라도 있으면 드라이버를 열기 전에 거절한다. */
export function pipelineControlDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.PIPELINE_CONTROL_DATABASE_URL;
  if (!url) return fail("explicit_PIPELINE_CONTROL_DATABASE_URL_required");
  if (OVERRIDES.some(key => Boolean(env[key]))) fail("database_override_rejected");
  return url;
}

/** 고정 code만 출력한다. URL·SQL·stack은 쓰지 않는다. */
export function formatPipelineControlError(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_:.-]{2,120}$/.test(error.message) ? error.message : "pipeline_control_failed";
}

const count = z.number().int().nonnegative().safe();
const epoch = z.number().int().positive().safe();
const controlRow = (area: "capacity" | "http") => ({ mode: z.enum(MODES[area]), epoch, revision: epoch, policy: z.unknown(),
  policyHash: z.string().nullable(), reserved: count, dispatched: count, indeterminate: count });
/** repository가 한 문장·한 DB 시계로 읽는 readback. live는 각 전환 가드와 같은 조건으로 센다. */
export const controlSnapshotSchema = z.object({
  now: z.string(), fence: z.object({ state: z.enum(["active", "fenced"]), writerEpoch: epoch }).strict(),
  stages: z.array(z.object({ stage: z.enum(CONTROL_STAGES), mode: z.enum(MODES.stage), drainingFrom: z.enum(["legacy", "items"]).nullable(),
    epoch, contract: count, live: count, unsettled: count, legacyJobLive: z.boolean(), consumers: count }).strict()),
  capacity: z.object({ ...controlRow("capacity"), waiting: count, oldGeneration: count }).strict(),
  http: z.object(controlRow("http")).strict(),
  batch: z.object({ mode: z.enum(MODES.batch), drainingFrom: z.enum(["legacy", "versioned"]).nullable(), epoch, contract: count,
    policy: z.unknown(), policyHash: z.string().nullable(), liveJobs: count, liveRoles: count, liveItems: count, liveSources: count,
    liveAgentClaims: count }).strict(),
  /**
   * 제작 근거 스캔 control 과 claim 표. live·unsettled 는 전환 가드와 같은 조건(lease_until 대 DB 시계, 시간대 없는 UTC)이다.
   * legacyJobLive 는 legacy 스캔을 할 수 있는 agent-evidence-refresh 틱(legacy 의 틱, draining(from legacy) 에서는 drain 전에 시작한 틱)이 살아 있는가.
   * queue 는 priority 별 지금 잡을 수 있는 행(도래했고 저장소 backoff 가 지났고 살아 있는 claim 이 아님) 수와 그중 가장 오래 기다린 분.
   */
  agentScan: z.object({ mode: z.enum(MODES["agent-scan"]), drainingFrom: z.enum(["legacy", "items"]).nullable(), epoch, contract: count,
    live: count, unsettled: count, legacyJobLive: z.boolean(), consumers: count,
    queue: z.array(z.object({ priority: z.number().int().min(0).max(9), waiting: count, oldestMinutes: z.number().nonnegative().nullable() }).strict()),
  }).strict(),
  recentInstances: z.array(z.string()),
  /**
   * 응답 점검 분담(0103 uptime_split_control) mode. claims 동안 batch 를 versioned 쪽으로 옮기면 uptime-ping 이 product-health 역할 몫이 되어
   * (Oracle principal 에는 split 권한이 없고, M3 는 policy 의 home 이 아닐 수 있다) 확인·적용이 멈춘다 — batch 전환이 이 값을 보고 거절한다
   */
  uptimeSplitMode: z.enum(["legacy", "claims"]),
  /** crawl_settings.values 원문(행이 없으면 null). 워커와 같은 mergeWithDefaults로 읽는다 */
  reviewSettings: z.unknown(),
  auditCampaign: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
}).strict();
export type ControlSnapshot = z.infer<typeof controlSnapshotSchema>;
type StageRow = ControlSnapshot["stages"][number];

export type RouteStatus = "serving" | "no_contract" | "unmapped" | "admission_only" | "stage_legacy" | "unknown" | "unused";
export type RouteUse = { routeId: string; provider: string; model: string | null };
export type RouteContract = RouteUse & { status: RouteStatus };
type RouteSpec = { routeId: string; provider: string; served: ((model: string) => boolean) | null };
const gateway = (routeId: string, resolve: (model: string) => unknown, schema: z.ZodType<{ model: string }>): RouteSpec => ({
  routeId, provider: "abcllm", served: model => schema.safeParse(structuredClone(resolve(model))).data?.model === model });
const cli = (routeId: string, provider: CliProvider): RouteSpec => ({ routeId, provider, served: model => {
  const contract = cliServingContractSchema.safeParse(structuredClone(resolveCliServingContract(routeId, provider, model))).data;
  return contract?.routeId === routeId && contract.provider === provider && contract.model === model;
} });
/** 공통 모델 슬롯을 거치는 실제 호출 지점. served가 null이면 open에서 항상 미루는 admission 전용 경로다. */
const MODEL_ROUTES: readonly RouteSpec[] = [
  gateway("crawl-agent-review", resolveAi1GatewayServingContract, ai1GatewayServingContractSchema),
  gateway("second-review", resolveAi2GatewayServingContract, ai2GatewayServingContractSchema),
  gateway("product-search-profile", resolveTextProfileServingContract, textProfileServingContractSchema),
  gateway("product-search-verify", resolveSearchVerifyServingContract, searchVerifyServingContractSchema),
  gateway("reason-translate", resolveReasonTranslationServingContract, reasonTranslationServingContractSchema),
  gateway("product-translate", resolveProductTranslationServingContract, productTranslationServingContractSchema),
  gateway("product-tagline-ko", resolveProductTaglineKoServingContract, productTaglineKoServingContractSchema),
  gateway("crawl-tagline", resolveCrawlTaglineServingContract, crawlTaglineServingContractSchema),
  gateway("search-query-translate", resolveWebsearchQueryServingContract, websearchQueryServingContractSchema),
  cli("crawl-agent-review", "claude-cli"), cli("crawl-agent-review", "grok-cli"),
  cli("second-review", "claude-cli"), cli("second-review", "grok-cli"),
  cli("product-intro-check", "claude-cli"), cli("product-audit", "claude-cli"), cli("grok-session-check", "grok-cli"),
  { routeId: "product-audit", provider: "abcllm", served: null },
];

/** 호출 지점 상수가 이 프로세스 env에서 받는 model 값(각 상수와 같은 `값 || 기본값`). crawlReview는 1차 심사 설정이 없을 때의 CRAWL_REVIEW_MODEL이다. */
export type ModelEnv = { crawlReview: string | null; translate: string; tagline: string; profile: string; verify: string; introCheck: string };
const TEXT_ROUTES = [["product-search-profile", "profile"], ["product-search-verify", "verify"], ["reason-translate", "translate"],
  ["product-translate", "translate"], ["product-tagline-ko", "translate"], ["search-query-translate", "translate"], ["crawl-tagline", "tagline"]] as const;

/**
 * 지금 각 호출 지점이 resolver에 넘기는 (route, provider, model). 고르는 식은 firstReviewer·2차 voters+fallbacks·checkGrokSession·
 * text 상수·소개 검수·실행 중 감사(abcllm이 아니면 Claude CLI)와 같다. model null은 설정을 읽지 못했거나 값이 비어 모르는 조합이다.
 */
export function usedModelRoutes(snapshot: ControlSnapshot, models: ModelEnv | null): RouteUse[] {
  const uses = new Map<string, RouteUse>();
  const add = (routeId: string, provider: string, model: string | null | undefined) =>
    uses.set(JSON.stringify([routeId, provider, model || null]), { routeId, provider, model: model || null });
  const settings = mergeWithDefaults(snapshot.reviewSettings);
  // 손상된 행은 기본값 객체 그대로 돌아온다 — 읽지 못한 것으로 본다
  if (settings === DEFAULT_CRAWL_SETTINGS) for (const routeId of ["crawl-agent-review", "second-review", "grok-session-check"]) add(routeId, "unknown", null);
  else {
    const first = settings.firstReview ?? { provider: "claude-cli", model: models?.crawlReview };
    add("crawl-agent-review", first.provider, first.model);
    const second = [...settings.secondReview.voters, ...settings.secondReview.fallbacks ?? []];
    for (const voter of second) add("second-review", voter.provider, voter.model);
    const grok = [...second, ...settings.firstReview ? [settings.firstReview] : []].find(voter => voter.provider === "grok-cli");
    if (grok) add("grok-session-check", "grok-cli", grok.model);
  }
  for (const [routeId, key] of TEXT_ROUTES) add(routeId, "abcllm", models?.[key]);
  add("product-intro-check", "claude-cli", models?.introCheck);
  const audit = snapshot.auditCampaign;
  if (audit) add("product-audit", audit.provider === "abcllm" ? "abcllm" : "claude-cli", audit.model);
  return [...uses.values()];
}

const sameRoute = (a: RouteUse, b: RouteUse) => a.routeId === b.routeId && a.provider === b.provider && a.model === b.model;
/** open이 되면 쓰는 조합 중 serving 밖은 모두 호출 전에 미뤄진다(전역 스위치, route 단위 mode 없음). unused는 지금 부르지 않는 조합이라 정보로만 남긴다. */
export function modelRouteContracts(policy: ModelCapacityPolicy | null, ai2Mode: string | null, uses: readonly RouteUse[]): RouteContract[] {
  const rows: RouteContract[] = uses.map(use => {
    const spec = MODEL_ROUTES.find(row => row.routeId === use.routeId && row.provider === use.provider);
    const status: RouteStatus = use.model === null || !spec ? "unknown" : !spec.served ? "admission_only"
      : !policy?.routes.some(route => sameRoute(route, use)) ? "unmapped" : spec.served(use.model) ? "serving" : "no_contract";
    return { ...use, status };
  });
  for (const route of policy?.routes ?? []) {
    if (!uses.some(use => sameRoute(use, route))) rows.push({ routeId: route.routeId, provider: route.provider, model: route.model, status: "unused" });
  }
  for (const spec of MODEL_ROUTES) {
    if (!rows.some(row => row.routeId === spec.routeId && row.provider === spec.provider))
      rows.push({ routeId: spec.routeId, provider: spec.provider, model: null, status: "unused" });
  }
  // AI2 legacy job은 admission만 있다 — open이면 AI2 전체가 미뤄진다(items로 먼저 옮겨야 한다).
  if (ai2Mode === "legacy") rows.push({ routeId: "second-review", provider: "legacy-job", model: null, status: "stage_legacy" });
  return rows;
}
export const deferredRoutes = (rows: readonly RouteContract[]) => rows.filter(row => row.status !== "serving" && row.status !== "unused");

function storedCapacityPolicy(snapshot: ControlSnapshot): ModelCapacityPolicy | null {
  const parsed = modelCapacityPolicySchema.safeParse(snapshot.capacity.policy);
  return parsed.success && modelCapacityPolicyHash(parsed.data) === snapshot.capacity.policyHash ? parsed.data : null;
}
function storedHttpPolicyValid(snapshot: ControlSnapshot): boolean {
  const parsed = httpOriginPolicySchema.safeParse(snapshot.http.policy);
  return parsed.success && httpOriginPolicyHash(parsed.data) === snapshot.http.policyHash;
}

export type ControlPlan = { command: TransitionName; target: string; change: string; blocked: string[]; warnings: string[];
  policyHash?: string | null; routes?: RouteContract[] };

/** dry-run과 실행이 같이 쓰는 판정. 기대 상태 불일치·전환 규칙 위반은 blocked, 진행은 되지만 알아야 할 것은 warnings. models가 없으면 env에서 읽는 route는 미상이다. */
export function planPipelineControl(command: TransitionCommand, snapshot: ControlSnapshot, policyFile?: unknown, models: ModelEnv | null = null): ControlPlan {
  // parser가 명령별 필수 옵션을 보장한다.
  const o = command.options as ControlOptions, blocked: string[] = [], warnings: string[] = [];
  const ai2Mode = snapshot.stages.find(row => row.stage === "ai2")?.mode ?? null;
  const routesFor = (policy: ModelCapacityPolicy | null, legacyMode: string | null) =>
    modelRouteContracts(policy, legacyMode, usedModelRoutes(snapshot, models));
  const expect = (field: string, expected: unknown, actual: unknown) => {
    if (expected !== actual) blocked.push(`expect_${field}_mismatch:${actual ?? "none"}`);
  };
  if (snapshot.fence.state !== "active") blocked.push("site_fenced");
  const plan = (target: string, change: string, extra: Partial<ControlPlan> = {}): ControlPlan =>
    ({ command: command.name, target, change, blocked, warnings, ...extra });
  const newPolicy = <T>(schema: z.ZodType<T>, hash: (value: T) => string, current: string | null) => {
    const parsed = schema.safeParse(policyFile);
    if (!parsed.success) { blocked.push(`policy_invalid:${parsed.error.issues[0]?.path.join(".") || "root"}`); return null; }
    const next = hash(parsed.data);
    if (next === current) blocked.push("policy_unchanged");
    return { policy: parsed.data, hash: next };
  };

  if (command.area === "stage") {
    const s = snapshot.stages.find(row => row.stage === o.stage) as StageRow;
    const target = `pipeline_stage_modes:${s.stage}`;
    expect("epoch", o.expectEpoch, s.epoch);
    if (command.name === "stage contract") {
      expect("contract", o.expectContract, s.contract);
      if (s.mode !== "legacy") blocked.push("stage_transition_invalid");
      return plan(target, `writer_contract ${s.contract} → ${s.contract + 1}`);
    }
    if (s.contract < 1) blocked.push("stage_contract_required");
    // AI1/AI2 item consumer는 capacity가 open이 아니거나 그 stage가 쓰는 조합 중 serving이 아닌 것이 있으면 모든 모델 항목을 미룬다.
    const stageRoutes = () => routesFor(storedCapacityPolicy(snapshot), null)
      .filter(row => row.routeId === (s.stage === "ai1" ? "crawl-agent-review" : "second-review") && row.status !== "unused");
    const itemsWillDefer = (sink: string[], routes: readonly RouteContract[]) => {
      if (snapshot.capacity.mode !== "open") sink.push(`items_consumer_defers:capacity_${snapshot.capacity.mode}:${s.stage}`);
      else if (routes.some(row => row.status !== "serving")) sink.push(`items_consumer_defers:route_not_serving:${s.stage}`);
    };
    if (command.name === "stage drain") {
      expect("mode", o.fromMode, s.mode);
      if (o.fromMode === "draining") blocked.push("stage_transition_invalid");
      if (o.fromMode === "legacy" && s.consumers === 0) warnings.push(`consumer_heartbeat_missing:${s.stage}`);
      if (o.fromMode === "legacy") itemsWillDefer(warnings, stageRoutes());
      warnings.push(`stage_paused_until_complete:${s.stage}`);
      return plan(target, `${s.mode} → draining (epoch ${s.epoch} 유지)`);
    }
    expect("mode", "draining", s.mode);
    expect("draining_from", o.drainingFrom, s.drainingFrom);
    if (o.to === "draining") blocked.push("stage_transition_invalid");
    if (s.live > 0) blocked.push(`stage_not_drained:${s.live}`);
    if (o.to === "items" && s.consumers === 0) warnings.push(`consumer_heartbeat_missing:${s.stage}`);
    // items로 가는 쪽만 막는다. legacy 복귀는 막지 않는다.
    const routes = o.to === "items" ? stageRoutes() : undefined;
    if (routes) itemsWillDefer(command.allowStalledStage ? warnings : blocked, routes);
    if (s.drainingFrom === "legacy" && s.legacyJobLive) warnings.push(`legacy_job_in_flight:${s.stage}`);
    if (o.to === s.drainingFrom) warnings.push("drain_cancelled");
    if (s.unsettled > 0) warnings.push(`expired_unsettled_leases:${s.unsettled}`);
    return plan(target, `draining(from ${s.drainingFrom ?? "-"}) → ${o.to}, epoch ${s.epoch} → ${s.epoch + 1}`, routes ? { routes } : {});
  }

  if (command.area === "capacity" || command.area === "http") {
    const c = command.area === "capacity" ? snapshot.capacity : snapshot.http;
    const target = command.area === "capacity" ? "model_capacity_control" : "http_origin_control";
    expect("mode", o.fromMode, c.mode); expect("epoch", o.expectEpoch, c.epoch); expect("revision", o.expectRevision, c.revision);
    const held = c.reserved + c.dispatched + c.indeterminate;
    const unmappedInstances = (policy: unknown) => {
      const hosts = httpOriginPolicySchema.safeParse(policy).data?.instanceHosts ?? {};
      return snapshot.recentInstances.filter(instance => !Object.hasOwn(hosts, instance));
    };
    if (command.name === "capacity policy" || command.name === "http policy") {
      if (c.mode === "open") blocked.push(`${command.area}_policy_requires_closed`);
      const next = command.area === "capacity" ? newPolicy(modelCapacityPolicySchema, modelCapacityPolicyHash, c.policyHash)
        : newPolicy(httpOriginPolicySchema, httpOriginPolicyHash, c.policyHash);
      if (held > 0) warnings.push(`old_generation_held:${held}`);
      if (command.area === "http" && next) for (const instance of unmappedInstances(next.policy)) warnings.push(`instance_unmapped:${instance}`);
      return plan(target, `policy ${c.policyHash?.slice(0, 12) ?? "unset"} → ${next?.hash.slice(0, 12) ?? "?"}, revision ${c.revision} → ${c.revision + 1}`,
        { policyHash: next?.hash ?? null, ...(command.area === "capacity" && next ? { routes: routesFor(next.policy as ModelCapacityPolicy, ai2Mode) } : {}) });
    }
    if ((o.fromMode === "draining") === (o.to === "draining")) blocked.push(`${command.area}_transition_invalid`);
    if (o.to !== "disabled" && c.policy === null) blocked.push(`${command.area}_policy_missing`);
    if (o.to === "draining") warnings.push(`${command.area}_callers_defer_while_draining`);
    const policy = storedCapacityPolicy(snapshot);
    if (c.policy !== null && !(command.area === "capacity" ? policy : storedHttpPolicyValid(snapshot))) blocked.push(`${command.area}_policy_invalid`);
    if (command.area === "http") {
      if (o.to === "open") for (const instance of unmappedInstances(c.policy)) warnings.push(`instance_unmapped:${instance}`);
      return plan(target, `${c.mode} → ${o.to} (한도 고정: origin 1 · Oracle 합계 2)`);
    }
    if (snapshot.capacity.oldGeneration > 0) warnings.push(`old_generation_held:${snapshot.capacity.oldGeneration}`);
    if (o.to === "disabled" && c.dispatched + c.indeterminate > 0) warnings.push(`unsettled_dispatch_kept:${c.dispatched + c.indeterminate}`);
    if (o.to !== "open" || !policy) return plan(target, `${c.mode} → ${o.to}`);
    const routes = routesFor(policy, ai2Mode);
    const deferred = deferredRoutes(routes).length;
    if (deferred > 0) (command.allowDeferredRoutes ? warnings : blocked).push(`deferred_routes:${deferred}`);
    return plan(target, `${c.mode} → open`, { routes });
  }

  if (command.area === "agent-scan") {
    const a = snapshot.agentScan, target = "agent_scan_control";
    expect("epoch", o.expectEpoch, a.epoch);
    if (command.name === "agent-scan contract") {
      expect("contract", o.expectContract, a.contract);
      if (a.mode !== "legacy") blocked.push("agent_scan_transition_invalid");
      return plan(target, `writer_contract ${a.contract} → ${a.contract + 1}`);
    }
    if (a.contract < 1) blocked.push("agent_scan_contract_required");
    if (command.name === "agent-scan drain") {
      expect("mode", o.fromMode, a.mode);
      if (o.fromMode === "draining") blocked.push("agent_scan_transition_invalid");
      if (o.fromMode === "legacy" && a.consumers === 0) warnings.push("consumer_heartbeat_missing:agent-scan");
      // draining 동안 legacy 잡은 새 스캔을 시작하지 않고(컨트롤러만), consumer 는 claim 하지 않는다
      warnings.push("agent_scan_paused_until_complete");
      return plan(target, `${a.mode} → draining (epoch ${a.epoch} 유지)`);
    }
    expect("mode", "draining", a.mode);
    expect("draining_from", o.drainingFrom, a.drainingFrom);
    if (o.to === "draining") blocked.push("agent_scan_transition_invalid");
    if (a.live > 0) blocked.push(`agent_scan_not_drained:${a.live}`);
    if (o.to === "items" && a.consumers === 0) warnings.push("consumer_heartbeat_missing:agent-scan");
    if (a.drainingFrom === "legacy" && a.legacyJobLive) warnings.push("legacy_job_in_flight:agent-scan");
    if (o.to === a.drainingFrom) warnings.push("drain_cancelled");
    if (a.unsettled > 0) warnings.push(`expired_unsettled_claims:${a.unsettled}`);
    return plan(target, `draining(from ${a.drainingFrom ?? "-"}) → ${o.to}, epoch ${a.epoch} → ${a.epoch + 1}`);
  }

  const b = snapshot.batch, target = "job_batch_control";
  expect("epoch", o.expectEpoch, b.epoch);
  const policyValid = (() => { const parsed = batchPolicySchema.safeParse(b.policy); return parsed.success && batchPolicyHash(parsed.data) === b.policyHash; })();
  if (command.name === "batch policy") {
    expect("policy_hash", o.expectPolicyHash, b.policyHash);
    if (b.mode !== "legacy") blocked.push("batch_transition_invalid");
    const next = newPolicy(batchPolicySchema, batchPolicyHash, b.policyHash);
    return plan(target, `policy ${b.policyHash?.slice(0, 12) ?? "unset"} → ${next?.hash.slice(0, 12) ?? "?"}`, { policyHash: next?.hash ?? null });
  }
  if (command.name === "batch contract") {
    expect("contract", o.expectContract, b.contract);
    if (b.mode !== "legacy") blocked.push("batch_transition_invalid");
    return plan(target, `writer_contract ${b.contract} → ${b.contract + 1}`);
  }
  if (b.contract < 1) blocked.push("batch_contract_required");
  const quiet = `jobs=${b.liveJobs},roles=${b.liveRoles},items=${b.liveItems},sources=${b.liveSources},agent_claims=${b.liveAgentClaims}`;
  const busy = b.liveJobs + b.liveRoles + b.liveItems + b.liveSources + b.liveAgentClaims > 0;
  // legacy 에서 들어간 draining 은 versioned 로만 끝난다 — 응답 점검 분담(claims) 중에는 그 길을 열지 않는다(uptime-split 이 반대 방향을 막는다)
  const splitClaims = snapshot.uptimeSplitMode === "claims" ? "uptime_split_claims_active" : null;
  if (command.name === "batch drain") {
    expect("mode", o.fromMode, b.mode);
    if (o.fromMode === "draining") blocked.push("batch_transition_invalid");
    if (o.fromMode === "legacy" && splitClaims) blocked.push(splitClaims);
    // 기존 불변식: draining은 출발 mode로 되돌아갈 수 없다. legacy에서 들어가면 versioned로만 끝난다.
    if (o.fromMode === "legacy" && !policyValid) blocked.push("batch_policy_required_for_versioned");
    warnings.push(`batch_claims_paused_until_complete:${o.fromMode === "legacy" ? "versioned" : "legacy"}`);
    if (busy) warnings.push(`batch_live:${quiet}`);
    return plan(target, `${b.mode} → draining (epoch ${b.epoch} 유지)`);
  }
  expect("mode", "draining", b.mode);
  expect("draining_from", o.drainingFrom, b.drainingFrom);
  if (o.to === "draining" || o.to === b.drainingFrom) blocked.push("batch_transition_invalid");
  if (o.to === "versioned" && !policyValid) blocked.push("batch_policy_required_for_versioned");
  if (o.to === "versioned" && splitClaims) blocked.push(splitClaims);
  if (busy) blocked.push(`batch_not_drained:${quiet}`);
  return plan(target, `draining(from ${b.drainingFrom ?? "-"}) → ${o.to}, epoch ${b.epoch} → ${b.epoch + 1}`);
}

export type ControlResult = { command: TransitionName; dryRun: boolean; executed: boolean; blocked: boolean; plan: ControlPlan;
  before: ControlSnapshot; after?: ControlSnapshot; auditId?: number };

function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string[] {
  const cells = [headers, ...rows].map(row => row.map(value => value === null || value === undefined ? "-" : String(value)));
  const widths = headers.map((_, index) => Math.max(...cells.map(row => row[index].length)));
  return cells.map(row => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd());
}
const policyLabel = (policy: unknown, hash: string | null) => policy === null ? "unset" : hash ? hash.slice(0, 12) : "invalid";

function areaLines(snapshot: ControlSnapshot, area: Area | "all"): string[] {
  const lines: string[] = [];
  if (area === "all" || area === "stage") lines.push("[stage]", ...table(["stage", "mode", "from", "epoch", "contract", "live", "unsettled", "legacy_job", "consumers"],
    snapshot.stages.map(s => [s.stage, s.mode, s.drainingFrom, s.epoch, s.contract, s.live, s.unsettled, s.legacyJobLive ? "live" : "idle", s.consumers])));
  if (area === "all" || area === "capacity") {
    const c = snapshot.capacity;
    lines.push(`[capacity] mode=${c.mode} epoch=${c.epoch} revision=${c.revision} policy=${policyLabel(c.policy, c.policyHash)}`
      + ` waiting=${c.waiting} reserved=${c.reserved} dispatched=${c.dispatched} indeterminate=${c.indeterminate} old_generation=${c.oldGeneration}`);
  }
  if (area === "all" || area === "http") {
    const h = snapshot.http;
    lines.push(`[http] mode=${h.mode} epoch=${h.epoch} revision=${h.revision} policy=${policyLabel(h.policy, h.policyHash)}`
      + ` reserved=${h.reserved} dispatched=${h.dispatched} indeterminate=${h.indeterminate} (한도 고정: origin 1 · Oracle 합계 2)`);
  }
  if (area === "all" || area === "batch") {
    const b = snapshot.batch;
    lines.push(`[batch] mode=${b.mode} from=${b.drainingFrom ?? "-"} epoch=${b.epoch} contract=${b.contract} policy=${policyLabel(b.policy, b.policyHash)}`
      + ` live jobs=${b.liveJobs} roles=${b.liveRoles} items=${b.liveItems} sources=${b.liveSources} agent_claims=${b.liveAgentClaims}`);
  }
  if (area === "all" || area === "agent-scan") {
    const a = snapshot.agentScan;
    lines.push(`[agent-scan] mode=${a.mode} from=${a.drainingFrom ?? "-"} epoch=${a.epoch} contract=${a.contract} live=${a.live}`
      + ` unsettled=${a.unsettled} legacy_job=${a.legacyJobLive ? "live" : "idle"} consumers=${a.consumers}`,
    ...table(["priority", "waiting", "oldest_min"], a.queue.map(row => [row.priority, row.waiting, row.oldestMinutes])));
  }
  return lines;
}
const routeLines = (routes: readonly RouteContract[]) =>
  table(["route", "provider", "model", "status"], routes.map(row => [row.routeId, row.provider, row.model, row.status]));

/** status 의 route 판정 — 저장된 슬롯 정책(hash 가 맞을 때만)과 AI2 mode 로. CLI status 와 관리자 화면(model-route-status.ts)이 같이 쓴다 */
export function statusRouteContracts(snapshot: ControlSnapshot, models: ModelEnv | null): RouteContract[] {
  return modelRouteContracts(storedCapacityPolicy(snapshot), snapshot.stages.find(row => row.stage === "ai2")?.mode ?? null,
    usedModelRoutes(snapshot, models));
}

/** 사람이 읽는 출력. --json이면 이 대신 결과 JSON 한 줄을 쓴다. area 를 주면 그 칸만(`agent-scan status`). */
export function formatControlStatus(snapshot: ControlSnapshot, models: ModelEnv | null = null, area?: "agent-scan"): string {
  const header = `DB 시각 ${snapshot.now}  fence=${snapshot.fence.state}(writer epoch ${snapshot.fence.writerEpoch})`;
  if (area) return [header, ...areaLines(snapshot, area), ""].join("\n");
  const routes = statusRouteContracts(snapshot, models);
  return [header, ...areaLines(snapshot, "all"),
    "[capacity routes] open이면 serving·unused 밖은 모두 미뤄진다(unused = 지금 설정·env가 부르지 않는 조합, 정보)", ...routeLines(routes), ""].join("\n");
}
export function formatControlResult(result: ControlResult): string {
  const { plan } = result, area = result.command.split(" ")[0] as Area;
  const state = result.executed ? `실행 완료(감사 로그 id ${result.auditId})` : result.blocked ? "거절 — 아무것도 쓰지 않았다"
    : result.dryRun ? "dry-run 허용 — DB 쓰기 없음. 같은 명령에 --execute를 붙이면 실행한다" : "실행하지 않음";
  return [`${result.command} — ${state}`, `대상  ${plan.target}`, `변경  ${plan.change}`,
    ...plan.blocked.map(code => `거절  ${code}`), ...plan.warnings.map(code => `경고  ${code}`),
    ...(plan.policyHash ? [`새 policy hash  ${plan.policyHash}`] : []),
    "현재:", ...areaLines(result.before, area),
    ...(plan.routes ? ["routes:", ...routeLines(plan.routes)] : []),
    ...(result.after ? ["실행 뒤 readback:", ...areaLines(result.after, area)] : []), ""].join("\n");
}
