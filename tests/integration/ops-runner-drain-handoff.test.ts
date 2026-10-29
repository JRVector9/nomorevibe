import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { capacityPin, controlOpsAdmission, handOffOpsDrain } from "@/lib/operations/ops-runner/control";
import { initialOpsState } from "@/lib/operations/ops-runner/contract";
import { previewModelOpsCommand, submitModelOpsCommand } from "@/lib/operations/ops-runner/repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// 확정본(2026-10-29-release-order.md) 7·11단계: runner가 정식 CAS로 건 DRAIN을 OPEN 없이 인계한다. 실제 DB에서
// 감사 핀(jsonb)과 FOR UPDATE로 읽은 control 핀이 같게 왕복하는지, 남의 DRAIN·바뀐 DRAIN을 거절하는지 본다.
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { abcllm: 2 }, groupLimits: { gateway: 2 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [{ routeId: "second-review", provider: "abcllm", model: "handoff-fixture", providerBudgetId: "abcllm", groupId: "gateway" }] };
let baseline: Record<string, unknown>;
const job = (reason = "handoff integration") => ({ ...initialOpsState({ id: randomUUID(), action: "request-release", targetId: randomUUID(), reason,
  confirmed: true }, "jr"), finalAdmission: "draining" as const });
const controlAudit = (target: string) => admin<{ detail: { after: unknown; handoff?: string } }[]>`SELECT detail FROM operations_audit
  WHERE action='ops-runner-control' AND target=${target} ORDER BY id`;

beforeAll(async () => {
  ensureSchema();
  [{ value: baseline }] = await admin`SELECT to_jsonb(c) value FROM model_capacity_control c WHERE id=1`;
  await admin`UPDATE model_capacity_control SET mode='open', policy=${JSON.stringify(policy)}::text::jsonb, policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`;
});
afterAll(async () => {
  try {
    await admin`UPDATE model_capacity_control c SET (mode, policy, policy_hash, epoch, revision, updated_at) =
      (SELECT b.mode, b.policy, b.policy_hash, b.epoch, b.revision, b.updated_at FROM jsonb_populate_record(NULL::model_capacity_control, ${JSON.stringify(baseline)}::text::jsonb) b)
      WHERE c.id=1`;
    expect((await admin`SELECT to_jsonb(c) value FROM model_capacity_control c WHERE id=1`)[0].value).toEqual(baseline);
  } finally {
    await admin.end();
    await (globalThis as unknown as { pgClient?: postgres.Sql }).pgClient?.end();
  }
});

it("정식 CAS로 건 자기 DRAIN만 capacity를 바꾸지 않고 한 번만 인계 기록하며, 바뀐 DRAIN·남의 DRAIN은 거절한다", async () => {
  const state = job();
  const open = await capacityPin();
  expect(open.mode).toBe("open");
  expect(await controlOpsAdmission(state, "draining", open)).toEqual({ ok: true, code: undefined });
  const drained = await capacityPin();
  expect(drained).toMatchObject({ mode: "draining", epoch: open.epoch, revision: open.revision, policyHash: open.policyHash });
  const [own] = await controlAudit(`${state.id}:draining`);
  expect(own.detail.after).toEqual(drained);

  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: true });
  expect(await capacityPin()).toEqual(drained);
  const handoff = await controlAudit(`${state.id}:handoff`);
  expect(handoff).toHaveLength(1);
  expect(handoff[0].detail).toEqual({ after: drained, handoff: "draining", reason: state.reason });
  // 응답 유실 뒤 재실행은 같은 핀만 다시 확인하고 행을 더 쓰지 않는다.
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: true });
  expect(await controlAudit(`${state.id}:handoff`)).toHaveLength(1);

  // 이 job이 DRAIN을 건 기록이 없으면(남의 DRAIN) 인계하지 않는다.
  const stranger = job("stranger");
  expect(await handOffOpsDrain(stranger, drained)).toEqual({ ok: false, code: "handoff_drain_not_owned" });
  expect(await controlAudit(`${stranger.id}:handoff`)).toHaveLength(0);

  // runner 밖에서 control이 바뀌면(같은 mode여도 updated_at이 다르면) 인계하지 않는다.
  await admin`UPDATE model_capacity_control SET updated_at = updated_at + interval '1 second' WHERE id=1`;
  const later = job("after outside change");
  expect(await controlAudit(`${later.id}:draining`)).toHaveLength(0);
  expect(await handOffOpsDrain(state, drained)).toEqual({ ok: false, code: "handoff_drain_changed" });
  expect((await capacityPin()).mode).toBe("draining");
});

it("운영자 셸 접수 미리 보기는 READ ONLY이고, indeterminate가 아닌 대상은 감사 행 없이 거절한다", async () => {
  const command = { id: randomUUID(), action: "request-release" as const, targetId: randomUUID(), reason: "cli intake integration", confirmed: true as const };
  const [{ count: before }] = await admin<{ count: number }[]>`SELECT count(*)::int count FROM operations_audit`;
  const preview = await previewModelOpsCommand(command, "jr");
  expect(preview).toMatchObject({ existing: null, request: null });
  expect(preview.blocked).toContain("ops_runner_request_not_indeterminate");
  await expect(submitModelOpsCommand(command, "jr", "cli")).rejects.toThrow(/ops_runner_request_not_indeterminate|ops_runner_unfinished_operation/);
  const [{ count: after }] = await admin<{ count: number }[]>`SELECT count(*)::int count FROM operations_audit`;
  expect(after).toBe(before);
  expect(await admin`SELECT 1 FROM operations_audit WHERE action='ops-runner-state' AND target=${command.id}`).toHaveLength(0);
});
