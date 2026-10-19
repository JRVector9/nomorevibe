import { z } from "zod";
import { UptimeHostSchema } from "@/lib/domain/products/uptime-policy";
import { UPTIME_BREAKER_STATES, UPTIME_BROAD_FAILURE_MIN_CHECKS, UPTIME_BROAD_FAILURE_RATIO, UPTIME_SPLIT_MODES, UptimeSplitPolicySchema,
  uptimeSplitPolicyHash, type UptimeSplitMode, type UptimeSplitPolicy } from "@/lib/domain/products/uptime-split-policy";
import type { ProgressStageInput } from "./worker-progress";

/**
 * 응답 점검 제품 단위 분담(split-v1, 0103 uptime_split_control) 운영 제어의 순수 부분 — 인자, 판정(dry-run 계획), 읽기 모양, 출력.
 * DB·파일·네트워크 없음. 실행 때 잠근 행으로 같은 계획을 다시 세운다(uptime-split-repository.ts). 절차는 docs/runbooks/uptime-split.md.
 */

/**
 * 차단기 창 규칙이 Oracle 1,000건/시간(10분 약 167건)에서도 닿을 수 있는 상한(U1a 권고). 200 이면 창 규칙이 영영 열리지 않아
 * Oracle 광역 장애가 재확인 요청으로만 이어진다.
 */
export const UPTIME_SPLIT_MAX_MIN_CHECKS = 100;
/**
 * probe(Oracle) maxPerHour 합계 상한. 제출분은 home 잡의 적용기가 틱(1분)마다 UPTIME_APPLY_SUBMITTED_MAX(100)건만 반영하므로
 * 시간당 최대 6,000건이다. 그보다 빨리 제출하면 submitted 가 쌓이고 그 행은 다시 claim 될 수 없어 적용 지연만 커진다(review F10).
 * 틱이 가끔 늦거나 건너뛰는 것(실측 시간당 약 58.5틱)을 빼고 5,000 으로 둔다. 운영 계획의 최종 3,500/h 는 그 안이다.
 */
export const UPTIME_SPLIT_MAX_PROBE_PER_HOUR = 5_000;

const OPERATOR = /^[a-zA-Z0-9][a-zA-Z0-9._@:-]{0,119}$/;
const FLAGS = new Set(["execute", "json"]);
const SPECS = {
  policy: ["file", "expect-epoch", "expect-policy-hash"],
  mode: ["to", "from-mode", "expect-epoch"],
} as const;

export type UptimeSplitCommand =
  | { name: "status"; json: boolean }
  | { name: "policy"; file: string; expectEpoch: number; expectPolicyHash: string | null; operator: string; reason: string; execute: boolean; json: boolean }
  | { name: "mode"; to: UptimeSplitMode; fromMode: UptimeSplitMode; expectEpoch: number; operator: string; reason: string; execute: boolean; json: boolean };
export type UptimeSplitTransition = Exclude<UptimeSplitCommand, { name: "status" }>;

function fail(code: string): never { throw new Error(code); }

/** --key=value와 값 없는 flag만 받는다. 모르는·중복 옵션과 URL 인자는 거절한다(DB URL은 환경변수로만). */
export function parseUptimeSplitArgs(args: readonly string[]): UptimeSplitCommand {
  if (args.some(arg => arg.includes("://"))) fail("uptime_split_url_argument_rejected");
  const [name, ...rest] = args;
  if (name !== "status" && name !== "policy" && name !== "mode") fail("uptime_split_unknown_command");
  const required: readonly string[] = name === "status" ? [] : [...SPECS[name], "operator", "reason"];
  const allowed = new Set([...required, "json", ...(name === "status" ? [] : ["execute"])]);
  const values = new Map<string, string>(), flags = new Set<string>();
  for (const arg of rest) {
    const match = /^--([a-z-]+)(?:=([^\n]*))?$/.exec(arg);
    if (!match || !allowed.has(match[1])) fail("uptime_split_unknown_option");
    const [, key, value] = match;
    if (FLAGS.has(key) ? value !== undefined : !value) fail("uptime_split_invalid_option");
    if (values.has(key) || flags.has(key)) fail("uptime_split_duplicate_option");
    if (FLAGS.has(key)) flags.add(key); else values.set(key, value);
  }
  const json = flags.has("json");
  if (name === "status") return { name, json };
  for (const key of required) if (!values.has(key)) fail(`uptime_split_missing_${key.replace(/-/g, "_")}`);
  const epoch = values.get("expect-epoch")!;
  const expectEpoch = /^[1-9]\d*$/.test(epoch) ? Number(epoch) : Number.NaN;
  if (!Number.isSafeInteger(expectEpoch)) fail("uptime_split_invalid_expect_epoch");
  const operator = values.get("operator")!;
  if (!OPERATOR.test(operator)) fail("uptime_split_invalid_operator");
  const reason = values.get("reason")!;
  if (reason.length > 300 || reason !== reason.trim() || /[\u0000-\u001f\u007f]/.test(reason)) fail("uptime_split_invalid_reason");
  const common = { expectEpoch, operator, reason, execute: flags.has("execute"), json };
  if (name === "policy") {
    const hash = values.get("expect-policy-hash")!;
    if (hash !== "none" && !/^[a-f0-9]{64}$/.test(hash)) fail("uptime_split_invalid_expect_policy_hash");
    return { name, file: values.get("file")!, expectPolicyHash: hash === "none" ? null : hash, ...common };
  }
  const mode = (key: string) => {
    const value = values.get(key)!;
    return (UPTIME_SPLIT_MODES as readonly string[]).includes(value) ? value as UptimeSplitMode : fail(`uptime_split_invalid_${key.replace(/-/g, "_")}`);
  };
  return { name, to: mode("to"), fromMode: mode("from-mode"), ...common };
}

