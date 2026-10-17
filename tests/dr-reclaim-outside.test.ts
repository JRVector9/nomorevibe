import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { modelDispatchReleaseEvidenceSchema, gatewayLocalEndFactSchema } from "@/lib/llm/capacity";
import { evaluateLocalEndReclaim, judgeModelReclaim, type ProcessGroupEvent } from "@/lib/operations/dr/call-drain";
import { processGroupBootFor, processGroupOwnerEnvironment } from "@/lib/operations/dr/process-owner-env";
import { gatewayLocalEndTrackingEnabled, takeGatewayLocalEnd } from "@/lib/llm/gateway-local-end";
import { gatewayFetch } from "@/lib/llm/gateway-local-end-fetch";
import { httpHopReleaseEvidenceSchema } from "@/lib/operations/dr/hop-reclaim";
import { parsePromotionCliArgs } from "@/scripts/ops/dr/promotion";

// PR15d: DR 밖 회수의 순수 판정·근거 모양·게이트웨이 로컬 종료 증인·운영 CLI. 실제 DB·자식 프로세스 그룹은 integration 이 본다.
const T0 = Date.parse("2026-10-17T00:00:00.000Z"), at = (ms: number) => new Date(ms).toISOString();
const boot = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21", runId = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11";
const owner = { instanceId: "m3-text", bootId: boot }, requestId = "3f0c8a52-91c4-4d1e-9a51-6b8f9d3c2e10";
const event = (kind: ProcessGroupEvent["kind"], seq: number, ms: number, pid: number | null = null): ProcessGroupEvent =>
  ({ kind, seq, runId: kind === "owner_opened" ? null : runId, pid, recordedAtMs: T0 + ms });
const clientBound = { termination: "client_bound" as const, hardDeadlineMs: null, skewBoundMs: 500 };
const providerBound = (ms: number | null) => ({ termination: "provider_bound" as const, hardDeadlineMs: ms, skewBoundMs: 500 });

it("local end: needs a declared policy; provider_bound needs a proven deadline after the owner's recorded end; no TTL", () => {
  expect(evaluateLocalEndReclaim(T0, providerBound(null), T0 + 10 ** 9)).toEqual({ reclaimable: false, reason: "provider_deadline_unknown", notBeforeMs: null });
  expect(evaluateLocalEndReclaim(T0, providerBound(5_000), T0 + 5_499)).toEqual({ reclaimable: false, reason: "waiting", notBeforeMs: T0 + 5_500 });
  expect(evaluateLocalEndReclaim(T0, providerBound(5_000), T0 + 5_500)).toEqual({ reclaimable: true, notBeforeMs: T0 + 5_500 });
  expect(evaluateLocalEndReclaim(T0, clientBound, T0 + 500)).toEqual({ reclaimable: true, notBeforeMs: T0 + 500 });
});

it("judge: process-group exit and the owner's local end are both proof; the earliest due proof wins; none means unproven", () => {
  const exited = [event("owner_opened", 0, 0), event("spawn_intent", 1, 100), event("spawned", 1, 200, 4242), event("group_exited", 1, 9_000, 4242)];
  const base = { state: "indeterminate" as const, dispatchAtMs: T0 + 1_000, bindingHash: null, owner };
  const local = { endedAtMs: T0 + 2_000, owner, bindingHash: null, dispatches: 1, terminals: 1 };
  expect(judgeModelReclaim({ ...base, events: [], localEnd: null }, clientBound, T0 + 60_000))
    .toEqual({ status: "unproven", evidence: null, reason: "owner_not_opened_before_dispatch", notBeforeMs: null });
  expect(judgeModelReclaim({ ...base, events: [], localEnd: null }, undefined, T0 + 60_000))
    .toEqual({ status: "unproven", evidence: null, reason: "owner_not_opened_before_dispatch", notBeforeMs: null });
  expect(judgeModelReclaim({ ...base, events: [], localEnd: local }, undefined, T0 + 60_000))
    .toEqual({ status: "policy_blocked", evidence: "local_call_ended", reason: "provider_deadline_unknown", notBeforeMs: null });
  expect(judgeModelReclaim({ ...base, events: exited, localEnd: local }, clientBound, T0 + 2_499))
    .toEqual({ status: "waiting", evidence: "local_call_ended", reason: "waiting", notBeforeMs: T0 + 2_500 });
  expect(judgeModelReclaim({ ...base, events: exited, localEnd: local }, clientBound, T0 + 2_500))
    .toEqual({ status: "reclaimable", evidence: "local_call_ended", reason: null, notBeforeMs: T0 + 2_500 });
  expect(judgeModelReclaim({ ...base, events: exited, localEnd: null }, clientBound, T0 + 9_500))
    .toEqual({ status: "reclaimable", evidence: "process_group_exit", reason: null, notBeforeMs: T0 + 9_500 });
  // dispatched 행의 로컬 종료 사실·다른 owner/binding 의 사실은 근거가 아니다.
  expect(judgeModelReclaim({ ...base, state: "dispatched", events: [], localEnd: local }, clientBound, T0 + 60_000).status).toBe("unproven");
  expect(judgeModelReclaim({ ...base, events: [], localEnd: { ...local, owner: { ...owner, instanceId: "other" } } }, clientBound, T0 + 60_000))
    .toEqual({ status: "unproven", evidence: null, reason: "local_end_owner_mismatch", notBeforeMs: null });
  expect(judgeModelReclaim({ ...base, events: [], localEnd: { ...local, bindingHash: "a".repeat(64) } }, clientBound, T0 + 60_000))
    .toEqual({ status: "unproven", evidence: null, reason: "local_end_binding_mismatch", notBeforeMs: null });
  expect(judgeModelReclaim({ ...base, dispatchAtMs: null, events: exited, localEnd: null }, clientBound, T0 + 60_000))
    .toEqual({ status: "unproven", evidence: null, reason: "dispatch_time_unknown", notBeforeMs: null });
});

