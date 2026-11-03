import { z } from "zod";
import { identity, isoMillis } from "./epoch";

/**
 * 소유 프로세스 부재(owner_gone) 판정 — 2026-11-02.
 *
 * 장부의 dispatched 행은 그 owner(instance, boot)의 프로세스만 정산할 수 있다. 그 프로세스가 커널 패닉·컨테이너 사망으로 사라지면 group_exited 같은
 * 종료 기록도 남지 않아(같은 커널 부팅의 후속 프로세스가 적어야 하는데 커널이 바뀌었다) 정식 회수(reclaim)가 영영 unproven 으로 둔다. 이 모듈은
 * 이미 DB 에 있는 생존 기록만으로 "그 owner 는 없어졌다"를 판정해, 운영자가 그 행을 dispatched → indeterminate 로 옮기게 한다(released 아님 —
 * 제공자 쪽 생성이 끝났는지는 모른다). 2026-10-30 결정대로 indeterminate 는 슬롯을 차지하지 않고 사람 검토(closeModelCapacityUnknownReview)로 닫는다.
 *
 * 시간 경과·TTL 만으로는 바꾸지 않는다. 판정(judgeOwnerGone)은 다음을 모두 요구한다.
 * 1. 행이 지금 dispatched 이고 전송 시각을 안다.
 * 2. 옛 owner boot 가 아직 쥔 lease 가 없다 — 만료 전 역할 lease(role_leases) 나 일감 lease(pipeline_item_leases)가 있으면 살아 있다.
 * 3. 옛 boot 의 모든 생존 기록(프로세스 그룹 기록·장부 활동·역할 lease 갱신·배치 후보·후보 관측·종료 기록) 중 마지막 것이 전송 시각 뒤로도
 *    quiet(기본 30분, 최소 10분) 이상 없다. — 이것만으로는 바꾸지 않는다(부재 근거는 아래 양성 근거와 함께만 쓴다).
 * 4. 양성 근거가 하나 이상 있다:
 *    - successor_boot: 같은 instance 의 다른 boot 가 전송 뒤에 시작했다는 기록(그 boot 의 프로세스 그룹 owner_opened, 또는 역할 lease 취득 기록
 *      primary_boots)이 있고, 그 boot 의 마지막 기록이 옛 boot 의 마지막 기록보다 늦다(그 instance 의 지금 프로세스는 새 boot 다).
 *    - owner_exit_record: 옛 boot 자신이 전송 뒤에 남긴 종료 기록(worker-exit:<role>:<boot>)이 있다.
 * 가정: SERVICE_INSTANCE_ID 하나에는 한 프로세스만 오래 산다(Swarm 1복제본, 교체 배포 때 옛 task 는 stop grace 안에 멈춘다). 같은 instance 이름을
 * 두 복제본이 함께 쓰는 서비스(scheduler 복제본 등)는 이 판정의 대상이 아니다 — 그런 owner 는 장부 행을 만들지 않는다.
 */

export const OWNER_GONE_QUIET_MS = Object.freeze({ default: 30 * 60_000, min: 10 * 60_000, max: 7 * 86_400_000 });
export const OWNER_GONE_MAX_REQUESTS = 20;
export const OWNER_FACT_SOURCES = Object.freeze(["process_group_opened", "process_group_event", "ledger_activity", "role_lease", "role_lease_acquired",
  "item_lease", "batch_candidate", "candidate_observation", "worker_exit"] as const);
