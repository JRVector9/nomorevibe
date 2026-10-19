import { createHash } from "node:crypto";
import { z } from "zod";
import { dbIdentitySchema, identity, isoMillis, oldDbFencedPayloadSchema, positiveEpoch, sameDatabase,
  type DbIdentity, type WriterFence } from "./epoch";
import { drainScopeSchema, evaluateCallDrain, independentBudgetPayloadSchema, providerDeadlinePayloadSchema,
  writerProcessStoppedPayloadSchema, type DrainScope, type DrainScopeResult, type ProcessStop } from "./call-drain";

/** 수동 승격 계획. 자동 승격·양방향 merge 옵션은 없다. knownActiveEpoch는 운영자가 확인한 현재 최고 epoch다. */
export const promotionPlanSchema = z.object({ version: z.literal(1), promotionId: z.uuid(), lineageId: z.uuid(),
  fromEpoch: positiveEpoch.max(9007199254740990), knownActiveEpoch: positiveEpoch, restoredDb: dbIdentitySchema,
  oldDbs: z.array(dbIdentitySchema).min(1).max(8), oldInstances: z.array(identity(120)).max(64), snapshotAt: isoMillis,
  operator: identity(120) }).strict()
  .refine(value => value.knownActiveEpoch === value.fromEpoch, "known_epoch_not_from_epoch")
  .refine(value => value.oldDbs.every((db, index) => value.oldDbs.findIndex(other => sameDatabase(db, other)) === index), "duplicate_old_db")
  .refine(value => !value.oldDbs.some(db => sameDatabase(db, value.restoredDb)), "restored_db_is_old_db")
  .refine(value => new Set(value.oldInstances).size === value.oldInstances.length, "duplicate_old_instance");
export type PromotionPlan = Readonly<z.infer<typeof promotionPlanSchema>>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export function contentHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
export function promotionPlanHash(plan: PromotionPlan): string { return contentHash(promotionPlanSchema.parse(plan)); }
export const dbSubject = (db: DbIdentity) => `db:${db.systemIdentifier}:${db.databaseOid}`;

export const oldDbIsolatedPayloadSchema = z.object({ version: z.literal(1), db: dbIdentitySchema,
  method: z.enum(["host_powered_off", "db_service_stopped", "network_blocked"]), reference: identity(400),
  autoRestartDisabled: z.literal(true), rejoinFenceRequired: z.literal(true), observedAt: isoMillis }).strict();
export const externalEffectsPayloadSchema = z.object({ version: z.literal(1), windowFrom: isoMillis, windowTo: isoMillis,
  method: z.enum(["old_db_compared", "manual_review"]), reference: identity(400), reviewed: z.number().int().min(0).max(10_000_000),
  corrective: identity(400) }).strict().refine(value => Date.parse(value.windowFrom) <= Date.parse(value.windowTo), "invalid_window");
export const httpHopsReleasedPayloadSchema = z.object({ version: z.literal(1), controlEpoch: positiveEpoch,
  released: z.array(z.uuid()).max(100_000), cancelled: z.array(z.uuid()).max(100_000), drainedAt: isoMillis }).strict();

export const EVIDENCE_KINDS = ["old_db_fenced", "old_db_isolated", "writer_process_stopped", "provider_deadline",
  "independent_budget", "external_effects_reconciled", "http_hops_released"] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
/** 근거의 자연 키를 subject로 고정한다. 다른 subject로 같은 근거를 재사용하지 못한다. */
export function parseEvidence(kind: EvidenceKind, subject: string, payload: unknown): { subject: string; payload: unknown } {
  const checked = (() => {
    switch (kind) {
      case "old_db_fenced": { const value = oldDbFencedPayloadSchema.parse(payload); return { key: dbSubject(value.db), value }; }
      case "old_db_isolated": { const value = oldDbIsolatedPayloadSchema.parse(payload); return { key: dbSubject(value.db), value }; }
      case "writer_process_stopped": { const value = writerProcessStoppedPayloadSchema.parse(payload); return { key: value.instanceId, value }; }
      case "provider_deadline": { const value = providerDeadlinePayloadSchema.parse(payload); return { key: value.scope, value }; }
      case "independent_budget": { const value = independentBudgetPayloadSchema.parse(payload); return { key: value.scope, value }; }
      case "external_effects_reconciled": return { key: "rpo-window", value: externalEffectsPayloadSchema.parse(payload) };
      case "http_hops_released": { const value = httpHopsReleasedPayloadSchema.parse(payload); return { key: `http:${value.controlEpoch}`, value }; }
      default: throw new Error("dr_evidence_kind_unknown");
    }
  })();
  if (checked.key !== subject) throw new Error("dr_evidence_subject_mismatch");
  return { subject, payload: checked.value };
}