const local = { version: 1, kind: "local_call_ended", requestId, owner, fromState: "indeterminate", dispatchAt: at(T0), bindingHash: null,
  termination: "provider_bound", hardDeadlineMs: 60_000, skewBoundMs: 1_000, reference: "gateway hard timeout", endedAt: at(T0 + 5_000),
  localEnd: { dispatches: 1, terminals: 1 }, notBefore: at(T0 + 66_000), evaluatedAt: at(T0 + 66_000), operator: "root" };
it("local_call_ended release evidence: only from indeterminate, due, bound to a proven deadline and a complete native end", () => {
  expect(modelDispatchReleaseEvidenceSchema.safeParse(local).success).toBe(true);
  expect(modelDispatchReleaseEvidenceSchema.safeParse({ ...local, termination: "client_bound", hardDeadlineMs: null }).success).toBe(true);
  for (const change of [{ fromState: "dispatched" }, { evaluatedAt: at(T0 + 65_999) }, { hardDeadlineMs: null }, { termination: "client_bound" },
    { dispatchAt: null }, { endedAt: at(T0 + 66_001) }, { localEnd: { dispatches: 2, terminals: 1 } }, { localEnd: { dispatches: 0, terminals: 0 } },
    { endedAt: "2026-10-17" }, { extra: true }])
    expect(modelDispatchReleaseEvidenceSchema.safeParse({ ...local, ...change }).success).toBe(false);
  const fact = { version: 1, kind: "gateway_local_end", requestId, owner, bindingHash: null, dispatches: 1, terminals: 1 };
  expect(gatewayLocalEndFactSchema.safeParse(fact).success).toBe(true);
  for (const change of [{ terminals: 0 }, { dispatches: 0, terminals: 0 }, { kind: "process_exit" }, { owner: { instanceId: "x" } }, { extra: 1 }])
    expect(gatewayLocalEndFactSchema.safeParse({ ...fact, ...change }).success).toBe(false);
});

it("HTTP hop release evidence: client-bound process-group exit only, due and with at least one exit", () => {
  const hop = { version: 1, kind: "process_group_exit", hopId: requestId, owner, fromState: "dispatched", dispatchAt: at(T0), termination: "client_bound",
    skewBoundMs: 1, reference: "fixture", exits: [{ seq: 1, runId, pid: 4242, exitedAt: at(T0 + 10) }], notBefore: at(T0 + 11), evaluatedAt: at(T0 + 11), operator: "root" };
  expect(httpHopReleaseEvidenceSchema.safeParse(hop).success).toBe(true);
  for (const change of [{ termination: "provider_bound" }, { exits: [] }, { evaluatedAt: at(T0 + 10) }, { fromState: "reserved" }, { kind: "ttl" }, { extra: 1 }])
    expect(httpHopReleaseEvidenceSchema.safeParse({ ...hop, ...change }).success).toBe(false);
});

it("process-group owner env: only the recorded owner of this exact instance passes its boot to the child", () => {
  expect(processGroupOwnerEnvironment(owner)).toEqual({ PROCESS_GROUP_OWNER_INSTANCE_ID: "m3-text", PROCESS_GROUP_OWNER_BOOT_ID: boot });
  const env = processGroupOwnerEnvironment(owner);
  expect(processGroupBootFor("m3-text", env)).toBe(boot);
  expect(processGroupBootFor("m3-other", env)).toBeNull();
  expect(processGroupBootFor(undefined, env)).toBeNull();
  expect(processGroupBootFor("m3-text", {})).toBeNull();
  expect(processGroupBootFor("m3-text", { ...env, PROCESS_GROUP_OWNER_BOOT_ID: "not-a-uuid" })).toBeNull();
  expect(() => processGroupOwnerEnvironment({ instanceId: " bad", bootId: boot })).toThrow();
});