const OVERRIDES = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"] as const;
/** 앱 기본 DATABASE_URL로 대체하지 않는다. libpq 우회 변수가 하나라도 있으면 드라이버를 열기 전에 거절한다. */
export function uptimeSplitDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.UPTIME_SPLIT_DATABASE_URL;
  if (!url) fail("explicit_UPTIME_SPLIT_DATABASE_URL_required");
  if (OVERRIDES.some(key => Boolean(env[key]))) fail("database_override_rejected");
  return url;
}

/** 고정 code만 출력한다. URL·SQL·stack은 쓰지 않는다. */
export function formatUptimeSplitError(error: unknown): string {
  return error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_:.-]{2,120}$/.test(error.message) ? error.message : "uptime_split_failed";
}

// ---- 읽기 모양(한 문장·한 DB 시계, uptime-split-repository.ts) ----

const count = z.number().int().nonnegative().safe();
const minutes = z.number().nullable().transform(value => value === null ? null : Math.max(0, value));
const instant = z.string().nullable();
/** 운영 상태·배포 관문·제어 CLI 가 같이 읽는 split 장부. 시각은 DB 시계다 */
export const uptimeSplitReadbackSchema = z.object({
  at: z.string(),
  control: z.object({ mode: z.enum(UPTIME_SPLIT_MODES), epoch: z.number().int().positive().safe(), policy: z.unknown(),
    policyHash: z.string().nullable() }).strict(),
  uptimeControl: z.object({ observationsEnabled: z.boolean(), gateEnabled: z.boolean() }).strict(),
  queue: z.object({
    /** home claim 이 지금 가져갈 수 있는 수(공개 website 제품, 재확인 간격·due 가 지남, 진행 중이 아님)와 그중 가장 오래 기다린 분 */
    due: count, dueOldestMinutes: minutes,
    /** 살아 있는 claim(확인 중) */
    claimed: count,
    /** 제출됐지만 아직 반영 안 된 결과(Oracle 등)와 가장 오래된 분 */
    submitted: count, submittedOldestMinutes: minutes,
    /** home 재확인 요청과 가장 오래된 분 */
    confirm: count, confirmOldestMinutes: minutes,
    /** 최근 5분 정식 반영 수 */
    applied5m: count,
    /** claim 행이 아직 없는 공개 website 제품(잡이 틱마다 2,000건씩 만든다) */
    missingRows: count,
  }).strict(),
  breakers: z.array(z.object({ host: UptimeHostSchema, state: z.enum(UPTIME_BREAKER_STATES), reason: z.string().nullable(),
    ratio: z.number().nullable(), openedAt: instant, probeAfter: instant, probeChecks: count, probeFailures: count }).strict()),
  /** 최근 1시간 claim 행의 마지막 판정 사유별 수(보류·되돌림·재확인 등) */
  outcomes1h: z.record(z.string(), count),
  /** 최근 1시간 host 별 정식 반영 수 */
  applied1h: z.record(z.string(), count),
  /**
   * maintenance 역할 임대의 주인(SERVICE_INSTANCE_ID) — 지금 home 확인을 맡은 instance 다. 오래 열림 경보는 이 instance 의 host 차단기만 본다
   * (역할이 다른 home 으로 넘어가면 옛 host 차단기는 시험할 사람이 없어 열린 채 남는다). 없으면(옛 모양) 오래 열림 경보를 내지 않는다
   */
  maintenanceOwner: z.string().nullable().optional(),
}).strict();
export type UptimeSplitReadback = z.infer<typeof uptimeSplitReadbackSchema>;

