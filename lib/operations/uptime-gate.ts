import { assessUptimeObservation, UptimeSourcesSchema, UPTIME_EVIDENCE_MS, UPTIME_SLOT_MS, uptimeSlot,
  type UptimeDisposition, type UptimeObservation, type UptimeSource } from "@/lib/domain/products/uptime-policy";

/**
 * uptime raw→gate 2단계 전환 판정(PR09b). DB·네트워크 없이 스냅숏만 본다.
 * 근거가 없거나 모자라면 전환을 거절한다. 아래 수치는 운영 관측 전의 보수적 출발값이다.
 */

/** raw canary가 현재 revision으로 이어진 최소 기간 — UTC 6h slot 4개(로드맵의 24h 실제 업무 관측). */
export const UPTIME_GATE_MIN_CANARY_MS = 4 * UPTIME_SLOT_MS;
/** 마지막 관측이 정책 증거 창보다 오래되면 gate 첫 판정부터 증거가 없다. */
export const UPTIME_GATE_FRESH_MS = UPTIME_EVIDENCE_MS;
/** 독립 지역 확증(regional-v1)이 성립할 수 있는 최소 지역 수. */
export const UPTIME_GATE_MIN_REGIONS = 2;
/** shadow 판정 창·표본 상한·최소 표본. */
export const UPTIME_GATE_SHADOW_MS = UPTIME_SLOT_MS;
export const UPTIME_GATE_SHADOW_LIMIT = 1_000;
export const UPTIME_GATE_MIN_SHADOW_NEGATIVES = 100;
/** gate가 실패 관측의 절반 넘게 hold하면 목록 숨김·자동 내림이 사실상 멈춘다 — 정책을 사람이 다시 정해야 한다. */
export const UPTIME_GATE_MAX_SHADOW_HOLD_RATIO = 0.5;
/** status 조회 창. canary 판정에 필요한 기간의 두 배. */
export const UPTIME_GATE_LOOKBACK_MS = 2 * UPTIME_GATE_MIN_CANARY_MS;
/** observations가 켜지면 sources에 없는 실행자의 uptime-ping은 실패한다. 이 창 안의 역할 후보를 모두 요구한다. */
export const UPTIME_RUNNER_LOOKBACK_MS = 24 * 3_600_000;
export const UPTIME_RUNNER_ROLES = ["maintenance", "product-health"] as const;

export type UptimeMode = "disabled" | "raw-only" | "gate";
export type UptimeGateTarget = "raw-only" | "gate";
type Flags = { observationsEnabled: boolean; gateEnabled: boolean };
export type UptimeControlState = Flags & { revision: number; sources: UptimeSource[] };
export type UptimeHostSummary = { host: string; instanceId: string; region: string; configured: boolean;
  total: number; positive: number; negative: number; dispositions: Record<UptimeDisposition, number>;
  firstObservedAt: string; lastObservedAt: string };
export type UptimeShadowRow = { observationId: string; productId: number; url: string; host: UptimeSource["host"];
  instanceId: string; region: string; kind: UptimeObservation["kind"]; status: number; observedAt: Date;
  disposition: UptimeDisposition; reason: string | null };
export type UptimeShadowResult = { negatives: number; held: number; admitted: number; reasons: Record<string, number>; holdRatio: number | null };
export type UptimeGateSnapshot = {
  now: string; control: UptimeControlState; window: { from: string; to: string };
  /** 현재 revision·조회 창 안의 raw 관측. slots는 UTC 6h slot 시작 시각(ISO). */
  observations: { total: number; firstObservedAt: string | null; lastObservedAt: string | null; slots: string[] };
  hosts: UptimeHostSummary[]; holdReasons: Record<string, number>; runners: string[];
  gates: { admitted: number; held: number; heldReasons: Record<string, number>; due: number; currentRevision: number };
  /** gate를 켜면 인증된 gate 행이 없는 제품은 목록 숨김·내림 대상에서 빠진다. 지금 숨김·10회 이상 수. */
  impact: { hiddenNow: number; banEligibleNow: number };
  shadow: UptimeShadowResult | null;
  /** 응답 점검 제품 단위 분담(0104 uptime_split_control). claims 면 PR09 관측·gate 를 켤 수 없다 */
  split?: { mode: "legacy" | "claims"; epoch: number };
};
export type UptimeTransitionPlan = { target: UptimeGateTarget; from: UptimeMode; allowed: boolean; blocked: string[];
  next: Flags & { sources: UptimeSource[] } };

function fail(code: string): never { throw new Error(code); }

export function uptimeMode(control: Flags): UptimeMode {
  return control.gateEnabled ? "gate" : control.observationsEnabled ? "raw-only" : "disabled";
}

export function sameUptimeSource(a: UptimeSource, b: { host: string; instanceId: string; region: string }): boolean {
  return a.host === b.host && a.instanceId === b.instanceId && a.region === b.region;
}

