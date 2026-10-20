import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { eq, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { uptimeControl, uptimeSplitControl } from "@/lib/db/product-uptime-schema";
import { uptimeSplitPolicyHash } from "@/lib/domain/products/uptime-split-policy";
import { readMaintenanceUptimeProgress } from "@/lib/operations/maintenance-progress";
import { readPipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { applyUptimeTransition } from "@/lib/operations/uptime-gate-repository";
import { uptimeExclusionError, type UptimeSplitResult, type UptimeSplitSnapshot } from "@/lib/operations/uptime-split";
import { readUptimeSplitReadback } from "@/lib/operations/uptime-split-repository";
import { readWorkerProgress } from "@/lib/operations/worker-progress-query";
import { uptimeSplitMain } from "../../scripts/ops/uptime-split";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { clearSplitState, OWNERS, POLICY, product, setSplit } from "./uptime-split-fixture";

/*
 * U1c — split 제어 CLI(dry-run·CAS·감사), PR09 와의 상호 배제(양방향·경합), 운영 진행 지표(장부·배포 관문·감시)를 실제 DB 로.
 */
const operator = "u1c-test";
const runnerPattern = or(like(operationsObservations.key, "candidate:maintenance:%"), like(operationsObservations.key, "candidate:product-health:%"));
const RUNNER = `candidate:maintenance:${OWNERS.m3.instanceId}`;
const env = { UPTIME_SPLIT_DATABASE_URL: TEST_DATABASE_URL };
const raw = postgres(TEST_DATABASE_URL, { max: 2 });
let directory = "";
let foreignRunners: Record<string, unknown>[] = [];
let foreignLease: Record<string, unknown> | undefined;
let original: { split: Record<string, unknown>; control: Record<string, unknown> | undefined };

type Out = { status: number; json: (UptimeSplitResult & { snapshot?: UptimeSplitSnapshot }) | null };
async function cli(...args: string[]): Promise<Out> {
  let text = "";
  const status = await uptimeSplitMain([...args, "--json"], env, chunk => { text += chunk; });
  return { status, json: text.trim() ? JSON.parse(text) : null };
}
const audited = ["--operator=" + operator, "--reason=u1c integration"];
function policyFile(name: string, value: unknown) {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
async function split() {
  const [row] = await db.select().from(uptimeSplitControl).where(eq(uptimeSplitControl.id, 1));
  return row;
}
const ownAudits = async (floor: number) => (await auditRowsAfter(floor)).filter(row => row.actor === operator);
const PR09_SOURCES = JSON.stringify([{ host: "m3", instanceId: OWNERS.m3.instanceId, region: "kr-home" }]);
async function enablePr09() {
  await db.execute(sql`update uptime_control set observations_enabled = true, sources = ${PR09_SOURCES}::jsonb where id = 1`);
}

beforeAll(async () => {
  ensureSchema();
  directory = mkdtempSync(join(tmpdir(), "nomorevibe-u1c-"));
  const [splitRow] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_split_control c where id = 1`);
  const [control] = await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(c) as row from uptime_control c where id = 1`);
  original = { split: splitRow.row, control: control?.row };
  // 다른 파일이 남긴 역할 후보는 이 파일 동안만 빼 두고 원래 행 그대로 되돌린다(uptime-gate 통합 테스트와 같다)
  foreignRunners = (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(o) as row from operations_observations o
    where key like 'candidate:maintenance:%' or key like 'candidate:product-health:%' order by key`)).map(row => row.row);
  await db.delete(operationsObservations).where(runnerPattern);
  // maintenance 역할 lease 도 같다 — 감시 테스트가 주인을 바꾸므로 이 파일 동안만 빼 둔다
  [foreignLease] = (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(r) as row from role_leases r
    where role = 'maintenance'`)).map(row => row.row);
});
beforeEach(async () => {
  await resetTables();
  await clearSplitState();
  await db.update(uptimeControl).set({ observationsEnabled: false, gateEnabled: false, sources: [] }).where(eq(uptimeControl.id, 1));
  await setSplit("legacy", null);
  await db.insert(operationsObservations).values({ key: RUNNER, value: { role: "maintenance", phase: "active" } })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { observedAt: sql`localtimestamp` } });
  // resetTables 는 role_leases 를 비우지 않는다 — 감시 테스트가 넣는 maintenance 주인을 다음 테스트로 넘기지 않는다
  await db.execute(sql`delete from role_leases where role = 'maintenance'`);
});
afterAll(async () => {
  await db.execute(sql`update uptime_control set observations_enabled = false, gate_enabled = false where id = 1`);
  await db.execute(sql`update uptime_split_control set mode = ${original.split.mode as string}, policy = null, policy_hash = null,
    epoch = epoch + 1, updated_at = clock_timestamp() where id = 1`);
  if (original.control) {
    await db.execute(sql`update uptime_control set observations_enabled = ${original.control.observations_enabled as boolean},
      gate_enabled = ${original.control.gate_enabled as boolean}, sources = ${JSON.stringify(original.control.sources)}::jsonb where id = 1`);
  }
  await db.execute(sql`delete from uptime_host_breakers`);
  await db.execute(sql`delete from role_leases where role = 'maintenance'`);
  if (foreignLease) await db.execute(sql`insert into role_leases
    select * from jsonb_populate_record(null::role_leases, ${JSON.stringify(foreignLease)}::jsonb)`);
  await db.delete(operationsObservations).where(runnerPattern);
  for (const row of foreignRunners) await db.execute(sql`insert into operations_observations
    select * from jsonb_populate_record(null::operations_observations, ${JSON.stringify(row)}::jsonb)`);
  await raw.end({ timeout: 5 });
  rmSync(directory, { recursive: true, force: true });
});