/** 제어 CLI 의 스냅숏: 장부 + 전환 판정에 필요한 것 */
export const uptimeSplitSnapshotSchema = z.object({
  readback: uptimeSplitReadbackSchema,
  fence: z.enum(["active", "fenced"]),
  batchMode: z.string(),
  /** 최근 24시간 maintenance 후보 instance — claims 에서는 policy 에 home 으로 있어야 확인한다 */
  runners: z.array(z.string()),
}).strict();
export type UptimeSplitSnapshot = z.infer<typeof uptimeSplitSnapshotSchema>;

/** 저장된 policy 검증 — hash 가 맞을 때만 쓴다 */
export function storedUptimeSplitPolicy(control: UptimeSplitReadback["control"]): { state: "verified"; policy: UptimeSplitPolicy } | { state: "unset" | "invalid" } {
  if (control.policy === null && control.policyHash === null) return { state: "unset" };
  const parsed = UptimeSplitPolicySchema.safeParse(control.policy);
  return parsed.success && uptimeSplitPolicyHash(parsed.data) === control.policyHash ? { state: "verified", policy: parsed.data } : { state: "invalid" };
}

/**
 * home 차단기가 이만큼 넘게 열린 채(open·probing)면 의도한 대기가 아니라 경보다. cool-down 은 10·20·40·60분으로 늘어나므로
 * 한 번 열려 시험이 한두 번 실패한 정도는 넘고, 시험이 계속 실패하는 장애(또는 표본 문제)는 잡는다.
 */
export const UPTIME_SPLIT_BREAKER_ALARM_MINUTES = 60;

/** 지금 확인을 맡은 home host(maintenance 역할 임대 주인의 policy host)의 차단기가 오래 열려 있으면 그 host 와 열린 분 수 */
export function stuckHomeBreaker(readback: UptimeSplitReadback): { host: string; minutes: number } | null {
  const stored = storedUptimeSplitPolicy(readback.control);
  if (readback.control.mode !== "claims" || stored.state !== "verified" || !readback.maintenanceOwner) return null;
  const entry = stored.policy.hosts.find(host => host.instanceId === readback.maintenanceOwner && host.class === "home");
  const row = entry ? readback.breakers.find(breaker => breaker.host === entry.host) : undefined;
  if (!row || row.state === "closed" || row.openedAt === null) return null;
  const minutes = (Date.parse(readback.at) - Date.parse(row.openedAt)) / 60_000;
  return minutes >= UPTIME_SPLIT_BREAKER_ALARM_MINUTES ? { host: row.host, minutes } : null;
}

/** 차단기가 열려 쉬는 중인 home host(probe_after 전). 잡은 이 host 로 확인하지 않는다 — 멈춤이 아니라 의도한 대기다(오래 열림은 빼고) */
export function heldHomeHosts(readback: UptimeSplitReadback): string[] {
  const stored = storedUptimeSplitPolicy(readback.control);
  if (readback.control.mode !== "claims" || stored.state !== "verified") return [];
  const home = new Set(stored.policy.hosts.filter(entry => entry.class === "home").map(entry => entry.host));
  const at = Date.parse(readback.at), stuck = stuckHomeBreaker(readback)?.host;
  return readback.breakers.filter(row => home.has(row.host) && row.host !== stuck && row.state === "open" && row.probeAfter !== null
    && Date.parse(row.probeAfter) > at).map(row => row.host);
}

/**
 * claims 모드의 응답 점검 진행(worker progress 의 uptime 단계). legacy 면 null — 지금 관문·감시가 보는 것은 바뀌지 않는다.
 * 대기 = 가져갈 수 있는 due + 반영 안 된 제출, 최장 = 그 둘 중 오래된 것, 진행 = 최근 5분 정식 반영.
 * home 차단기가 열려 쉬는 중이면 held(재시작으로 고칠 수 없는 의도한 대기)다.
 * 확인을 맡은 home 의 차단기가 오래 열려 있으면(stuckHomeBreaker) 의도한 대기가 아니다 — 그 host 의 실패를 세지 못하고 home 전용 제품
 * (재확인 요청·실패 중·home 고정)을 보지 못한다. Oracle 성공 반영이 진행을 채워도 감춰지지 않게 진행을 0 으로 보고 경보(upstream_stalled,
 * 재시작 대상 아님)로 낸다 — 재시작은 host 네트워크를 고치지 못하고, 다시 선출된 같은 host 가 시험하기 전에 또 재시작하는 고리만 만든다.
 */