export const sealSnapshotSchema = z.object({ version: z.literal(1), sealedAt: isoMillis, instances: z.array(identity(120)).max(4096),
  modelBudgets: z.array(identity(120)).max(256), activeModelCalls: z.number().int().min(0), activeHttpHops: z.number().int().min(0),
  revoked: z.object({ roles: z.number().int().min(0), jobs: z.number().int().min(0), items: z.number().int().min(0), sourceClaims: z.number().int().min(0),
    // 0103 뒤 seal 부터 기록한다. 그 전 snapshot 에는 없다
    uptimeClaims: z.number().int().min(0).optional(),
    // 0104 뒤 seal 부터 있다. 그 전 스냅숏도 읽히게 optional 이다
    agentClaims: z.number().int().min(0).optional() }).strict(),
  modelControl: z.object({ epoch: positiveEpoch, revision: positiveEpoch, mode: z.enum(["disabled", "draining"]) }).strict(),
  httpControl: z.object({ epoch: positiveEpoch, mode: z.enum(["disabled", "draining"]) }).strict() }).strict();
export type SealSnapshot = Readonly<z.infer<typeof sealSnapshotSchema>>;

export type PromotionRecord = Readonly<{ promotionId: string; plan: PromotionPlan; planHash: string; state: "sealed" | "promoted";
  dbIdentity: DbIdentity; sealSnapshot: SealSnapshot }>;
export type EvidenceRecord = Readonly<{ id: number; kind: EvidenceKind; subject: string; payload: unknown; operator: string }>;
export type PromotionEvaluation = Readonly<{ ready: boolean; blockers: readonly string[]; drain: readonly DrainScopeResult[] }>;

/** 같은 (kind,subject)는 마지막 기록이 유효하다(append-only 정정). */
export function latestEvidence(records: readonly EvidenceRecord[]): Map<string, EvidenceRecord> {
  const latest = new Map<string, EvidenceRecord>();
  for (const record of [...records].sort((a, b) => a.id - b.id)) latest.set(`${record.kind}\u0000${record.subject}`, record);
  return latest;
}

export function drainScopes(snapshot: SealSnapshot): DrainScope[] {
  return ["http", ...[...new Set(snapshot.modelBudgets)].sort().map(budget => `model:${budget}` as const)].map(scope => drainScopeSchema.parse(scope) as DrainScope);
}

function promotionDrainFrom(promotion: PromotionRecord, latest: ReadonlyMap<string, EvidenceRecord>, nowMs: number) {
  const get = (kind: EvidenceKind, subject: string) => latest.get(`${kind}\u0000${subject}`)?.payload;
  const required = [...new Set([...promotion.plan.oldInstances, ...promotion.sealSnapshot.instances])].sort();
  const stops = new Map<string, ProcessStop>();
  for (const instance of required) {
    const stop = get("writer_process_stopped", instance) as z.infer<typeof writerProcessStoppedPayloadSchema> | undefined;
    if (stop) stops.set(instance, { stoppedAtMs: Date.parse(stop.stoppedAt), skewBoundMs: stop.skewBoundMs });
  }
  const scopes = drainScopes(promotion.sealSnapshot), deadlines = new Map<string, z.infer<typeof providerDeadlinePayloadSchema>>(), independent = new Set<string>();
  for (const scope of scopes) {
    const deadline = get("provider_deadline", scope) as z.infer<typeof providerDeadlinePayloadSchema> | undefined;
    if (deadline) deadlines.set(scope, deadline);
    if (get("independent_budget", scope)) independent.add(scope);
  }
  return { required, stops, drain: evaluateCallDrain({ nowMs, scopes, requiredInstances: required, stops, deadlines, independent }) };
}
/** permit adapter용: promote 뒤에도 같은 근거·같은 규칙으로 scope별 barrier를 다시 계산한다. */
export function promotionDrain(promotion: PromotionRecord, evidence: readonly EvidenceRecord[], nowMs: number): DrainScopeResult[] {
  return promotionDrainFrom(promotion, latestEvidence(evidence), nowMs).drain;
}