it("parses reclaim-report (read-only) and reclaim (dry-run unless --apply) with stdin URL and operator policies", () => {
  expect(parsePromotionCliArgs(["reclaim-report", "--deadline=acct:60000", "--client-bound=local", "--skew-ms=500", "--database-url-stdin"]))
    .toEqual({ command: "reclaim-report", skewBoundMs: 500, policies: new Map([["acct", { termination: "provider_bound", hardDeadlineMs: 60_000, skewBoundMs: 500 }],
      ["local", { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 500 }]]) });
  expect(parsePromotionCliArgs(["reclaim", "--client-bound=local", "--reference=gateway closes on disconnect", "--operator=root", "--database-url-stdin"]))
    .toEqual({ command: "reclaim", apply: false, skewBoundMs: 1_000, operator: "root", reference: "gateway closes on disconnect",
      policies: new Map([["local", { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1_000, reference: "gateway closes on disconnect" }]]) });
  expect(parsePromotionCliArgs(["reclaim", "--reference=r", "--operator=root", "--apply", "--database-url-stdin"]))
    .toMatchObject({ command: "reclaim", apply: true, policies: new Map() });
  expect(() => parsePromotionCliArgs(["reclaim", "--operator=root", "--database-url-stdin"])).toThrow("dr_cli_missing_reference");
  expect(() => parsePromotionCliArgs(["reclaim-report", "--apply", "--database-url-stdin"])).toThrow("dr_cli_unknown_option");
  expect(() => parsePromotionCliArgs(["reclaim", "--reference=r", "--operator=root", "--ttl-ms=1", "--database-url-stdin"])).toThrow("dr_cli_unknown_option");
});

// 실제 loopback HTTP — 전송·dispatcher 모의 없음. 증인은 native dispatch 의 종료 callback 을 모두 본 뒤에만 나온다.
let http: Server, port = 0, reply: (response: ServerResponse) => void = response => response.end("ok");
beforeAll(async () => {
  http = createServer((_request, response) => reply(response));
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;
});
afterAll(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
afterEach(() => { vi.unstubAllEnvs(); reply = response => response.end("ok"); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("gateway local end: default off keeps the original transport and records nothing; unknown flags fail closed", async () => {
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", undefined);
  expect(gatewayLocalEndTrackingEnabled()).toBe(false);
  expect(await (await gatewayFetch(id(1), `http://127.0.0.1:${port}/`, { method: "POST", body: "{}" })).text()).toBe("ok");
  expect(takeGatewayLocalEnd(id(1))).toBeNull();
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "yes");
  expect(() => gatewayLocalEndTrackingEnabled()).toThrow("invalid_model_capacity_local_end");
});

it("gateway local end: a timed-out request yields one one-use witness only after every native dispatch ended", async () => {
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
  reply = () => {}; // 응답하지 않는다 — 시간 제한이 요청 소켓을 끊는다.
  await expect(gatewayFetch(id(2), `http://127.0.0.1:${port}/`, { method: "POST", body: "{}", signal: AbortSignal.timeout(150) })).rejects.toThrow();
  await vi.waitFor(() => expect(takeGatewayLocalEnd(id(2))).toEqual({ requestId: id(2), dispatches: 1, terminals: 1 }));
  expect(takeGatewayLocalEnd(id(2))).toBeNull();
});

it("gateway local end: a fully read response is a local end; an unread body and a never-dispatched request are not", async () => {
  vi.stubEnv("MODEL_CAPACITY_LOCAL_END", "1");
  expect(await (await gatewayFetch(id(3), `http://127.0.0.1:${port}/`, { method: "POST", body: "{}" })).text()).toBe("ok");
  expect(takeGatewayLocalEnd(id(3))).toEqual({ requestId: id(3), dispatches: 1, terminals: 1 });
  let finish!: () => void;
  reply = response => { response.writeHead(200); response.write("partial"); finish = () => response.end(); };
  const open = await gatewayFetch(id(4), `http://127.0.0.1:${port}/`, { method: "POST", body: "{}" });
  expect(takeGatewayLocalEnd(id(4))).toBeNull(); // 본문이 아직 오가는 중
  finish(); expect(await open.text()).toBe("partial");
  const aborted = new AbortController(); aborted.abort();
  await expect(gatewayFetch(id(5), `http://127.0.0.1:${port}/`, { method: "POST", body: "{}", signal: aborted.signal })).rejects.toThrow();
  expect(takeGatewayLocalEnd(id(5))).toBeNull();
});
