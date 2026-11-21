import { createHash } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { modelCapacityControl, modelHelperAssignments, modelServingContracts, operationsAudit } from "@/lib/db/schema";
import { modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityPolicy, type ModelCapacityRoute } from "@/lib/llm/capacity";
import { ASSIGNMENT_STAGES } from "@/lib/llm/capacity-helpers";
import { parseCliEngineRevision } from "@/lib/llm/cli-engine-config";
import { OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, servingContractWireModel } from "@/lib/llm/direct-serving-contract";
import { GATEWAY_SERVING_CONTRACT_ROUTES, type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { adminAuditRow } from "./admin-log";
import { saveServingContractTx, servingContractHash, validateAdminServingContract } from "./admin-serving-contracts";
import { contractReaderGateText, readContractReaderGate, type ContractReaderGate } from "./contract-reader-gate";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";

/**
 * abcllm 계약 → 엔진 직접 총량 상한 계약(openai-chat-total-bound-v1, provider local-direct) 전환과 되돌리기(2026-11-21 abcllm 이름표 정리 2단계).
 * 관리 화면 단추(/admin/models/contracts)와 운영 스크립트(scripts/ops/serving-contract-convert.ts)가 같은 함수를 부른다. 둘 다 계획(dry-run)이 먼저다 —
 * 실행은 계획 hash 가 같을 때만 쓴다(그 사이 계약·정책이 바뀌면 거절한다).
 *
 * 전환(한 경로, 고르면 한 모델):
 * - 그 경로의 켜진 abcllm 계약마다 같은 API 주소·모델(장부 이름 글자 그대로 — #1011 의 심사자 이름표 옮김은 글자가 같을 때만 된다)·engineModel·
 *   totalTokenBound·추론 토큰 여유·429 쉼 정책·배포 리비전으로 새 모양을 만들고 관리 저장(saveServingContractTx)으로 다시 저장한다.
 *   키는 다시 넣지 않는다 — 저장이 앞 행의 암호문을 이어 쓴다(AAD 가 경로·모델에 묶여 같은 경로·모델이면 그대로 열린다). 앞 행은 꺼진 채 남는다.
 * - 2차의 requestBudget 은 tokenizer 묶음 + maxOutputTokens 로 옮긴다. tokenizer 에 물을 이름(tokenizerModel)이 엔진 이름(engineModel ?? model)과
 *   다르면 새 모양이 담지 못하므로 거절한다(PR #1012 리뷰). 엄격 terminal 표시는 버린다(새 모양에 그 칸이 없다).
 * - 정책에 (경로, local-direct, 모델, 그 abcllm route 의 예산·장비 그대로)를 경로 단위로 한 번에 덧붙인다(appendCompatibleRoutes — DRAIN 없음,
 *   세대는 한 번만 오른다). abcllm route 는 남는다(되돌리기가 쓴다).
 * - 새 모양을 담지 못하는 계약은 거절하고 까닭을 계획에 적는다(나머지는 전환한다 — 계획이 무엇을 바꾸는지 그대로 보인다).
 * - 실전(live) 도우미 배정이 같은 경로(그 단계 — 2차는 ai2)·같은 장비·같은 모델이면 거절한다: 전환하면 (경로, local-direct, 모델)이 그 도우미의
 *   실전 경로와 겹쳐 주 호출이 도우미 관문을 지난다(2단계 2b 발견 — 방어용, 2026-11-21 운영에는 배정 행이 없다).
 * - 계약 읽기 관문(contract-reader-gate.ts)이 닫혀 있으면 아무것도 쓰지 않는다.
 * 되돌리기(한 경로, 고르면 한 모델): 켜진 새 모양 계약마다 바로 앞의 꺼진 abcllm 행(같은 경로·모델, 더 작은 id 중 가장 최근)을 그 JSON·인증·전송 그대로
 * 다시 저장한다. 정책은 바꾸지 않는다(abcllm route 가 남아 있어야 한다). 옛 판도 읽는 모양으로 돌아가는 것이라 관문을 보지 않는다.
 * 모든 쓰기는 관리 저장 함수(감사 `model-serving-contract-save`)와 감사 한 줄(`model-serving-contract-convert`·`-revert`)로 남는다.
 */
export const SERVING_CONTRACT_CONVERT_AUDIT_ACTION = "model-serving-contract-convert";
export const SERVING_CONTRACT_REVERT_AUDIT_ACTION = "model-serving-contract-revert";
export type ConversionAction = "convert" | "revert";

const ABCLLM_FIELDS: ReadonlySet<string> = new Set(["version", "protocol", "routeId", "provider", "model", "responseModel", "deploymentRevision", "endpoint",
  "totalTokenBound", "strictTerminalOptIn", "engineModel", "reasoningTokenReserve", "rateLimitBackoff", "requestBudget"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type ConversionRefusalReason = "not_abcllm" | "transport_not_direct" | "auth_gateway" | "unmapped_field" | "tokenizer_model_differs"
  | "new_shape_invalid" | "policy_route_missing" | "local_direct_route_conflict" | "no_previous_abcllm" | "previous_invalid" | "key_missing"
  | "abcllm_route_missing" | "helper_live_route_overlap";
export type ConversionMapping = { ok: true; contract: Readonly<Record<string, unknown>> } | { ok: false; reason: ConversionRefusalReason; detail?: string };

/**
 * 한 abcllm 계약 → 새 모양(순수). 모르는 칸이 있으면 거절한다(옮겨 적지 못한 뜻을 버리지 않는다). 결과는 경로 스키마로 다시 검사하고, 장부 이름·
 * 엔진에 가는 이름·주소·상한·여유·쉼 정책이 글자 그대로인지 한 번 더 견준다.
 */
export function totalBoundContractFromAbcllm(routeId: GatewayServingRoute, value: unknown): ConversionMapping {
  const old = record(value);
  if (old.provider !== "abcllm" || typeof old.protocol !== "string" || !old.protocol.startsWith("abcllm-") || old.routeId !== routeId)
    return { ok: false, reason: "not_abcllm" };
  const unknown = Object.keys(old).filter(key => !ABCLLM_FIELDS.has(key));
  if (unknown.length) return { ok: false, reason: "unmapped_field", detail: unknown.sort().join(",") };
  const next: Record<string, unknown> = { version: 1, protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, routeId, provider: "local-direct", model: old.model,
    responseModel: old.responseModel, deploymentRevision: old.deploymentRevision, endpoint: old.endpoint, totalTokenBound: old.totalTokenBound };
  for (const key of ["engineModel", "reasoningTokenReserve", "rateLimitBackoff"] as const) if (old[key] !== undefined) next[key] = old[key];
  if (old.requestBudget !== undefined) {
    const budget = record(old.requestBudget), wire = typeof old.engineModel === "string" && old.engineModel ? old.engineModel : old.model;
    if (budget.tokenizerModel !== wire) return { ok: false, reason: "tokenizer_model_differs", detail: `${String(budget.tokenizerModel)} ≠ ${String(wire)}` };
    next.maxOutputTokens = budget.maxOutputTokens;
    next.tokenizer = { endpoint: budget.tokenizerEndpoint, requestTokenBound: budget.requestTokenBound };
  }
  const checked = validateAdminServingContract(routeId, next);
  if (!checked.ok) return { ok: false, reason: "new_shape_invalid", detail: checked.reason };
  const parsed = checked.contract as Record<string, unknown> & { model: string };
  const wireOf = (contract: Record<string, unknown>) => servingContractWireModel(contract as { provider?: unknown; protocol?: unknown; model: string; engineModel?: unknown });
  if (parsed.protocol !== OPENAI_CHAT_TOTAL_BOUND_PROTOCOL || parsed.model !== old.model || wireOf(parsed) !== wireOf(old as Record<string, unknown> & { model: string })
    || parsed.endpoint !== old.endpoint || parsed.totalTokenBound !== old.totalTokenBound || !same(parsed.engineModel, old.engineModel)
    || !same(parsed.reasoningTokenReserve, old.reasoningTokenReserve) || !same(parsed.rateLimitBackoff, old.rateLimitBackoff))
    return { ok: false, reason: "new_shape_invalid", detail: "field_drift" };
  return { ok: true, contract: parsed };
}

export type ConversionTarget = Readonly<{ id: number; model: string; contractHash: string; auth: string; transport: string;
  /** 전환: 새 모양 · 되돌리기: 다시 저장할 앞 abcllm 계약 */
  next: Readonly<Record<string, unknown>>; nextHash: string; nextAuth: string; nextTransport: string;
  /** 되돌리기만: 다시 저장할 앞 행 id */
  restoreId?: number;
  endpoint: string | null; wireModel: string }>;
export type ConversionRefusal = Readonly<{ id: number | null; model: string; reason: ConversionRefusalReason; detail: string | null }>;
export type ConversionPlan = Readonly<{
  action: ConversionAction; routeId: string; model: string | null;
  targets: readonly ConversionTarget[]; refusals: readonly ConversionRefusal[];
  /** 전환이 덧붙일 정책 route(이미 같은 것이 있으면 빠진다) */
  appendRoutes: readonly ModelCapacityRoute[];
  /** 알림(막지 않는다): 경로별 전환 전 확인·줄에 선 abcllm 장부 행 수 */
  notes: readonly string[];
  /** 전환만 — 되돌리기는 null */
  gate: ContractReaderGate | null;
  /** 실행을 막는 것: unknown_route · policy_missing · contract_reader_gate_closed · nothing_to_do */
  blocked: string | null;
  planHash: string;
}>;

type ContractRow = typeof modelServingContracts.$inferSelect;
type HelperRow = Readonly<{ assignmentId: string; stage: string; deviceId: string; model: string; liveRouteId: string }>;
type State = { enabled: readonly ContractRow[]; previous: ReadonlyMap<number, ContractRow>; policy: ModelCapacityPolicy | null;
  gate: ContractReaderGate | null; ledger: ReadonlyMap<string, Readonly<Record<string, number>>>;
  /** role 'helper' · mode 'live' 배정 행(전환만 읽는다) */
  helpers: readonly HelperRow[] };
/** 경로를 주 경로로 쓰는 배정 단계(1차 ai1 · 2차 ai2 …) — 그 단계의 도우미가 이 경로를 실전 경로로 둘 수 있다 */
const routeStages = (routeId: string): string[] => Object.entries(ASSIGNMENT_STAGES).filter(([, spec]) => spec.routeId === routeId).map(([stage]) => stage);

/** 경로별로 전환 전에 사람이 확인할 것(막지 않는다 — 3단계 절차가 정한 순서와 확인 항목). */
function routeNotes(routeId: string, targets: readonly ConversionTarget[]): string[] {
  const notes = ["D-6: 새 모양은 context_strategy 없이 보낸다(2단계 wire) — 이 경로의 서버마다 같은 입력 표본으로 전후를 견준 뒤 실행하세요."];
  if (["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"].includes(routeId))
    notes.push("번역 경로: 엄격 terminal 헤더(X-Abcllm-Strict-Terminal)가 더는 나가지 않습니다 — 계획 0-12 실측(헤더 유무의 usage 차이)을 먼저 보세요.");
  if (routeId === "second-review")
    notes.push("2차: 전환 전에 capacity 대체(local-direct 표만 다음 순위로)·도우미 실전 경로(second-review, local-direct)와의 겹침을 확인하세요. "
      + "전환 직후 second_reviews 의 pending·failed abcllm 표가 0 으로 내려가는지 보세요(이름표 옮김은 장부 이름이 글자 그대로일 때만 됩니다).");
  if (routeId === "crawl-agent-review") notes.push("1차: 심사자 identity 동등 규칙(#1011)에 기댑니다 — 장부 이름은 글자 그대로 옮깁니다. 전환 직후 재심사 수를 보세요.");
  if (targets.some(target => parseCliEngineRevision(target.next.deploymentRevision) !== null))
    notes.push("CLI 엔진(OpenCode) 계약이 있습니다 — 그 엔진이 닿는지(계획 0-2)와 CLI 엔진 local-direct 시험을 확인한 뒤 실행하세요.");
  return notes;
}

const planDigest = (plan: Omit<ConversionPlan, "planHash" | "notes" | "gate">) => createHash("sha256").update(JSON.stringify({
  action: plan.action, routeId: plan.routeId, model: plan.model, blocked: plan.blocked,
  targets: plan.targets.map(target => [target.id, target.contractHash, target.nextHash, target.nextAuth, target.restoreId ?? null]),
  refusals: plan.refusals.map(refusal => [refusal.id, refusal.model, refusal.reason]),
  routes: plan.appendRoutes.map(route => [route.routeId, route.provider, route.model, route.providerBudgetId, route.groupId]) })).digest("hex");

/** 읽은 상태 → 계획(순수에 가깝다 — DB 를 부르지 않는다). 계획과 실행이 같은 함수를 쓴다. */
function buildPlan(action: ConversionAction, routeId: string, model: string | null, state: State): ConversionPlan {
  const targets: ConversionTarget[] = [], refusals: ConversionRefusal[] = [], appendRoutes: ModelCapacityRoute[] = [];
  const known = (GATEWAY_SERVING_CONTRACT_ROUTES as readonly string[]).includes(routeId);
  const refuse = (row: { id: number | null; model: string }, reason: ConversionRefusalReason, detail: string | null = null) =>
    refusals.push(Object.freeze({ id: row.id, model: row.model, reason, detail }));
  const policyRoutes = state.policy?.routes ?? [];
  const wire = (contract: Record<string, unknown>, fallback: string) =>
    servingContractWireModel({ ...contract, model: typeof contract.model === "string" ? contract.model : fallback });
  if (known) for (const row of state.enabled) {
    const contract = record(row.contract);
    if (action === "convert") {
      if (contract.provider !== "abcllm") continue;
      if (row.transport !== "direct") { refuse(row, "transport_not_direct"); continue; }
      if (row.auth === "gateway") { refuse(row, "auth_gateway"); continue; }
      const mapped = totalBoundContractFromAbcllm(routeId as GatewayServingRoute, contract);
      if (!mapped.ok) { refuse(row, mapped.reason, mapped.detail ?? null); continue; }
      const from = policyRoutes.find(route => route.routeId === routeId && route.provider === "abcllm" && route.model === row.model);
      if (!from) { refuse(row, "policy_route_missing", `${routeId} / abcllm / ${row.model}`); continue; }
      const to: ModelCapacityRoute = Object.freeze({ routeId, provider: "local-direct", model: row.model, providerBudgetId: from.providerBudgetId, groupId: from.groupId });
      const existing = policyRoutes.find(route => route.routeId === routeId && route.provider === "local-direct" && route.model === row.model);
      if (existing && (existing.providerBudgetId !== to.providerBudgetId || existing.groupId !== to.groupId)) {
        refuse(row, "local_direct_route_conflict", `${existing.providerBudgetId} · ${existing.groupId}`); continue;
      }
      // 실전 도우미와 겹침: 같은 단계(또는 이 경로를 실전 경로로 둔 도우미)·같은 장비·같은 모델
      const helper = state.helpers.find(entry => (routeStages(routeId).includes(entry.stage) || entry.liveRouteId === routeId)
        && entry.deviceId === to.groupId && entry.model === row.model);
      if (helper) { refuse(row, "helper_live_route_overlap", helper.assignmentId); continue; }
      if (!existing) appendRoutes.push(to);
      targets.push(Object.freeze({ id: row.id, model: row.model, contractHash: row.contractHash, auth: row.auth, transport: row.transport,
        next: mapped.contract, nextHash: servingContractHash(mapped.contract), nextAuth: row.auth, nextTransport: "direct",
        endpoint: typeof mapped.contract.endpoint === "string" ? mapped.contract.endpoint : null, wireModel: wire(mapped.contract, row.model) }));
      continue;
    }
    if (contract.protocol !== OPENAI_CHAT_TOTAL_BOUND_PROTOCOL) continue;
    const previous = state.previous.get(row.id);
    if (!previous) { refuse(row, "no_previous_abcllm"); continue; }
    const checked = validateAdminServingContract(routeId, previous.contract);
    if (!checked.ok || servingContractHash(checked.contract) !== previous.contractHash || checked.contract.model !== row.model) {
      refuse(row, "previous_invalid", `#${previous.id}`); continue;
    }
    if (previous.transport !== "direct" || previous.auth === "gateway") { refuse(row, previous.transport !== "direct" ? "transport_not_direct" : "auth_gateway", `#${previous.id}`); continue; }
    if (previous.auth === "stored" && row.auth !== "stored") { refuse(row, "key_missing", `#${previous.id}`); continue; }
    if (!policyRoutes.some(route => route.routeId === routeId && route.provider === "abcllm" && route.model === row.model)) {
      refuse(row, "abcllm_route_missing", `${routeId} / abcllm / ${row.model}`); continue;
    }
    targets.push(Object.freeze({ id: row.id, model: row.model, contractHash: row.contractHash, auth: row.auth, transport: row.transport,
      next: checked.contract, nextHash: previous.contractHash, nextAuth: previous.auth, nextTransport: previous.transport, restoreId: previous.id,
      endpoint: typeof checked.contract.endpoint === "string" ? checked.contract.endpoint : null, wireModel: wire(checked.contract, row.model) }));
  }
  const blocked = !known ? "unknown_route" : action === "convert" && !state.policy ? "policy_missing"
    : action === "convert" && !state.gate?.ok ? "contract_reader_gate_closed" : !targets.length ? "nothing_to_do" : null;
  const notes = action === "convert" && known ? routeNotes(routeId, targets) : [];
  const providerOf = action === "convert" ? "abcllm" : "local-direct";
  for (const target of targets) {
    const counts = state.ledger.get(target.model) ?? {};
    const live = (counts.waiting ?? 0) + (counts.reserved ?? 0) + (counts.dispatched ?? 0);
    if (live || counts.indeterminate) notes.push(`${target.model}: 줄에 선 ${providerOf} 장부 행 대기 ${counts.waiting ?? 0} · 예약 ${counts.reserved ?? 0} · 보냄 ${counts.dispatched ?? 0}`
      + ` · 미확정 ${counts.indeterminate ?? 0} — 잡을 멈추고 대기·예약·보냄이 0 이 된 뒤 실행하세요(줄에 선 옛 이름표 요청은 준비에서 닫힙니다).`);
  }
  const body = { action, routeId, model, targets: Object.freeze(targets), refusals: Object.freeze(refusals), appendRoutes: Object.freeze(appendRoutes), blocked };
  return Object.freeze({ ...body, notes: Object.freeze(notes), gate: action === "convert" ? state.gate : null, planHash: planDigest(body) });
}

type Reader = Pick<typeof db, "select" | "execute">;
/** 계획에 필요한 것을 읽는다. lock 이면(실행 TX) 켜진 계약 행과 용량 control 행을 FOR UPDATE 로 쥔다 — 관리 저장·정책 덧붙이기와 같은 순서(계약 → control). */
async function readState(reader: Reader, action: ConversionAction, routeId: string, model: string | null, lock: boolean): Promise<State> {
  const where = and(eq(modelServingContracts.routeId, routeId), eq(modelServingContracts.enabled, true),
    model === null ? undefined : eq(modelServingContracts.model, model));
  const select = reader.select().from(modelServingContracts).where(where).orderBy(modelServingContracts.model, modelServingContracts.id);
  const enabled = lock ? await select.for("update") : await select;
  const previous = new Map<number, ContractRow>();
  if (action === "revert") for (const row of enabled) {
    if (record(row.contract).protocol !== OPENAI_CHAT_TOTAL_BOUND_PROTOCOL) continue;
    const [before] = await reader.select().from(modelServingContracts).where(and(eq(modelServingContracts.routeId, routeId), eq(modelServingContracts.model, row.model),
      eq(modelServingContracts.enabled, false), lt(modelServingContracts.id, row.id), sql`${modelServingContracts.contract}->>'provider' = 'abcllm'`))
      .orderBy(desc(modelServingContracts.id)).limit(1);
    if (before) previous.set(row.id, before);
  }
  const controlSelect = reader.select({ policy: modelCapacityControl.policy, policyHash: modelCapacityControl.policyHash }).from(modelCapacityControl)
    .where(eq(modelCapacityControl.id, 1));
  const [control] = lock ? await controlSelect.for("update") : await controlSelect;
  let policy: ModelCapacityPolicy | null = null;
  try {
    policy = control?.policy ? parseModelCapacityPolicy(control.policy) : null;
    if (policy && modelCapacityPolicyHash(policy) !== control!.policyHash) policy = null;
  } catch { policy = null; }
  const gate = action === "convert" ? await readContractReaderGate(reader) : null;
  const helpers = action !== "convert" ? [] : await reader.select({ assignmentId: modelHelperAssignments.assignmentId, stage: modelHelperAssignments.stage,
    deviceId: modelHelperAssignments.deviceId, model: modelHelperAssignments.model, liveRouteId: modelHelperAssignments.liveRouteId }).from(modelHelperAssignments)
    .where(and(eq(modelHelperAssignments.role, "helper"), eq(modelHelperAssignments.mode, "live")));
  const models = enabled.map(row => row.model), ledger = new Map<string, Record<string, number>>();
  if (models.length) {
    const rows = Array.from(await reader.execute<{ model: string; state: string; count: number | string }>(sql`
      SELECT model, state, count(*)::int AS count FROM model_capacity_requests
      WHERE route_id = ${routeId} AND provider = ${action === "convert" ? "abcllm" : "local-direct"} AND state IN ('waiting','reserved','dispatched','indeterminate')
        AND model IN (${sql.join(models.map(value => sql`${value}`), sql`, `)})
      GROUP BY model, state`));
    for (const row of rows) ledger.set(row.model, { ...ledger.get(row.model), [row.state]: Number(row.count) });
  }
  return { enabled, previous, policy, gate, ledger, helpers };
}

const checkInput = (routeId: string, model: string | null) => {
  if (typeof routeId !== "string" || !routeId || routeId.length > 64) throw new Error("serving_contract_convert_input_invalid");
  if (model !== null && (typeof model !== "string" || !model || model.length > 200 || model !== model.trim())) throw new Error("serving_contract_convert_input_invalid");
};

/** 계획(dry-run) — 쓰지 않는다. */
export async function planServingContractConversion(input: { action: ConversionAction; routeId: string; model?: string | null }): Promise<ConversionPlan> {
  const model = input.model ?? null;
  checkInput(input.routeId, model);
  if (input.action !== "convert" && input.action !== "revert") throw new Error("serving_contract_convert_input_invalid");
  return buildPlan(input.action, input.routeId, model, await onPrimary(() => readState(db, input.action, input.routeId, model, false)));
}

export type ConversionResult = Readonly<{ action: ConversionAction; routeId: string; model: string | null;
  saved: readonly Readonly<{ model: string; previousId: number; id: number; previousHash: string; contractHash: string }>[];
  refusals: readonly ConversionRefusal[]; appended: readonly ModelCapacityRoute[]; policyRevision: number | null }>;

/**
 * 실행 — 계획 hash 가 같을 때만 한 TX 에서: DR fence → 켜진 계약 행 FOR UPDATE → control FOR UPDATE → (전환) 관문을 같은 TX 로 다시 읽음 → 계획을 다시 만들어
 * hash 를 견줌 → 계약마다 관리 저장 → (전환) 정책 route 덧붙이기 → 감사 한 줄. 던지면 TX 가 되돌린다. 거절 코드:
 * serving_contract_convert_plan_changed · serving_contract_convert_blocked:<까닭>.
 */
export async function applyServingContractConversion(input: { action: ConversionAction; routeId: string; model?: string | null; planHash: string },
  actor: string): Promise<ConversionResult> {
  const model = input.model ?? null;
  checkInput(input.routeId, model);
  if (input.action !== "convert" && input.action !== "revert") throw new Error("serving_contract_convert_input_invalid");
  if (!/^[a-f0-9]{64}$/.test(input.planHash) || typeof actor !== "string" || !actor.trim() || actor.length > 120) throw new Error("serving_contract_convert_input_invalid");
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const state = await readState(tx, input.action, input.routeId, model, true);
    const plan = buildPlan(input.action, input.routeId, model, state);
    if (plan.planHash !== input.planHash) throw new Error("serving_contract_convert_plan_changed");
    if (plan.blocked) throw new Error(`serving_contract_convert_blocked:${plan.blocked}`);
    const verb = input.action === "convert" ? "abcllm → 직접 연결 전환" : "직접 연결 → abcllm 되돌리기";
    const saved = [];
    for (const target of plan.targets) {
      const result = await saveServingContractTx(tx, { routeId: input.routeId, contract: target.next, auth: target.nextAuth as "none" | "stored",
        transport: target.nextTransport as "direct", note: `${verb} · 앞 계약 #${target.id}${target.restoreId ? ` · 되살린 계약 #${target.restoreId}` : ""}`,
        ...(state.gate ? { contractReaderGate: state.gate } : {}) }, actor);
      if (result.contractHash !== target.nextHash) throw new Error("serving_contract_convert_plan_changed");
      saved.push(Object.freeze({ model: target.model, previousId: target.id, id: result.id, previousHash: target.contractHash, contractHash: result.contractHash }));
    }
    let appended: readonly ModelCapacityRoute[] = [], policyRevision: number | null = null;
    if (plan.appendRoutes.length) {
      const { appendCompatibleRoutes } = await import("@/lib/llm/capacity-repository");
      const done = await appendCompatibleRoutes(tx, plan.appendRoutes);
      appended = done.appended; policyRevision = done.policyRevision;
    }
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: input.action === "convert" ? SERVING_CONTRACT_CONVERT_AUDIT_ACTION
      : SERVING_CONTRACT_REVERT_AUDIT_ACTION, target: `${input.routeId}${model ? `:${model}` : ""}`.slice(0, 200), detail: { planHash: plan.planHash,
      saved: saved.map(row => ({ ...row })), refusals: plan.refusals.map(row => ({ ...row })), appended: appended.map(row => ({ ...row })), policyRevision,
      ...(state.gate ? { gate: { releases: [...state.gate.releases], checked: { ...state.gate.checked } } } : {}) } }));
    return Object.freeze({ action: input.action, routeId: input.routeId, model, saved: Object.freeze(saved), refusals: plan.refusals,
      appended: Object.freeze([...appended]), policyRevision });
  }));
}

