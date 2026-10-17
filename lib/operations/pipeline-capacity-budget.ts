import { z } from "zod";
import { parseModelCapacityPolicy, type ModelCapacityPolicy } from "@/lib/llm/capacity";

/**
 * 처리량 2배 판정의 budget 증거(PR01b-9). 한 구간의 budget은 아래가 모두 증명될 때만 verified다 — 하나라도 모르면 unverified.
 * 1. 귀속 완전성: 시도·사용량 기록에 나타난 구간 안 모델 호출이 모두 장부(모델 슬롯 장부, replay면 계량기)에 있다.
 * 2. 호출당 과금 상한: upstream_reported이고 기존 검사(정수·합 일치·C 이하)를 통과한 실제 사용량, 아니면 그 호출의 전체 C.
 *    C도 없으면 unverified다. 추정치로 C보다 낮게 세지 않는다.
 * 3. 동시 예산 준수: 구간 동안 선언된 공통 슬롯 한도를 넘은 순간이 없다.
 * 비교는 둘 다 verified일 때만 한다. 고유 최종당 호출 수·과금 토큰이 각각 기준선 이하(허용 오차 0)이고 선언 한도가 기준선 이하면 통과다.
 */
export const BUDGET_ISSUES = ["budget_evidence_absent", "model_capacity_absent", "model_capacity_unreadable", "model_capacity_not_open",
  "model_capacity_changed_since_window_start", "capacity_policy_invalid", "capacity_policy_changed", "ledger_row_limit", "ledger_inconsistent",
  "unattributed_ai1_calls", "ai2_call_records_unverified", "unattributed_ai2_calls", "token_bound_missing", "concurrency_limit_exceeded",
  "concurrency_limit_undeclared", "usage_unreported_without_bound", "recorded_calls_exceed_meter", "meter_calls_outside_ledger",
  "replay_budget_unrecorded", "replay_calls_after_stop"] as const;
export type BudgetIssue = typeof BUDGET_ISSUES[number];
const integer = z.number().int().nonnegative().safe();
const source = z.enum(["model_capacity_ledger", "replay_meter"]);
/** 첫 모양은 PR01b-9 이전 artifact(이유 없는 미검증)다. 검증됨은 수치를 모두 실어야 하고 이유 목록은 비지 않는다. */
export const budgetEvidenceSchema = z.union([
  z.object({ status: z.literal("unverified") }).strict(),
  z.object({ status: z.literal("unverified"), source, issues: z.array(z.enum(BUDGET_ISSUES)).min(1).max(BUDGET_ISSUES.length) }).strict(),
  z.object({ status: z.literal("verified"), source, calls: integer, chargedTokens: integer, reportedCalls: integer, boundCalls: integer,
    concurrency: z.object({ limit: integer.positive(), peak: integer }).strict() }).strict(),
]);
export type BudgetEvidence = z.infer<typeof budgetEvidenceSchema>;
export type BudgetSource = z.infer<typeof source>;

export function budgetEvidenceConsistent(value: BudgetEvidence): boolean {
  if (value.status === "unverified") return !("issues" in value) || new Set(value.issues).size === value.issues.length;
  return value.reportedCalls + value.boundCalls === value.calls && value.concurrency.peak <= value.concurrency.limit;
}
function unverified(from: BudgetSource, issues: readonly BudgetIssue[]): BudgetEvidence {
  return { status: "unverified", source: from, issues: BUDGET_ISSUES.filter(issue => issues.includes(issue)) };
}
const safeCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** native terminal 검사와 같다: 정수 셋, 입력+출력=합, 합 ≤ C. 하나라도 어긋나면 실제값으로 인정하지 않는다(C로 센다). */
function reportedTotal(usage: unknown, bound: number): number | null {
  if (!usage || typeof usage !== "object") return null;
  const { inputTokens, outputTokens, totalTokens } = usage as Record<string, unknown>;
  return safeCount(inputTokens) && safeCount(outputTokens) && safeCount(totalTokens) && Number.isSafeInteger(inputTokens + outputTokens)
    && inputTokens + outputTokens === totalTokens && totalTokens <= bound ? totalTokens : null;
}