export function uptimeSplitStageInput(readback: UptimeSplitReadback): ProgressStageInput | null {
  if (readback.control.mode !== "claims") return null;
  const q = readback.queue, waiting = q.due + q.submitted;
  const ages = [q.due > 0 ? q.dueOldestMinutes : null, q.submitted > 0 ? q.submittedOldestMinutes : null].filter((value): value is number => value !== null);
  const stage: ProgressStageInput = { key: "uptime", enabled: true, waiting, oldestMinutes: waiting > 0 && ages.length ? Math.max(...ages) : null,
    completed5m: q.applied5m, progress5m: q.applied5m, errors5m: null, held: heldHomeHosts(readback).length > 0 };
  const stuck = stuckHomeBreaker(readback);
  return stuck ? { ...stage, progress5m: 0, held: false, providerErrors: 1, providerErrorMinutes: stuck.minutes } : stage;
}

const BREAKER_WORDS: Record<string, string> = { closed: "닫힘", open: "열림", probing: "시험 중" };
const clock = (iso: string | null) => iso ? iso.slice(11, 16) : "-";
/** 운영 화면·CLI 한 줄 — host 별 차단기와 최근 1시간 판정 사유. 확인을 맡은 home 이 오래 열려 있으면 앞에 경보를 붙인다 */
export function uptimeSplitNote(readback: UptimeSplitReadback): string {
  const breakers = readback.breakers.length ? readback.breakers.map(row => `${row.host} ${BREAKER_WORDS[row.state] ?? row.state}`
    + (row.state === "closed" ? "" : `(${row.reason ?? "-"}${row.ratio === null ? "" : ` ${row.ratio.toFixed(2)}`}`
      + `${row.state === "open" ? `, 시험 ${clock(row.probeAfter)} UTC` : `, 받은 ${row.probeChecks}·실패 ${row.probeFailures}`})`)).join(" · ")
    : "모두 닫힘";
  const reasons = Object.entries(readback.outcomes1h).sort(([, a], [, b]) => b - a).slice(0, 6).map(([reason, n]) => `${reason} ${n}`).join(" · ");
  const stuck = stuckHomeBreaker(readback);
  const alarm = stuck ? `경보: 확인을 맡은 ${stuck.host} 차단기가 ${Math.round(stuck.minutes)}분째 열려 있음 | ` : "";
  return `${alarm}차단기: ${breakers} | 최근 1시간 판정: ${reasons || "없음"}`;
}

// ---- 판정 ----

export type UptimeSplitPlan = { command: UptimeSplitTransition["name"]; target: "uptime_split_control"; change: string;
  blocked: string[]; warnings: string[];
  /** 실행하면 쓸 값(blocked 가 비어 있을 때만 의미가 있다) */
  next: { mode: UptimeSplitMode; policy: UptimeSplitPolicy | null; policyHash: string | null } };

/** 정책 값 검사 — 스키마 밖의 운영 규칙(U1a·U0 와 맞춘 값) */
function policyRules(policy: UptimeSplitPolicy, blocked: string[]) {
  if (policy.breaker.minChecks > UPTIME_SPLIT_MAX_MIN_CHECKS) blocked.push(`policy_min_checks_above:${UPTIME_SPLIT_MAX_MIN_CHECKS}`);
  const probeRate = policy.hosts.filter(entry => entry.class === "probe").reduce((sum, entry) => sum + (entry.maxPerHour ?? 0), 0);
  if (probeRate > UPTIME_SPLIT_MAX_PROBE_PER_HOUR) blocked.push(`policy_probe_rate_above:${UPTIME_SPLIT_MAX_PROBE_PER_HOUR}`);
  // home 광역 보류는 legacy 틱 보류(PR-0b)와 같은 기준이어야 한다 — 전환이 보호 강도를 바꾸지 않게
  if (policy.breaker.batchMin !== UPTIME_BROAD_FAILURE_MIN_CHECKS || policy.breaker.batchOpenRatio !== UPTIME_BROAD_FAILURE_RATIO) {
    blocked.push(`policy_batch_rule_differs_from_legacy:${UPTIME_BROAD_FAILURE_MIN_CHECKS}/${UPTIME_BROAD_FAILURE_RATIO}`);
  }
}