function canaryBlocks(snapshot: UptimeGateSnapshot): string[] {
  const blocked: string[] = [], now = Date.parse(snapshot.now), { firstObservedAt, lastObservedAt, slots } = snapshot.observations;
  if (!firstObservedAt || !lastObservedAt) blocked.push("uptime_canary_missing");
  else {
    if (now - Date.parse(firstObservedAt) < UPTIME_GATE_MIN_CANARY_MS) blocked.push("uptime_canary_too_short");
    if (now - Date.parse(lastObservedAt) > UPTIME_GATE_FRESH_MS) blocked.push("uptime_observations_stale");
  }
  const current = uptimeSlot(new Date(now)).getTime();
  const required = Array.from({ length: UPTIME_GATE_MIN_CANARY_MS / UPTIME_SLOT_MS }, (_, index) =>
    new Date(current - (index + 1) * UPTIME_SLOT_MS).toISOString());
  if (required.some(slot => !slots.includes(slot))) blocked.push("uptime_canary_slot_gap");
  const regions = new Set(snapshot.hosts.filter(host => host.configured && host.total > 0).map(host => host.region));
  if (regions.size < UPTIME_GATE_MIN_REGIONS) blocked.push("uptime_region_coverage_insufficient");
  const shadow = snapshot.shadow;
  if (!shadow || shadow.negatives < UPTIME_GATE_MIN_SHADOW_NEGATIVES) blocked.push("uptime_shadow_evidence_insufficient");
  else if ((shadow.holdRatio ?? 1) > UPTIME_GATE_MAX_SHADOW_HOLD_RATIO) blocked.push("uptime_shadow_hold_ratio_exceeded");
  return blocked;
}

/** raw-only는 source·실행자 범위만, gate는 현재 revision의 canary 근거까지 요구한다. gate→raw-only는 rollback이다. */
export function planUptimeTransition(target: UptimeGateTarget, snapshot: UptimeGateSnapshot, proposedSources?: unknown): UptimeTransitionPlan {
  const from = uptimeMode(snapshot.control), blocked: string[] = [];
  let sources = snapshot.control.sources;
  if (target === "raw-only") {
    if (from === "gate") blocked.push("uptime_rollback_required");
    const parsed = UptimeSourcesSchema.safeParse(proposedSources ?? snapshot.control.sources);
    if (!parsed.success) blocked.push("uptime_sources_invalid");
    else if (!parsed.data.length) blocked.push("uptime_sources_missing");
    else {
      sources = parsed.data;
      // raw-only에서 Oracle 관측은 raw_only로만 남는다. 권위 health를 이어 쓸 source가 있어야 한다.
      if (!sources.some(source => source.host !== "oracle-osaka-smoke")) blocked.push("uptime_authoritative_source_missing");
      if (from === "raw-only" && sources.length === snapshot.control.sources.length
        && sources.every(source => snapshot.control.sources.some(current => sameUptimeSource(source, current)))) blocked.push("uptime_no_change");
    }
  } else {
    if (proposedSources !== undefined) blocked.push("uptime_gate_sources_frozen");
    if (from !== "raw-only") blocked.push("uptime_gate_requires_raw_only");
    blocked.push(...canaryBlocks(snapshot));
  }
  for (const runner of snapshot.runners) {
    if (!sources.some(source => source.instanceId === runner)) blocked.push(`uptime_runner_unconfigured:${runner}`);
  }
  // split claims 와 함께 켤 수 없다(0104 트리거가 같은 것을 강제한다). 끄는 rollback 은 막지 않는다 — 먼저 `uptime-split mode --to=legacy`
  if (snapshot.split?.mode === "claims") blocked.push("uptime_split_claims_active");
  return { target, from, allowed: blocked.length === 0, blocked,
    next: { observationsEnabled: true, gateEnabled: target === "gate", sources } };
}

/** 안전 방향으로 한 단계만: gate→raw-only, raw-only→disabled. sources는 그대로 둔다(꺼진 상태에선 쓰이지 않는다). */
export function uptimeRollbackTarget(control: Flags): Flags | null {
  if (control.gateEnabled) return { observationsEnabled: true, gateEnabled: false };
  if (control.observationsEnabled) return { observationsEnabled: false, gateEnabled: false };
  return null;
}

function firstIndex(times: number[], test: (time: number) => boolean): number {
  let low = 0, high = times.length;
  while (low < high) { const middle = (low + high) >> 1; if (test(times[middle])) high = middle; else low = middle + 1; }
  return low;
}

/**
 * raw 관측에 regional-v1을 그대로 다시 돌린다. 기록 경로와 같게 stale·미설정 source는 증거에서 빼고,
 * minimum_interval hold는 정책 전 단계라 대상이 아니다. 기록 당시 health 상태는 재현하지 않는 근사다.
 */