/** 순수 승격 판정. 같은 TX에서 DB clock(nowMs)과 잠긴 fence/근거로 다시 부른다. */
export function evaluatePromotion(input: Readonly<{ promotion: PromotionRecord; fence: WriterFence; dbIdentity: DbIdentity;
  evidence: readonly EvidenceRecord[]; nowMs: number }>): PromotionEvaluation {
  const { promotion, fence, dbIdentity, nowMs } = input, plan = promotion.plan, blockers: string[] = [];
  const latest = latestEvidence(input.evidence);
  const get = (kind: EvidenceKind, subject: string) => latest.get(`${kind}\u0000${subject}`)?.payload;
  // G1: 이 DB가 이 승격으로 seal된 복원 사본이어야 한다.
  if (promotion.state !== "sealed" || fence.state !== "fenced" || fence.reason !== "promotion_sealed" || fence.promotionId !== promotion.promotionId
    || fence.lineageId !== plan.lineageId || fence.writerEpoch !== plan.fromEpoch || !sameDatabase(dbIdentity, plan.restoredDb)
    || !sameDatabase(promotion.dbIdentity, dbIdentity)) blockers.push("promotion_not_sealed");
  // G2: 옛 DB마다 그 DB에서 읽은 fence readback 또는 격리(자동 재시작 차단·rejoin fence 의무) 근거.
  plan.oldDbs.forEach((db, index) => {
    const fenced = get("old_db_fenced", dbSubject(db)) as z.infer<typeof oldDbFencedPayloadSchema> | undefined;
    const isolated = get("old_db_isolated", dbSubject(db)) as z.infer<typeof oldDbIsolatedPayloadSchema> | undefined;
    const ok = fenced ? sameDatabase(fenced.db, db) && fenced.lineageId === plan.lineageId && fenced.writerEpoch === plan.fromEpoch
      : isolated ? sameDatabase(isolated.db, db) : false;
    if (!ok) blockers.push(`old_db_unfenced:${index}`);
  });
  // G3: 계획에 적은 instance와 seal 직전 장부에 보인 모든 owner instance.
  const { required, stops, drain } = promotionDrainFrom(promotion, latest, nowMs);
  for (const instance of required) if (!stops.has(instance)) blockers.push(`writer_process_unfenced:${instance}`);
  if (!required.length) blockers.push("writer_instances_undeclared");
  // G4: scope별 call-drain.
  for (const scope of drain) {
    if (scope.status === "blocked") blockers.push(`drain_blocked:${scope.scope}:${scope.reason}`);
    if (scope.status === "waiting") blockers.push(`drain_waiting:${scope.scope}`);
  }
  // G5: RPO 창(복원 시점 ~ 마지막 옛 writer 정지)의 외부 효과 정산.
  const effects = get("external_effects_reconciled", "rpo-window") as z.infer<typeof externalEffectsPayloadSchema> | undefined;
  const lastStop = stops.size === required.length && required.length ? Math.max(...[...stops.values()].map(stop => stop.stoppedAtMs)) : null;
  if (!effects) blockers.push("external_effects_unreconciled");
  else if (lastStop === null || Date.parse(effects.windowFrom) > Date.parse(plan.snapshotAt) || Date.parse(effects.windowTo) < lastStop)
    blockers.push("reconciliation_window_incomplete");
  return { ready: blockers.length === 0, blockers, drain };
}