export type OwnerFactSource = (typeof OWNER_FACT_SOURCES)[number];
/** boot 가 시작했다는 기록(그 boot 가 처음 한 일). 나머지는 "그 시각에 살아 있었다"는 기록이다. */
const START_SOURCES: ReadonlySet<OwnerFactSource> = new Set(["process_group_opened", "role_lease_acquired"]);
export const OWNER_GONE_BASES = Object.freeze(["successor_boot", "owner_exit_record"] as const);
export type OwnerGoneBasis = (typeof OWNER_GONE_BASES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type OwnerFact = Readonly<{ bootId: string; source: OwnerFactSource; at: string; live: boolean; detail: Readonly<Record<string, unknown>> | null }>;
type Stamp = Readonly<{ at: string; source: OwnerFactSource }>;
export type BootSummary = Readonly<{ bootId: string; firstStart: Stamp | null; lastSeen: Stamp | null; liveHold: string | null; roleLease: string | null;
  exitRecordedAt: string | null; kernelBootId: string | null; unexitedSpawns: number }>;

const later = (a: Stamp | null, b: Stamp) => !a || b.at > a.at ? b : a;
const earlier = (a: Stamp | null, b: Stamp) => !a || b.at < a.at ? b : a;
const text = (value: unknown) => typeof value === "string" ? value : null;

/** 한 boot 의 기록 요약(순수). ISO 밀리초 UTC 문자열은 사전순이 곧 시간순이다. */
export function summarizeBoot(bootId: string, facts: readonly OwnerFact[]): BootSummary {
  let firstStart: Stamp | null = null, lastSeen: Stamp | null = null, liveHold: string | null = null, roleLease: string | null = null;
  let exitRecordedAt: string | null = null, kernelBootId: string | null = null, unexitedSpawns = 0;
  for (const fact of facts) {
    if (fact.bootId !== bootId) continue;
    const stamp = { at: fact.at, source: fact.source };
    lastSeen = later(lastSeen, stamp);
    if (START_SOURCES.has(fact.source)) firstStart = earlier(firstStart, stamp);
    if (fact.live) {
      const role = text(fact.detail?.role);
      if (fact.source === "role_lease") { roleLease = role; liveHold ??= `role_lease${role ? `:${role}` : ""}`; }
      if (fact.source === "item_lease") liveHold ??= "item_lease";
    }
    if (fact.source === "worker_exit" && (!exitRecordedAt || fact.at > exitRecordedAt)) exitRecordedAt = fact.at;
    if (fact.source === "process_group_opened") kernelBootId = text(fact.detail?.kernelBootId) ?? kernelBootId;
    if (fact.source === "process_group_event") unexitedSpawns = Math.max(unexitedSpawns, Number(fact.detail?.unexitedSpawns ?? 0) || 0);
  }
  return { bootId, firstStart, lastSeen, liveHold, roleLease, exitRecordedAt, kernelBootId, unexitedSpawns };
}

export type OwnerGoneInput = Readonly<{ state: string; dispatchAt: string | null; owner: Readonly<{ instanceId: string; bootId: string }>;
  now: string; quietMs: number; facts: readonly OwnerFact[]; truncated?: boolean }>;
export type OwnerGoneVerdict =
  | Readonly<{ status: "gone"; basis: OwnerGoneBasis[]; ownerLastSeen: Stamp; owner: BootSummary; successor: BootSummary | null }>
  | Readonly<{ status: "refused"; reason: string; ownerLastSeen: Stamp | null; owner: BootSummary | null; successor: BootSummary | null }>
  | Readonly<{ status: "not_dispatched"; state: string }>;

/** 판정(순수). 근거가 모자라면 바꾸지 않고 이유를 돌려준다. */
export function judgeOwnerGone(input: OwnerGoneInput): OwnerGoneVerdict {
  if (input.state !== "dispatched") return { status: "not_dispatched", state: input.state };
  const refuse = (reason: string, rest: { ownerLastSeen?: Stamp | null; owner?: BootSummary | null; successor?: BootSummary | null } = {}) =>
    ({ status: "refused" as const, reason, ownerLastSeen: rest.ownerLastSeen ?? null, owner: rest.owner ?? null, successor: rest.successor ?? null });
  if (!input.dispatchAt) return refuse("dispatch_time_unknown");
  if (input.truncated) return refuse("owner_facts_truncated");
  if (!Number.isSafeInteger(input.quietMs) || input.quietMs < OWNER_GONE_QUIET_MS.min || input.quietMs > OWNER_GONE_QUIET_MS.max) return refuse("quiet_window_invalid");
  const owner = summarizeBoot(input.owner.bootId, input.facts);
  if (owner.liveHold) return refuse(`owner_holds_${owner.liveHold.split(":")[0]}`, { owner });
  // 전송 자체도 그 boot 의 생존 기록이다.
  const ownerLastSeen = owner.lastSeen && owner.lastSeen.at > input.dispatchAt ? owner.lastSeen : { at: input.dispatchAt, source: "ledger_activity" as const };
  if (Date.parse(input.now) - Date.parse(ownerLastSeen.at) < input.quietMs) return refuse("owner_seen_recently", { ownerLastSeen, owner });
  const boots = [...new Set(input.facts.map(fact => fact.bootId))].filter(bootId => bootId !== input.owner.bootId);
  const successors = boots.map(bootId => summarizeBoot(bootId, input.facts))
    .filter(boot => boot.firstStart !== null && boot.firstStart.at > input.dispatchAt!)
    .sort((a, b) => (b.lastSeen?.at ?? "").localeCompare(a.lastSeen?.at ?? "") || a.bootId.localeCompare(b.bootId));
  const successor = successors[0] ?? null;
  const basis: OwnerGoneBasis[] = [];
  if (successor && successor.lastSeen && successor.lastSeen.at >= ownerLastSeen.at) basis.push("successor_boot");
  if (owner.exitRecordedAt && owner.exitRecordedAt >= input.dispatchAt) basis.push("owner_exit_record");
  if (!basis.length) return refuse(successor ? "owner_newer_than_successor" : "no_successor_boot", { ownerLastSeen, owner, successor });
  return { status: "gone", basis, ownerLastSeen, owner, successor: basis.includes("successor_boot") ? successor : null };
}

const stampSchema = z.object({ at: isoMillis, source: z.enum(OWNER_FACT_SOURCES) }).strict();
const bootIdSchema = z.string().regex(UUID);
/** dispatch_indeterminate event 의 evidence 와 감사 기록 detail 에 같은 값으로 남는다. */
export const ownerGoneEvidenceSchema = z.object({ version: z.literal(1), kind: z.literal("owner_gone"), requestId: z.uuid(),
  owner: z.object({ instanceId: identity(120), bootId: bootIdSchema }).strict(), fromState: z.literal("dispatched"), dispatchAt: isoMillis,
  evaluatedAt: isoMillis, quietMs: z.number().int().min(OWNER_GONE_QUIET_MS.min).max(OWNER_GONE_QUIET_MS.max),
  basis: z.array(z.enum(OWNER_GONE_BASES)).min(1).max(2), ownerLastSeen: stampSchema, ownerExitRecordedAt: isoMillis.nullable(),
  ownerKernelBootId: bootIdSchema.nullable(), unexitedSpawns: z.number().int().min(0),
  successor: z.object({ bootId: bootIdSchema, firstStart: stampSchema, lastSeen: stampSchema, kernelBootId: bootIdSchema.nullable(),
    roleLease: z.string().min(1).max(30).nullable() }).strict().nullable(),
  operator: identity(120) }).strict();
export type OwnerGoneEvidence = z.infer<typeof ownerGoneEvidenceSchema>;