/** 장부 사건 하나. current: 이 요청이 지금 정책 세대(epoch·revision·hash)에서 왔다. */
export type SlotEvent = { id: number; requestId: string; kind: "reserved" | "exit"; inWindow: boolean;
  providerBudgetId: string; groupId: string; pool: string; current: boolean };
/**
 * 구간과 겹친 요청의 점유 시작(reserved)·끝(취소·만료·정산·회수) 사건을 장부 id 순서(control 잠금 직렬 순서)로 다시 세어
 * 구간 시작 시점과 구간 안 모든 순간의 최대 점유를 차원별로 낸다. 같은 요청의 전이가 어긋나면 null이다.
 */
export function slotPeaks(events: readonly SlotEvent[]): Record<string, number> | null {
  const counts = new Map<string, number>(), peaks: Record<string, number> = {}, seen = new Map<string, SlotEvent["kind"]>();
  const record = () => { for (const [key, count] of counts) peaks[key] = Math.max(peaks[key] ?? 0, count); };
  let opened = false;
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (event.inWindow && !opened) { opened = true; record(); }
    const previous = seen.get(event.requestId);
    if (event.kind === "reserved" ? previous !== undefined : previous !== "reserved") return null;
    seen.set(event.requestId, event.kind);
    for (const key of ["global", `provider:${event.providerBudgetId}`, `group:${event.groupId}`, `pool:${event.pool}`])
      counts.set(key, (counts.get(key) ?? 0) + (event.kind === "reserved" ? 1 : -1));
    if (opened) record();
  }
  // 구간 안 사건이 없으면 시작 시점의 점유가 구간 내내 그대로다.
  record();
  return peaks;
}
function withinPolicy(peaks: Record<string, number>, policy: ModelCapacityPolicy): boolean {
  const limits: Record<string, Readonly<Record<string, number>>> = { provider: policy.providerLimits, group: policy.groupLimits, pool: policy.poolLimits };
  return Object.entries(peaks).every(([key, peak]) => {
    if (key === "global") return peak <= policy.globalLimit;
    const [kind, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    return Object.hasOwn(limits[kind] ?? {}, name) && peak <= limits[kind][name];
  });
}

/** 0097 ai2_attempt 기록 하나. failures는 그 표의 지금 실패 수(행이 없으면 null)다. */
export type Ai2Record = { id: number; secondReviewId: number; failed: boolean; inWindow: boolean; failures: number | null };
/**
 * 구간 안 AI2 호출 기록마다 같은 표·같은 실패 수로 묶인 장부 dispatch가 있는지 센다. 실패 기록은 같은 TX에서 실패 수를 1 올리므로
 * 그 기록 직전 실패 수 = 지금 실패 수 − (그 기록부터 뒤의 실패 기록 수)다. 맞출 수 없으면(행 없음·음수) 장부 밖으로 센다.
 */
export function unattributedAi2Calls(records: readonly Ai2Record[], dispatched: readonly { secondReviewId: number; failureCount: number }[]): number {
  const ledger = new Set(dispatched.map(row => `${row.secondReviewId}:${row.failureCount}`)), byReview = new Map<number, Ai2Record[]>();
  for (const row of records) byReview.set(row.secondReviewId, [...byReview.get(row.secondReviewId) ?? [], row]);
  let missing = 0;
  for (const [id, rows] of byReview) {
    let failedFromHere = 0;
    for (const row of rows.sort((a, b) => b.id - a.id)) {
      failedFromHere += Number(row.failed);
      const before = row.failures === null ? -1 : row.failures - failedFromHere;
      if (row.inWindow && (before < 0 || !ledger.has(`${id}:${before}`))) missing++;
    }
  }
  return missing;
}

export type LedgerCall = { bound: unknown; usage: unknown };
/** 수집기가 읽은 원 행. null은 행 한도 초과(calls·slots)거나 0097 장부가 구간을 덮지 않음(ai2)이다. */
export type LedgerBudgetInput = {
  capacity: { state: "absent" | "unreadable" | "present"; mode: string; changedSinceStart: boolean; policy: unknown };
  calls: LedgerCall[] | null; unattributedAi1: number;
  ai2: { records: Ai2Record[]; dispatched: { secondReviewId: number; failureCount: number }[] } | null;
  slots: SlotEvent[] | null;
};
/** 운영 구간·item replay: 모델 슬롯 장부만으로 세 조건을 증명한다. 비교 한도는 심사 풀이 넘을 수 없는 min(전체, reviewer)이다. */
export function ledgerBudgetEvidence(input: LedgerBudgetInput): BudgetEvidence {
  const { capacity } = input, issues: BudgetIssue[] = [];
  if (capacity.state !== "present") return unverified("model_capacity_ledger", [`model_capacity_${capacity.state}`]);
  // 열린 모드가 아니면 호출이 장부를 거치지 않는다. 구간 중 바뀌었는지는 control 갱신 시각으로만 안다(보수적).
  if (capacity.mode !== "open") return unverified("model_capacity_ledger", ["model_capacity_not_open"]);
  if (capacity.changedSinceStart) issues.push("model_capacity_changed_since_window_start");
  let policy: ModelCapacityPolicy | null = null;
  try { policy = parseModelCapacityPolicy(capacity.policy); } catch { issues.push("capacity_policy_invalid"); }
  let charged = 0, reported = 0, bounded = 0;
  if (!input.calls) issues.push("ledger_row_limit");
  else for (const call of input.calls) {
    if (!safeCount(call.bound) || call.bound < 1) { issues.push("token_bound_missing"); continue; }
    const actual = reportedTotal(call.usage, call.bound);
    if (actual === null) bounded++; else reported++;
    charged += actual ?? call.bound;
  }
  if (!Number.isSafeInteger(charged)) issues.push("ledger_inconsistent");
  if (input.unattributedAi1) issues.push("unattributed_ai1_calls");
  if (!input.ai2) issues.push("ai2_call_records_unverified");
  else if (unattributedAi2Calls(input.ai2.records, input.ai2.dispatched)) issues.push("unattributed_ai2_calls");
  let peak = 0;
  const peaks = input.slots && slotPeaks(input.slots);
  if (!input.slots) issues.push("ledger_row_limit");
  else if (!peaks) issues.push("ledger_inconsistent");
  else {
    // 구간 안에서 새로 잡힌 슬롯은 모두 지금 정책 세대여야 한다(구간 중 정책이 바뀌면 그 사이 한도를 모른다).
    if (input.slots.some(event => event.kind === "reserved" && event.inWindow && !event.current)) issues.push("capacity_policy_changed");
    if (policy && !withinPolicy(peaks, policy)) issues.push("concurrency_limit_exceeded");
    peak = peaks["pool:reviewer"] ?? 0;
  }
  if (issues.length || !policy || !input.calls) return unverified("model_capacity_ledger", issues);
  return { status: "verified", source: "model_capacity_ledger", calls: input.calls.length, chargedTokens: charged, reportedCalls: reported,
    boundCalls: bounded, concurrency: { limit: Math.min(policy.globalLimit, policy.poolLimits.reviewer), peak } };
}

/**
 * legacy 고정 입력 replay: 장부가 없으므로 계량기(모든 모델 egress가 지나는 유일한 길)를 호출 장부로 쓴다.
 * 계량기는 호출별 C를 모른다 — 모든 호출이 upstream_reported usage를 받아야만 2를 증명한다. 동시 한도는 manifest가 선언한 값이다.
 * recordedCalls는 DB 시도·사용량 기록이 센 구간 호출 수로, 계량기 호출 수를 넘으면 계량기 밖 호출이 있었다는 뜻이다.
 */
export function meterBudgetEvidence(input: { calls: number; maxInFlight: number; reportedCalls: number | undefined; reportedTokens: number | undefined;
  declared: number | null; callsAtStop: number | null; recordedCalls: number }): BudgetEvidence {
  const issues: BudgetIssue[] = [];
  if (input.callsAtStop === null || input.reportedCalls === undefined || input.reportedTokens === undefined) issues.push("replay_budget_unrecorded");
  if (input.callsAtStop !== null && input.callsAtStop !== input.calls) issues.push("replay_calls_after_stop");
  if (input.declared === null) issues.push("concurrency_limit_undeclared");
  else if (input.maxInFlight > input.declared) issues.push("concurrency_limit_exceeded");
  if (input.reportedCalls !== undefined && input.reportedCalls !== input.calls) issues.push("usage_unreported_without_bound");
  if (input.recordedCalls > input.calls) issues.push("recorded_calls_exceed_meter");
  if (issues.length || input.declared === null || input.reportedTokens === undefined) return unverified("replay_meter", issues);
  return { status: "verified", source: "replay_meter", calls: input.calls, chargedTokens: input.reportedTokens, reportedCalls: input.calls,
    boundCalls: 0, concurrency: { limit: input.declared, peak: input.maxInFlight } };
}

/** item replay: 장부 증거를 그대로 쓰되 계량기와 맞춘다. 계량기 호출이 장부 호출보다 많거나 구간 정지 뒤 호출이 있으면 미검증이다. */
export function replayLedgerBudget(ledger: BudgetEvidence, meter: { calls: number; maxInFlight: number }, callsAtStop: number | null): BudgetEvidence {
  const issues: BudgetIssue[] = ledger.status === "verified" ? [] : "issues" in ledger ? [...ledger.issues] : ["budget_evidence_absent"];
  if (callsAtStop === null) issues.push("replay_budget_unrecorded");
  else if (callsAtStop !== meter.calls) issues.push("replay_calls_after_stop");
  if (ledger.status === "verified") {
    if (meter.calls > ledger.calls) issues.push("meter_calls_outside_ledger");
    if (meter.maxInFlight > ledger.concurrency.limit) issues.push("concurrency_limit_exceeded");
  }
  return issues.length ? unverified("model_capacity_ledger", issues) : ledger;
}

type Check = "passed" | "failed" | "incomplete";
function side({ budget, finals }: { budget: BudgetEvidence; finals: number }) {
  return budget.status === "verified" ? { calls: budget.calls, chargedTokens: budget.chargedTokens, finals, limit: budget.concurrency.limit,
    callsPerFinal: finals ? budget.calls / finals : null, tokensPerFinal: finals ? budget.chargedTokens / finals : null } : null;
}
const ratio = (after: number | null | undefined, before: number | null | undefined) =>
  after === null || after === undefined || !before ? null : after / before;
/**
 * 비교 조건이 같고(comparable) 양쪽 증거가 verified일 때만 판정한다. 경계는 BigInt 교차곱으로 정확히 잰다(토큰 곱은 2^53을 넘을 수 있다).
 * 비율은 통과 여부와 상관없이 남긴다.
 */
export function judgeBudget(baseline: { budget: BudgetEvidence; finals: number }, candidate: { budget: BudgetEvidence; finals: number },
  comparable: boolean) {
  const before = side(baseline), after = side(candidate), reasons: string[] = [];
  const ratios = { callsPerFinal: ratio(after?.callsPerFinal, before?.callsPerFinal), tokensPerFinal: ratio(after?.tokensPerFinal, before?.tokensPerFinal) };
  const result = (status: Check) => ({ status, reasons, ratios, baseline: before, candidate: after });
  if (!before || !after) { reasons.push("budget_evidence_unverified"); return result("incomplete"); }
  if (!before.finals || !after.finals) { reasons.push("budget_per_final_unavailable"); return result("incomplete"); }
  const within = (a: number, b: number) => BigInt(a) * BigInt(before.finals) <= BigInt(b) * BigInt(after.finals);
  if (!within(after.calls, before.calls)) reasons.push("budget_calls_per_final_exceeded");
  if (!within(after.chargedTokens, before.chargedTokens)) reasons.push("budget_tokens_per_final_exceeded");
  if (after.limit > before.limit) reasons.push("budget_limit_exceeds_baseline");
  return result(!comparable ? "incomplete" : reasons.length ? "failed" : "passed");
}