const REFUSAL_TEXT: Record<ConversionRefusalReason, string> = {
  not_abcllm: "abcllm 계약이 아닙니다", transport_not_direct: "엔진 직접 전송이 아닌 계약입니다(호출되지 않는 옛 게이트웨이 행)",
  auth_gateway: "옛 게이트웨이 키 방식입니다(호출되지 않음) — 키 없음 또는 저장 키로 다시 저장한 뒤 전환하세요",
  unmapped_field: "새 모양이 담지 못하는 칸이 있습니다", tokenizer_model_differs: "2차 requestBudget 의 tokenizer 이름이 엔진에 보내는 이름과 다릅니다(새 모양은 엔진 이름으로만 묻습니다)",
  new_shape_invalid: "새 모양 검사를 통과하지 못했습니다", policy_route_missing: "용량 정책에 이 계약의 abcllm route 가 없어 예산·장비를 옮길 수 없습니다",
  local_direct_route_conflict: "용량 정책에 같은 (경로, local-direct, 모델) route 가 다른 예산·장비로 있습니다",
  no_previous_abcllm: "되살릴 앞 abcllm 계약 행이 없습니다", previous_invalid: "앞 abcllm 계약이 지금 검사·hash 를 통과하지 못합니다",
  key_missing: "앞 계약은 저장 키인데 지금 행에 키가 없습니다", abcllm_route_missing: "용량 정책에 abcllm route 가 없어 되돌려도 호출되지 않습니다",
  helper_live_route_overlap: "같은 장비·모델의 실전 도우미 배정이 있어, 전환하면 이 경로가 그 도우미의 실전 경로(도우미 관문)가 됩니다 — 도우미를 끄거나 다른 장비로 옮긴 뒤 전환하세요",
};
export const conversionRefusalText = (refusal: Readonly<{ reason: ConversionRefusalReason; detail?: string | null }>) => `${REFUSAL_TEXT[refusal.reason]}${refusal.detail ? ` (${refusal.detail})` : ""}`;
const BLOCKED_TEXT: Record<string, string> = {
  unknown_route: "모르는 경로입니다.", policy_missing: "용량 정책을 읽지 못했습니다(없거나 hash 가 맞지 않음).",
  contract_reader_gate_closed: "계약 읽기 관문이 닫혀 있습니다.", nothing_to_do: "바꿀 계약이 없습니다.",
};
/** 계획 한 덩어리의 한국어 줄(화면·스크립트 공용). */
export function conversionPlanLines(plan: ConversionPlan): string[] {
  const lines = [`${plan.action === "convert" ? "전환" : "되돌리기"} 계획 · ${plan.routeId}${plan.model ? ` · ${plan.model}` : ""} · hash ${plan.planHash.slice(0, 12)}`];
  if (plan.gate) lines.push(`관문: ${contractReaderGateText(plan.gate)}`);
  if (plan.blocked) lines.push(`실행 불가: ${BLOCKED_TEXT[plan.blocked] ?? plan.blocked}`);
  for (const target of plan.targets) lines.push(`${plan.action === "convert" ? "전환" : "되살림"} #${target.id} ${target.model} → ${target.wireModel} @ ${target.endpoint ?? "?"}`
    + ` (${target.nextAuth === "stored" ? "저장 키 이어 씀" : "키 없음"}${target.restoreId ? ` · 앞 계약 #${target.restoreId}` : ""})`);
  for (const route of plan.appendRoutes) lines.push(`정책 덧붙임 ${route.routeId} / ${route.provider} / ${route.model} → 예산 ${route.providerBudgetId} · 장비 ${route.groupId}`);
  for (const refusal of plan.refusals) lines.push(`거절 ${refusal.id ? `#${refusal.id} ` : ""}${refusal.model}: ${conversionRefusalText(refusal)}`);
  for (const note of plan.notes) lines.push(`확인 ${note}`);
  return lines;
}

/** 시험·화면이 계획과 같은 모양으로 쓰는 경로 목록 */
export const CONVERTIBLE_ROUTES = GATEWAY_SERVING_CONTRACT_ROUTES;