/** claims 에서 확인할 instance: 최근 maintenance 후보가 모두 policy 에 home 으로 있어야 한다(없으면 그 후보가 역할을 쥐는 동안 확인이 멈춘다) */
function runnerRules(snapshot: UptimeSplitSnapshot, policy: UptimeSplitPolicy, sink: string[], warnings: string[]) {
  if (!snapshot.runners.length) warnings.push("uptime_runner_unobserved");
  for (const runner of snapshot.runners) {
    const entry = policy.hosts.find(host => host.instanceId === runner);
    if (!entry || entry.class !== "home") sink.push(`uptime_runner_unconfigured:${runner}`);
  }
}

/** dry-run과 실행이 같이 쓰는 판정. 기대 상태 불일치·전환 규칙 위반은 blocked, 진행은 되지만 알아야 할 것은 warnings. */
export function planUptimeSplit(command: UptimeSplitTransition, snapshot: UptimeSplitSnapshot, policyFile?: unknown): UptimeSplitPlan {
  const { readback } = snapshot, control = readback.control, blocked: string[] = [], warnings: string[] = [];
  const expect = (field: string, expected: unknown, actual: unknown) => {
    if (expected !== actual) blocked.push(`expect_${field}_mismatch:${actual ?? "none"}`);
  };
  if (snapshot.fence !== "active") blocked.push("site_fenced");
  expect("epoch", command.expectEpoch, control.epoch);
  const stored = storedUptimeSplitPolicy(control);
  const pr09 = readback.uptimeControl.observationsEnabled || readback.uptimeControl.gateEnabled;
  const plan = (change: string, next: UptimeSplitPlan["next"]): UptimeSplitPlan =>
    ({ command: command.name, target: "uptime_split_control", change, blocked, warnings, next });

  if (command.name === "policy") {
    expect("policy_hash", command.expectPolicyHash, control.policyHash);
    const parsed = UptimeSplitPolicySchema.safeParse(policyFile);
    if (!parsed.success) {
      blocked.push(`policy_invalid:${parsed.error.issues[0]?.path.join(".") || parsed.error.issues[0]?.message || "root"}`);
      return plan("policy ?", { mode: control.mode, policy: null, policyHash: null });
    }
    const hash = uptimeSplitPolicyHash(parsed.data);
    if (hash === control.policyHash) blocked.push("policy_unchanged");
    policyRules(parsed.data, blocked);
    if (control.mode === "claims") {
      // 지금 확인 중인 home 이 policy 에서 빠지면 그 틱부터 확인이 멈춘다. claims 에서 policy 를 바꾸면 PR09 와 겹칠 수 없다(트리거와 같다)
      runnerRules(snapshot, parsed.data, blocked, warnings);
      if (pr09) blocked.push("uptime_control_enabled");
      warnings.push("in_flight_claims_discarded");
    } else runnerRules(snapshot, parsed.data, warnings, warnings);
    return plan(`policy ${control.policyHash?.slice(0, 12) ?? "unset"} → ${hash.slice(0, 12)}, epoch ${control.epoch} → ${control.epoch + 1}`,
      { mode: control.mode, policy: parsed.data, policyHash: hash });
  }

  expect("mode", command.fromMode, control.mode);
  if (command.to === command.fromMode) blocked.push("uptime_split_transition_invalid");
  if (command.to === "claims") {
    if (stored.state !== "verified") blocked.push(stored.state === "unset" ? "uptime_split_policy_missing" : "uptime_split_policy_invalid");
    else { policyRules(stored.policy, blocked); runnerRules(snapshot, stored.policy, blocked, warnings); }
    // PR09 관측·gate 와 함께 켤 수 없다(0103 트리거가 같은 것을 강제한다)
    if (pr09) blocked.push("uptime_control_enabled");
    // 배치 versioned 에서는 Oracle product-health 역할 잡이 claim 권한 없이 같은 잡을 돈다(design-uptime §11)
    if (snapshot.batchMode !== "legacy") blocked.push(`batch_mode_not_legacy:${snapshot.batchMode}`);
    if (readback.queue.missingRows > 0) warnings.push(`claim_rows_missing:${readback.queue.missingRows}`);
  } else {
    // legacy 로 돌아가면 Oracle 제출은 거부되고 남은 제출 행은 다음 claims 틱의 적용기가 버린다. legacy 잡은 다음 틱부터 지금 그대로 돈다
    if (readback.queue.submitted > 0) warnings.push(`submitted_results_discarded:${readback.queue.submitted}`);
    if (readback.queue.claimed > 0) warnings.push(`live_claims_expire:${readback.queue.claimed}`);
  }
  return plan(`${control.mode} → ${command.to}, epoch ${control.epoch} → ${control.epoch + 1}`,
    { mode: command.to, policy: stored.state === "verified" ? stored.policy : null, policyHash: stored.state === "verified" ? control.policyHash : null });
}