describe("제어 CLI", () => {
  it("policy 는 기본 dry-run(쓰기 0), --execute 면 epoch+1·policy·감사 1행, 기대 epoch 가 틀리면 거절한다", async () => {
    const before = await split(), floor = await auditFloor();
    const file = policyFile("policy.json", POLICY);
    const dry = await cli("policy", `--file=${file}`, `--expect-epoch=${before.epoch}`, "--expect-policy-hash=none", ...audited);
    expect(dry).toMatchObject({ status: 0, json: { dryRun: true, executed: false, blocked: false, plan: { blocked: [] } } });
    expect(await split()).toEqual(before);
    expect(await ownAudits(floor)).toEqual([]);

    const stale = await cli("policy", `--file=${file}`, `--expect-epoch=${before.epoch - 1}`, "--expect-policy-hash=none", ...audited, "--execute");
    expect(stale).toMatchObject({ status: 3, json: { executed: false, blocked: true } });
    expect(stale.json!.plan.blocked).toEqual([`expect_epoch_mismatch:${before.epoch}`]);
    expect(await split()).toEqual(before);

    const done = await cli("policy", `--file=${file}`, `--expect-epoch=${before.epoch}`, "--expect-policy-hash=none", ...audited, "--execute");
    expect(done).toMatchObject({ status: 0, json: { executed: true, blocked: false } });
    const after = await split();
    expect(after).toMatchObject({ mode: "legacy", epoch: before.epoch + 1, policyHash: uptimeSplitPolicyHash(POLICY) });
    expect(done.json!.after!.readback.control).toMatchObject({ mode: "legacy", epoch: before.epoch + 1 });
    const rows = await ownAudits(floor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "uptime-split-policy", target: "uptime_split_control", actorKind: null, ok: true,
      detail: { reason: "u1c integration", before: { mode: "legacy", epoch: before.epoch, policyHash: null },
        after: { mode: "legacy", epoch: before.epoch + 1, policyHash: uptimeSplitPolicyHash(POLICY) } } });
    expect(rows[0].id).toBe(done.json!.auditId);
  });

  it("minChecks 100 초과·legacy 와 다른 묶음 기준·policy 에 없는 최근 실행자는 claims 로 가지 못한다", async () => {
    const before = await split();
    const loose = policyFile("loose.json", { ...POLICY, breaker: { ...POLICY.breaker, minChecks: 200, batchMin: 40 } });
    const refused = await cli("policy", `--file=${loose}`, `--expect-epoch=${before.epoch}`, "--expect-policy-hash=none", ...audited, "--execute");
    expect(refused.status).toBe(3);
    expect(refused.json!.plan.blocked).toEqual(["policy_min_checks_above:100", "policy_batch_rule_differs_from_legacy:30/0.3"]);
    expect(await split()).toEqual(before);

    const epoch = await setSplit("legacy", POLICY);
    await db.insert(operationsObservations).values({ key: "candidate:maintenance:u1c-unlisted", value: { role: "maintenance" } })
      .onConflictDoNothing();
    const unlisted = await cli("mode", "--to=claims", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audited, "--execute");
    expect(unlisted.status).toBe(3);
    expect(unlisted.json!.plan.blocked).toEqual(["uptime_runner_unconfigured:u1c-unlisted"]);
    expect((await split()).mode).toBe("legacy");
    await db.delete(operationsObservations).where(eq(operationsObservations.key, "candidate:maintenance:u1c-unlisted"));
  });

  it("mode claims ↔ legacy 는 각각 epoch+1 이고 policy 는 남는다", async () => {
    const epoch = await setSplit("legacy", POLICY), floor = await auditFloor();
    const on = await cli("mode", "--to=claims", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audited, "--execute");
    expect(on).toMatchObject({ status: 0, json: { executed: true } });
    expect(await split()).toMatchObject({ mode: "claims", epoch: epoch + 1, policyHash: uptimeSplitPolicyHash(POLICY) });
    const off = await cli("mode", "--to=legacy", "--from-mode=claims", `--expect-epoch=${epoch + 1}`, ...audited, "--execute");
    expect(off).toMatchObject({ status: 0, json: { executed: true } });
    expect(await split()).toMatchObject({ mode: "legacy", epoch: epoch + 2, policyHash: uptimeSplitPolicyHash(POLICY) });
    expect((await ownAudits(floor)).map(row => row.action)).toEqual(["uptime-split-mode", "uptime-split-mode"]);
    const status = await cli("status");
    expect(status.status).toBe(0);
    expect(status.json!.snapshot!).toMatchObject({ fence: "active", runners: [OWNERS.m3.instanceId], readback: { control: { mode: "legacy" } } });
  });
});