export function shadowEvaluateUptimeGate(candidates: readonly UptimeShadowRow[], evidence: readonly UptimeShadowRow[],
  sources: readonly UptimeSource[]): UptimeShadowResult {
  const facts = evidence.filter(row => row.disposition !== "stale" && sources.some(source => sameUptimeSource(source, row)))
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const times = facts.map(row => row.observedAt.getTime());
  let negatives = 0, held = 0;
  const reasons: Record<string, number> = {};
  for (const row of candidates) {
    if ((row.kind === "http" && row.status >= 200 && row.status < 400)
      || !(row.disposition === "applied" || row.disposition === "raw_only"
        || (row.disposition === "observation_hold" && row.reason !== "minimum_interval"))) continue;
    const at = row.observedAt.getTime();
    const near = facts.slice(firstIndex(times, time => time >= at - UPTIME_EVIDENCE_MS), firstIndex(times, time => time > at))
      .filter(fact => fact.observationId !== row.observationId);
    const reason = assessUptimeObservation({ observationId: row.observationId, productId: row.productId, slug: "shadow", url: row.url,
      slot: uptimeSlot(row.observedAt), startedAt: row.observedAt, observedAt: row.observedAt,
      source: { host: row.host, instanceId: row.instanceId, region: row.region }, kind: row.kind, status: row.status, latencyMs: null }, near);
    negatives++;
    if (reason) { held++; reasons[reason] = (reasons[reason] ?? 0) + 1; }
  }
  return { negatives, held, admitted: negatives - held, reasons, holdRatio: negatives ? held / negatives : null };
}

export type UptimeGateCommand =
  | { command: "status" }
  | { command: "plan"; target: UptimeGateTarget; sourcesPath?: string }
  | { command: "apply"; target: UptimeGateTarget; sourcesPath?: string; expectRevision: number; operator: string; apply: boolean }
  | { command: "rollback"; expectRevision: number; operator: string; apply: boolean };

const OPERATOR = /^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,119}$/;

/** --key=value만 받는다. 모르는·중복 옵션과 URL 인자는 거절한다(DB URL은 환경변수로만). */
export function parseUptimeGateArgs(args: readonly string[]): UptimeGateCommand {
  if (args.some(arg => arg.includes("://"))) fail("uptime_gate_url_argument_rejected");
  const [command, ...rest] = args;
  if (command !== "status" && command !== "plan" && command !== "apply" && command !== "rollback") fail("uptime_gate_unknown_command");
  let target: UptimeGateTarget | undefined;
  if (command === "plan" || command === "apply") {
    const value = rest.shift();
    if (value !== "raw-only" && value !== "gate") fail("uptime_gate_unknown_target");
    target = value;
  }
  const allowed = [...(target === "raw-only" ? ["sources"] : []),
    ...(command === "apply" || command === "rollback" ? ["expect-revision", "operator", "apply"] : [])];
  const options = new Map<string, string>();
  for (const arg of rest) {
    const match = /^--([a-z-]+)(?:=([^\n]*))?$/.exec(arg);
    if (!match || !allowed.includes(match[1])) fail("uptime_gate_unknown_option");
    if (match[1] === "apply" ? match[2] !== undefined : !match[2]) fail("uptime_gate_invalid_option");
    if (options.has(match[1])) fail("uptime_gate_duplicate_option");
    options.set(match[1], match[2] ?? "");
  }
  const sourcesPath = options.get("sources");
  const sources = sourcesPath ? { sourcesPath } : {};
  if (command === "status") return { command };
  if (command === "plan") return { command, target: target!, ...sources };
  const revision = options.get("expect-revision") ?? fail("uptime_gate_missing_expect_revision");
  const expectRevision = /^[1-9]\d*$/.test(revision) ? Number(revision) : Number.NaN;
  if (!Number.isSafeInteger(expectRevision)) fail("uptime_gate_invalid_expect_revision");
  const operator = options.get("operator") ?? fail("uptime_gate_missing_operator");
  if (!OPERATOR.test(operator)) fail("uptime_gate_invalid_operator");
  const apply = options.has("apply");
  if (command === "rollback") return { command, expectRevision, operator, apply };
  return { command, target: target!, ...sources, expectRevision, operator, apply };
}

const OVERRIDES = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"] as const;
/** 앱 기본 DATABASE_URL로 대체하지 않는다. libpq 우회 변수가 하나라도 있으면 드라이버를 열기 전에 거절한다. */
export function uptimeGateDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.UPTIME_GATE_DATABASE_URL;
  if (!url) fail("explicit_UPTIME_GATE_DATABASE_URL_required");
  if (OVERRIDES.some(key => Boolean(env[key]))) fail("database_override_rejected");
  return url;
}

/** 고정 code만 출력한다. URL·SQL·stack은 쓰지 않는다. */
export function formatUptimeGateError(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_:.-]{2,120}$/.test(error.message) ? error.message : "uptime_gate_failed";
}