export type UptimeSplitResult = { command: UptimeSplitTransition["name"]; dryRun: boolean; executed: boolean; blocked: boolean;
  plan: UptimeSplitPlan; before: UptimeSplitSnapshot; after?: UptimeSplitSnapshot; auditId?: number };

function readbackLines(readback: UptimeSplitReadback): string[] {
  const control = readback.control, stored = storedUptimeSplitPolicy(control), q = readback.queue;
  const age = (value: number | null) => value === null ? "-" : `${Math.round(value)}분`;
  const hosts = stored.state === "verified" ? stored.policy.hosts.map(host => `${host.host}:${host.instanceId}(${host.class}`
    + `${host.maxPerHour ? ` ${host.maxPerHour}/h` : ""})`).join(" ") : "-";
  return [`[split] mode=${control.mode} epoch=${control.epoch} policy=${stored.state === "verified" ? control.policyHash!.slice(0, 12) : stored.state}`
      + ` PR09 관측=${readback.uptimeControl.observationsEnabled ? "on" : "off"} gate=${readback.uptimeControl.gateEnabled ? "on" : "off"}`,
    `[hosts] ${hosts}`,
    `[queue] due ${q.due}(최장 ${age(q.dueOldestMinutes)}) · 확인 중 ${q.claimed} · 제출 대기 ${q.submitted}(최장 ${age(q.submittedOldestMinutes)})`
      + ` · 재확인 대기 ${q.confirm}(최장 ${age(q.confirmOldestMinutes)}) · 5분 반영 ${q.applied5m} · 행 없음 ${q.missingRows}`,
    `[1h] host별 반영 ${Object.entries(readback.applied1h).map(([host, n]) => `${host} ${n}`).join(" · ") || "없음"}`,
    `[breaker] ${uptimeSplitNote(readback)}`];
}

/** 사람이 읽는 출력. --json이면 이 대신 결과 JSON 한 줄을 쓴다. */
export function formatUptimeSplitStatus(snapshot: UptimeSplitSnapshot): string {
  return [`DB 시각 ${snapshot.readback.at}  fence=${snapshot.fence}  batch=${snapshot.batchMode}  maintenance 후보(24h)=${snapshot.runners.join(",") || "-"}`,
    ...readbackLines(snapshot.readback), ""].join("\n");
}
export function formatUptimeSplitResult(result: UptimeSplitResult): string {
  const { plan } = result;
  const state = result.executed ? `실행 완료(감사 로그 id ${result.auditId})` : result.blocked ? "거절 — 아무것도 쓰지 않았다"
    : "dry-run 허용 — DB 쓰기 없음. 같은 명령에 --execute를 붙이면 실행한다";
  return [`uptime-split ${result.command} — ${state}`, `대상  ${plan.target}`, `변경  ${plan.change}`,
    ...plan.blocked.map(code => `거절  ${code}`), ...plan.warnings.map(code => `경고  ${code}`),
    ...(plan.next.policyHash && result.command === "policy" ? [`새 policy hash  ${plan.next.policyHash}`] : []),
    "현재:", ...readbackLines(result.before.readback),
    ...(result.after ? ["실행 뒤 readback:", ...readbackLines(result.after.readback)] : []), ""].join("\n");
}

const EXCLUSION_CODES = new Set(["uptime_split_requires_uptime_control_disabled", "uptime_control_requires_split_legacy"]);
/**
 * 0103 상호 배제 트리거(split claims ↔ PR09 관측·gate)의 거절이면 그 code, 아니면 null. drizzle 이 감싼 원래 오류(cause)까지 본다.
 * 코드 검사(판정)를 지난 뒤 다른 운영 명령이 먼저 commit 한 경합에서만 여기에 닿는다 — 오류가 아니라 거절로 돌려준다.
 */
export function uptimeExclusionError(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const row = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (row.code === "55000" && typeof row.message === "string" && EXCLUSION_CODES.has(row.message)) return row.message;
    current = row.cause;
  }
  return null;
}