describe("PR09 관측·gate 와 상호 배제", () => {
  it("PR09 가 켜져 있으면 split claims 를 거절하고(코드 검사), 트리거도 같은 것을 막는다", async () => {
    const epoch = await setSplit("legacy", POLICY);
    await enablePr09();
    const refused = await cli("mode", "--to=claims", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audited, "--execute");
    expect(refused.status).toBe(3);
    expect(refused.json!.plan.blocked).toEqual(["uptime_control_enabled"]);
    expect((await split()).mode).toBe("legacy");
    const error = await db.execute(sql`update uptime_split_control set mode = 'claims', epoch = epoch + 1 where id = 1`).catch((value: unknown) => value);
    expect(uptimeExclusionError(error)).toBe("uptime_split_requires_uptime_control_disabled");
  });

  it("split 이 claims 면 PR09 raw-only 전환을 거절하고(코드 검사), 트리거 거절도 친절한 code 다", async () => {
    await setSplit("claims");
    const [before] = await db.select().from(uptimeControl).where(eq(uptimeControl.id, 1));
    const sources = [{ host: "m3" as const, instanceId: OWNERS.m3.instanceId, region: "kr-home" }];
    const result = await applyUptimeTransition(db, { target: "raw-only", expectRevision: before.revision, sources, operator, apply: true });
    expect(result.kind).toBe("blocked");
    expect(result.plan.blocked).toContain("uptime_split_claims_active");
    const [after] = await db.select().from(uptimeControl).where(eq(uptimeControl.id, 1));
    expect(after).toEqual(before);
    const error = await enablePr09().catch((value: unknown) => value);
    expect(uptimeExclusionError(error)).toBe("uptime_control_requires_split_legacy");
  });

  it("경합: split 실행이 commit 안 된 PR09 켜기를 기다렸다가 잠근 뒤 다시 판정해 쓰지 않는다", async () => {
    const epoch = await setSplit("legacy", POLICY), floor = await auditFloor();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = raw.begin(async tx => {
      await tx`update uptime_control set observations_enabled = true, sources = ${PR09_SOURCES}::jsonb where id = 1`;
      await gate;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const running = cli("mode", "--to=claims", "--from-mode=legacy", `--expect-epoch=${epoch}`, ...audited, "--execute");
    // split 실행 TX 는 uptime_control SHARE 에서 기다린다
    await new Promise(resolve => setTimeout(resolve, 300));
    release();
    await holder;
    const result = await running;
    expect(result.status).toBe(3);
    expect(result.json!.plan.blocked).toEqual(["uptime_control_enabled"]);
    // 거절은 잠근 뒤 다시 읽은 스냅숏에서 나왔다(처음 읽기는 commit 전이라 PR09 가 꺼져 보였다)
    expect(result.json!.before.readback.uptimeControl.observationsEnabled).toBe(true);
    expect(await split()).toMatchObject({ mode: "legacy", epoch });
    expect(await ownAudits(floor)).toEqual([]);
  });

  it("경합: PR09 전환이 판정 뒤 commit 된 split claims 에 닿으면 트리거 거절을 거절 결과로 돌려준다", async () => {
    await setSplit("legacy", POLICY);
    const [before] = await db.select().from(uptimeControl).where(eq(uptimeControl.id, 1));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = raw.begin(async tx => {
      await tx`update uptime_split_control set mode = 'claims', epoch = epoch + 1 where id = 1`;
      await gate;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const sources = [{ host: "m3" as const, instanceId: OWNERS.m3.instanceId, region: "kr-home" }];
    // 판정 스냅숏은 commit 전 split(legacy)을 본다 → 쓰기 TX 는 uptime_control 잠금을 기다린다 → split commit 뒤 트리거가 거절한다
    const running = applyUptimeTransition(db, { target: "raw-only", expectRevision: before.revision, sources, operator, apply: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    release();
    await holder;
    const result = await running;
    expect(result.kind).toBe("blocked");
    expect(result.plan.blocked).toEqual(["uptime_control_requires_split_legacy"]);
    const [after] = await db.select().from(uptimeControl).where(eq(uptimeControl.id, 1));
    expect(after).toEqual(before);
  });
});

describe("운영 진행 지표", () => {
  /** DB 시계 기준으로 claim 행을 맞춘다 */
  async function claimState(productId: number, set: ReturnType<typeof sql>) {
    await db.execute(sql`update uptime_claims set ${set} where product_id = ${productId}`);
  }

  it("장부: 가져갈 수 있는 due·최장, 확인 중, 제출 대기·최장, 재확인 대기·최장, 5분 반영, 행 없는 제품, 차단기, 1시간 사유", async () => {
    await setSplit("claims");
    const oldest = await product("due-oldest", { dueMinutes: -90, health: { hoursAgo: 8 } });
    await product("due-recheck-later", { dueMinutes: -120, health: { hoursAgo: 6.5 } });
    await product("due-fresh", { dueMinutes: -1 });
    await product("not-due", { dueMinutes: 30 });
    await product("unlisted", { status: "unverified", dueMinutes: -600 });
    await product("no-row", { claim: false });
    const confirm = await product("confirm", { dueMinutes: -1, health: { hoursAgo: 1 } });
    await claimState(confirm.id, sql`confirm_class = 'home', confirm_reason = 'http:403',
      confirm_requested_at = clock_timestamp() - interval '4 minutes', due_at = clock_timestamp() - interval '4 minutes',
      last_outcome = 'split_confirm_required', updated_at = clock_timestamp()`);
    const submitted = await product("submitted");
    await claimState(submitted.id, sql`state = 'submitted', token = gen_random_uuid(), epoch = 1, control_epoch = 1,
      owner_instance_id = ${OWNERS.oracle.instanceId}, host = 'oracle-osaka-smoke', host_class = 'probe',
      claimed_at = clock_timestamp() - interval '3 minutes', claim_slug = 'x', claim_url = 'https://x.example/',
      result_started_at = clock_timestamp() - interval '3 minutes', result_observed_at = clock_timestamp() - interval '3 minutes',
      result_kind = 'http', result_status = 200, submitted_at = clock_timestamp() - interval '2 minutes'`);
    const live = await product("claimed");
    await claimState(live.id, sql`state = 'claimed', token = gen_random_uuid(), epoch = 1, control_epoch = 1,
      owner_instance_id = ${OWNERS.m3.instanceId}, owner_boot_id = gen_random_uuid(), host = 'm3', host_class = 'home',
      lease_until = clock_timestamp() + interval '2 minutes', claimed_at = clock_timestamp(), claim_slug = 'y', claim_url = 'https://y.example/',
      origin = 'https://y.example', claim_slot = to_timestamp(floor(extract(epoch from clock_timestamp()) / 21600) * 21600)`);
    const applied = await product("applied", { dueMinutes: 300 });
    await claimState(applied.id, sql`last_applied_at = clock_timestamp() - interval '1 minute', last_applied_host = 'm3',
      last_outcome = 'split_success', updated_at = clock_timestamp()`);
    await db.execute(sql`insert into uptime_host_breakers (host, state, opened_at, probe_after, reason, ratio)
      values ('m3', 'open', clock_timestamp(), clock_timestamp() + interval '10 minutes', 'batch_ratio', 0.8)`);

    const readback = await readUptimeSplitReadback(db);
    // due: oldest(90분) · recheck-later(마지막 확인 + 6시간 = 30분 전) · fresh · confirm(재확인은 6시간 조건을 건너뛴다)
    expect(readback.queue).toMatchObject({ due: 4, claimed: 1, submitted: 1, confirm: 1, applied5m: 1, missingRows: 1 });
    expect(readback.queue.dueOldestMinutes).toBeGreaterThan(89);
    expect(readback.queue.dueOldestMinutes).toBeLessThan(91);
    expect(readback.queue.submittedOldestMinutes).toBeGreaterThan(1.9);
    expect(readback.queue.confirmOldestMinutes).toBeGreaterThan(3.9);
    expect(readback.breakers).toMatchObject([{ host: "m3", state: "open", reason: "batch_ratio", ratio: 0.8 }]);
    expect(readback.outcomes1h).toEqual({ split_confirm_required: 1, split_success: 1 });
    expect(readback.applied1h).toEqual({ m3: 1 });
    expect(oldest.id).toBeGreaterThan(0);

    // 운영센터 카드도 같은 장부를 읽는다
    const status = await readPipelineControlStatus();
    const card = status.controls.find(row => row.key === "uptimeSplit");
    expect(card).toMatchObject({ mode: "claims", policy: "verified" });
    expect(card?.metrics).toEqual(expect.arrayContaining([{ label: "마감 지남", value: 4 }, { label: "제출 대기", value: 1 },
      { label: "재확인 대기", value: 1 }, { label: "claim 행 없음", value: 1 }]));
    expect(card?.note).toContain("m3 열림(batch_ratio 0.80");
  });

  it("배포 관문·감시: legacy 는 uptime 단계가 없고, claims 의 home 차단기 대기는 경보가 아니며, 진행이 있으면 흐른다", async () => {
    await product("gate-due", { dueMinutes: -30, health: { hoursAgo: 8 } });
    const legacy = await readWorkerProgress();
    expect(legacy.stages.find(row => row.stage === "uptime")).toBeUndefined();
    expect((await readMaintenanceUptimeProgress()).splitHeld).toBe(false);

    await setSplit("claims");
    // 차단기 대기로 보는 것은 지금 maintenance 를 돌리는 home 의 차단기뿐이다 — 그 주인(m3)을 역할 lease 로 둔다
    await db.execute(sql`insert into role_leases (role, owner_instance_id, lease_until) values ('maintenance', ${OWNERS.m3.instanceId},
      (clock_timestamp() at time zone 'UTC') + interval '45 seconds')
      on conflict (role) do update set owner_instance_id = excluded.owner_instance_id, lease_until = excluded.lease_until`);
    await db.execute(sql`insert into uptime_host_breakers (host, state, opened_at, probe_after, reason, ratio)
      values ('m3', 'open', clock_timestamp(), clock_timestamp() + interval '10 minutes', 'batch_ratio', 0.8)`);
    const held = (await readWorkerProgress()).stages.find(row => row.stage === "uptime");
    expect(held).toMatchObject({ role: "maintenance", job: "uptime-ping", reason: "backoff", alarm: false, held: true, waiting: 1 });
    expect((await readMaintenanceUptimeProgress()).splitHeld).toBe(true);
    // 역할이 mini 로 넘어가면 m3 차단기는 진행을 붙잡지 않는다
    await db.execute(sql`update role_leases set owner_instance_id = ${OWNERS.mini.instanceId} where role = 'maintenance'`);
    expect((await readWorkerProgress()).stages.find(row => row.stage === "uptime")).toMatchObject({ held: false });
    await db.execute(sql`update role_leases set owner_instance_id = ${OWNERS.m3.instanceId} where role = 'maintenance'`);

    await db.execute(sql`delete from uptime_host_breakers`);
    await db.execute(sql`update uptime_claims set last_applied_at = clock_timestamp(), last_applied_host = 'm3'`);
    const flowing = (await readWorkerProgress()).stages.find(row => row.stage === "uptime");
    expect(flowing).toMatchObject({ reason: "progressing", alarm: false, held: false, progress5m: 1 });
    expect((await readMaintenanceUptimeProgress()).splitHeld).toBe(false);
  });
});
