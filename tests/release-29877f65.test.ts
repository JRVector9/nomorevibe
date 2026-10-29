import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readReplacedProviderBoundaryReleaseFiles } from "@/scripts/ops/model-replaced-provider-boundary-release";
import { bundleChecks, buildPlan, buildReceipt, offlineVerify, RELAY_REQUEST_ID, REQUEST_ID, type DbFacts } from "@/scripts/ops/release-29877f65/assemble";
import { pythonJsonDumps, reconstructOriginalWire, relayWireFromOriginal, sha256 } from "@/scripts/ops/release-29877f65/wire";
import source from "./fixtures/release-29877f65-source.json";

/** Synthetic DB/bundle facts only (no production receipt); the product text fixture is the real public source of 29877f65. */
const members = source.members as never;
const iso = (ms: number) => new Date(ms).toISOString();
const h = (v: string) => sha256(v);
function material(overrides: { now?: number } = {}) {
  const now = overrides.now ?? Date.now(), dispatch = now - 2 * 3_600_000, created = now - 60_000;
  const runId = "6f1c6f8e-3b8e-4c55-9c39-8d2f8a0b1c11";
  const facts: DbFacts = { now: iso(created), replica: false, readOnly: "on",
    control: { mode: "draining", epoch: 1, revision: 7, policyHash: h("policy"), updatedAt: iso(created - 30_000).replace("Z", "000Z") },
    fence: { state: "active", lineageId: "0b9d7c1e-2f4a-4b8e-9a51-6f0e2d3c4b5a", writerEpoch: 1 },
    row: { requestId: REQUEST_ID, state: "indeterminate", ownerInstanceId: "m3-text", ownerBootId: "a3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", epoch: 1, revision: 7,
      policyHash: h("policy"), bindingHash: h("binding"), providerBudgetId: "abcllm-m1", groupId: "m1", routeId: "product-translate", provider: "abcllm",
      model: source.model, settled: false, terminalNull: true, tokenNull: false, tokenHash: h("token"), rowHash: h("row"), dispatchAt: iso(dispatch),
      dispatchMsExact: true, bindingHashOk: true,
      binding: { kind: "product_translation_gateway", members, wireHash: source.wireHash, servingContractHash: h("contract"), totalTokenBound: 40768, chargedTokens: 40768 } },
    events: [
      { id: 1932, kind: "owner_opened", seq: 0, runId: null, runIdHash: null, pid: null, method: null, recordedAt: iso(dispatch - 9e6), beforeDispatch: true, atOrBeforeDispatch: true, atOrAfterDispatch: false },
      { id: 1933, kind: "spawn_intent", seq: 1, runId, runIdHash: h(runId), pid: null, method: null, recordedAt: iso(dispatch - 1e3), beforeDispatch: true, atOrBeforeDispatch: true, atOrAfterDispatch: false },
      { id: 1934, kind: "spawned", seq: 1, runId, runIdHash: h(runId), pid: 52, method: null, recordedAt: iso(dispatch - 900), beforeDispatch: true, atOrBeforeDispatch: true, atOrAfterDispatch: false },
      { id: 1967, kind: "group_exited", seq: 1, runId, runIdHash: h(runId), pid: 52, method: "pgid_esrch_after_sigkill", recordedAt: iso(dispatch + 21e3), beforeDispatch: false, atOrBeforeDispatch: false, atOrAfterDispatch: true }],
    localEnds: [{ id: 156477, evidenceHash: h("local-end"), fromState: "indeterminate", toState: "indeterminate", createdAt: iso(dispatch + 20e3), afterDispatch: true }],
    products: source.products, schema: { has0143: true, guardTrigger: true, drizzleRows: 145 } };
  const wire = reconstructOriginalWire(members, source.products, source.model);
  if (!wire.ok) throw new Error("fixture");
  const capture = (name: string, i: number) => ({ serviceId: `svc${i}`, serviceName: name, replicas: 1, observedAt: iso(now - 5_000 + i),
    containers: [{ id: sha256(`container-${i}`), name: `/${name}.1`, image: "img", taskId: `task${i}`, running: true, startedAt: iso(now - 1_800_000).replace("Z", "456789Z"), privileged: false, pidMode: "" }],
    tasks: [{ ID: `task${i}`, DesiredState: "Running", CurrentState: "Running 30 minutes ago" }, { ID: `old${i}`, DesiredState: "Shutdown", CurrentState: "Shutdown 30 minutes ago" }] });
  const file = (value: unknown) => { const bytes = Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`); return { path: "/x", size: bytes.length, sha256: sha256(bytes), base64: bytes.toString("base64") }; };
  const docker = [
    { kind: "nmv-release-29877f65-docker-bundle", host: "m3ultra", serviceList: [], services: [
      { role: "owner", capture: capture("nomorevibe-text-m3-ebmybu", 0), endpointPorts: [], networks: [] },
      { role: "gateway-m3", capture: capture("app-reboot-optical-matrix-3bl2a4", 1), endpointPorts: [], networks: [] }],
      gatewaySource: { containerId: sha256("container-1"), files: [file("def proxy(): pass\n")] } },
    { kind: "nmv-release-29877f65-docker-bundle", host: "9mini", serviceList: [], services: [
      { role: "gateway-mini", capture: capture("app-hack-optical-monitor-v1ioak", 2), endpointPorts: [], networks: [] }] }];
  const relayGeneration = "1e17bc89-df34-42c6-9a1e-61b7f381d388", restored = "5a0f3c2e-8b1d-4e6f-9a2b-3c4d5e6f7a8b";
  const receipt = file({ protocol: 1, requestId: RELAY_REQUEST_ID, relayGeneration, requestModel: "qwen3.8-flash-next",
    requestHash: sha256(relayWireFromOriginal(wire.wire, "qwen3.8-flash-next")), startedAt: iso(dispatch + 3_000), state: "indeterminate", endedAt: iso(dispatch + 93_000), error: "upstream_timeout" });
  const relayStart = Math.floor((now - 3_600_000) / 1000) * 1000;
  const recovery = file({ kind: "m1-original-request-relay-recovery", relayRequestId: RELAY_REQUEST_ID, originalReceiptSha256: receipt.sha256, originalRelayGeneration: relayGeneration,
    restored: { relayGeneration: restored }, newRelayPid: 40297, nativeExit: { oldPidESRCH: true, processGroupESRCH: true },
    relayExit: { oldPidESRCH: true, processGroupESRCH: true, allKnownDescendantsESRCH: true },
    originalNativeIdentity: { pid: 47047, startedAt: iso(dispatch - 7_200_000) }, nativeRestarted: false, completedAt: iso(relayStart + 60_000) });
  const m1 = { kind: "nmv-release-29877f65-m1-bundle", euid: 0, observedAt: iso(now - 2_000), receipt, recoveryCandidates: [recovery],
    relayState: { activeJsonPresent: false }, launchd: { state: "running", pid: "40297" },
    relayProcess: { pid: 40297, startedAt: iso(relayStart) }, nativeProcess: { pid: 48000, startedAt: iso(relayStart) },
    nativeModels: { status: 200, ids: ["mlx-community--gemma-4-26b-a4b-it-4bit"] }, originalModel: { pid: 47047, pidPresent: false, groupPresent: false }, recentReceipts: [] };
  return { facts, docker, m1, now };
}

describe("29877f65 wire reconstruction", () => {
  it("reproduces the ledger wireHash and the original relay requestHash from the dispatch-time public text", () => {
    const wire = reconstructOriginalWire(members, source.products, source.model);
    expect(wire.ok && wire.wireHash).toBe(source.wireHash);
    expect(wire.ok && sha256(relayWireFromOriginal(wire.wire, "qwen3.8-flash-next"))).toBe(source.relayRequestHash);
  });
  it("refuses when any source text changed instead of inferring the old body", () => {
    const products = source.products.map((p, i) => i === 0 ? { ...p, tagline: `${p.tagline}.`, description: `${p.description}.` } : p);
    const wire = reconstructOriginalWire(members, products, source.model);
    expect(wire.ok).toBe(false);
    expect(wire.sources.some(s => !s.matches)).toBe(true);
  });
  it("serializes like Python json.dumps defaults", () => {
    expect(pythonJsonDumps({ a: "한\u0001\"😀", b: [1, true, null], t: 0 }, new Set(["t"]))).toBe('{"a": "\\ud55c\\u0001\\"\\ud83d\\ude00", "b": [1, true, null], "t": 0.0}');
  });
});

describe("29877f65 plan/receipt assembly", () => {
  it("builds artifacts accepted by the release CLI parser and the evidence predicate", () => {
    const { facts, docker, m1 } = material();
    const plan = buildPlan(facts, "29877f65 replaced boundary review");
    const built = buildReceipt(plan.plan, plan.originalWire, docker, m1, { m3ultra: "a".repeat(64), "9mini": "b".repeat(64), m1: "c".repeat(64) }, "operator");
    const artifacts = new Map([...plan.artifacts, ...built.artifacts]);
    const read = (hash: string) => artifacts.get(hash) ?? Buffer.alloc(0);
    expect(offlineVerify(plan.plan, built.receipt, read, "operator", new Date().toISOString()).filter(c => !c.ok)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "release-29877f65-")), art = join(dir, "artifacts");
    mkdirSync(art, { mode: 0o700 });
    for (const [hash, bytes] of artifacts) writeFileSync(join(art, `${hash}.json`), bytes, { mode: 0o600 });
    const planBytes = Buffer.from(`${JSON.stringify(plan.plan)}\n`), receiptBytes = Buffer.from(`${JSON.stringify(built.receipt)}\n`);
    writeFileSync(join(dir, "plan.json"), planBytes, { mode: 0o600 }); writeFileSync(join(dir, "receipt.json"), receiptBytes, { mode: 0o600 });
    const parsed = readReplacedProviderBoundaryReleaseFiles([`--plan=${join(dir, "plan.json")}`, `--plan-sha=${sha256(planBytes)}`, `--receipt=${join(dir, "receipt.json")}`,
      `--receipt-sha=${sha256(receiptBytes)}`, `--artifact-dir=${art}`, "--operator=operator", "--reference=29877f65 replaced boundary review", "--database-url-stdin"]);
    expect(parsed.apply).toBe(false);
    expect(built.receipt.relay.currentGeneration).toBe("5a0f3c2e-8b1d-4e6f-9a2b-3c4d5e6f7a8b");
    expect(built.receipt.containers[0].startedAt).toMatch(/\.\d{3}Z$/);
  });
  it("plans only while DRAINING and only with an owner group exit after dispatch", () => {
    const open = material(); open.facts.control.mode = "open";
    expect(() => buildPlan(open.facts, "r")).toThrow("release_29877f65_plan_blocked");
    const early = material(); early.facts.events[3].atOrAfterDispatch = false;
    expect(() => buildPlan(early.facts, "r")).toThrow("release_29877f65_plan_blocked");
    const inexact = material(); inexact.facts.row!.dispatchMsExact = false;
    expect(() => buildPlan(inexact.facts, "r")).toThrow("release_29877f65_plan_blocked");
  });
  it("blocks pre-dispatch containers, live predecessors, a restarted relay and a still-listed Qwen", () => {
    const failing = (mutate: (m: ReturnType<typeof material>) => void) => {
      const m = material(); mutate(m);
      return bundleChecks(m.facts.row!.dispatchAt, m.docker, m.m1).filter(c => !c.ok).map(c => c.name);
    };
    expect(failing(m => { m.docker[0].services[0].capture.containers[0].startedAt = iso(m.now - 3 * 3_600_000); })).toContain("owner_started_after_dispatch");
    expect(failing(m => { m.docker[1].services[0].capture.tasks[1].CurrentState = "Running 3 days ago"; })).toContain("gateway-mini_no_live_predecessor_task");
    // e.g. the relay was bootout/bootstrapped for the Gemma handoff after recovery: new PID != recovery.newRelayPid.
    expect(failing(m => { m.m1.relayProcess.pid = 50001; m.m1.launchd.pid = "50001"; })).toContain("m1_current_relay_is_recovered_process");
    expect(failing(m => { m.m1.nativeModels.ids.push("qwen3.8-flash-next"); })).toContain("m1_native_model_replaced");
    expect(failing(m => { m.m1.originalModel.groupPresent = true; })).toContain("m1_original_model_pid_and_group_absent");
  });
  it("refuses bundles collected before the plan", () => {
    const { facts, docker, m1, now } = material();
    const plan = buildPlan(facts, "r");
    m1.observedAt = iso(now - 120_000);
    expect(() => buildReceipt(plan.plan, plan.originalWire, docker, m1, {}, "operator")).toThrow("release_29877f65_receipt_blocked");
  });
});
