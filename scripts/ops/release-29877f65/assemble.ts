/** 29877f65 단건 해제 입력 조립기. DB는 READ ONLY 트랜잭션으로만 읽고, 원격 장비에 접속하지 않는다.
 *  preflight: 지금(OPEN·0143 전) 확인 가능한 근거 점검. plan: DRAINING에서만 plan.json+artifact 작성.
 *  receipt: plan 이후 수집한 세 묶음으로 receipt.json+artifact 작성 후 정식 CLI와 같은 오프라인 검증.
 *  DB 쓰기·해제는 정식 scripts/ops/model-replaced-provider-boundary-release.ts만 한다(dry-run 기본, --apply). */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replacedProviderEvidenceSchema, replacedProviderPlanHash, replacedProviderPlanSchema, replacedProviderReceiptSchema,
  type ReplacedProviderPlan, type ReplacedProviderReceipt } from "@/lib/llm/replaced-provider-boundary-contract";
import { verifyReplacedProviderArtifacts } from "../replaced-provider-boundary-artifacts";
import { ORIGINAL_SOURCE_COMMIT, reconstructOriginalWire, relayWireFromOriginal, sha256, type BindingMember, type ProductSource } from "./wire";

export const REQUEST_ID = "29877f65-9f95-4efb-88f9-aea5f39a28b2";
export const RELAY_REQUEST_ID = "6571d6c8-002f-4f5f-b399-47e40876ee43";
const REQUEST_MODEL = "qwen3.8-flash-next", ORIGINAL_MODEL = "[m1] qwen3.8-flash-next";
const ROLES = [["owner", "m3ultra", "nomorevibe-text-m3-ebmybu"], ["gateway-m3", "m3ultra", "app-reboot-optical-matrix-3bl2a4"],
  ["gateway-mini", "9mini", "app-hack-optical-monitor-v1ioak"]] as const;
const msIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_TASK = /^(?:Shutdown|Failed|Complete|Rejected|Remove)\b/;

export type Check = { name: string; ok: boolean; detail?: unknown };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** DB facts read in one REPEATABLE READ READ ONLY transaction. Column text is exactly what the DB trigger re-reads. */
export type DbFacts = {
  now: string; replica: boolean; readOnly: string;
  control: { mode: string; epoch: number; revision: number; policyHash: string; updatedAt: string };
  fence: { state: string; lineageId: string; writerEpoch: number };
  row: { requestId: string; state: string; ownerInstanceId: string; ownerBootId: string; epoch: number; revision: number; policyHash: string;
    bindingHash: string; binding: Json; providerBudgetId: string; groupId: string; routeId: string; provider: string; model: string;
    settled: boolean; terminalNull: boolean; tokenNull: boolean; tokenHash: string; rowHash: string; dispatchAt: string;
    dispatchMsExact: boolean; bindingHashOk: boolean } | null;
  events: { id: number; kind: string; seq: number; runIdHash: string | null; runId: string | null; pid: number | null; method: string | null;
    recordedAt: string; beforeDispatch: boolean; atOrBeforeDispatch: boolean; atOrAfterDispatch: boolean }[];
  localEnds: { id: number; evidenceHash: string; fromState: string; toState: string; createdAt: string; afterDispatch: boolean }[];
  products: ProductSource[];
  schema: { has0143: boolean; guardTrigger: boolean; drizzleRows: number | null };
};

export function originalOwnerFrom(f: DbFacts): { owner: Omit<ReplacedProviderPlan["originalOwner"], "artifactHash"> | null; checks: Check[] } {
  const checks: Check[] = [], r = f.row!;
  const opened = f.events.filter(e => e.kind === "owner_opened" && e.seq === 0 && e.beforeDispatch);
  const intents = f.events.filter(e => e.kind === "spawn_intent");
  const possible = intents.filter(e => e.atOrBeforeDispatch);
  const maxSeq = Math.max(0, ...intents.map(e => e.seq));
  checks.push({ name: "owner_opened_before_dispatch", ok: opened.length === 1, detail: opened.map(e => e.id) });
  checks.push({ name: "owner_spawn_intents_contiguous", ok: intents.length === maxSeq && possible.length >= 1, detail: { intents: intents.length, maxSeq, possible: possible.length } });
  const groups = possible.map(intent => {
    const spawned = f.events.filter(e => e.kind === "spawned" && e.seq === intent.seq && e.runId === intent.runId);
    const exited = f.events.filter(e => e.kind === "group_exited" && e.seq === intent.seq && e.runId === intent.runId
      && e.method === "pgid_esrch_after_sigkill" && e.atOrAfterDispatch && spawned.length === 1 && e.pid === spawned[0].pid);
    const ok = spawned.length === 1 && exited.length === 1 && intent.runIdHash !== null;
    checks.push({ name: `owner_group_${intent.seq}_spawned_and_exited_after_dispatch`, ok, detail: { intent: intent.id, spawned: spawned.map(e => e.id), exited: exited.map(e => e.id) } });
    return ok ? { seq: intent.seq, pid: spawned[0].pid!, runIdHash: intent.runIdHash!, spawnIntentEventId: intent.id, spawnedEventId: spawned[0].id, exitEventId: exited[0].id } : null;
  });
  const localEnd = f.localEnds.filter(e => e.fromState === "indeterminate" && e.toState === "indeterminate" && e.afterDispatch);
  checks.push({ name: "request_local_end_recorded", ok: localEnd.length === 1 && f.localEnds.length === 1, detail: f.localEnds.map(e => e.id) });
  if (!checks.every(c => c.ok) || groups.some(g => !g)) return { owner: null, checks };
  return { owner: { kind: "durable_process_group_exit", instanceId: r.ownerInstanceId, bootId: r.ownerBootId, openedEventId: opened[0].id,
    groups: groups as NonNullable<(typeof groups)[number]>[], localEndEventId: localEnd[0].id, localEndEvidenceHash: localEnd[0].evidenceHash }, checks };
}

/** Request-row checks that the 0143 trigger repeats. Both OPEN (preflight) and DRAINING (plan) use them. */
export function rowChecks(f: DbFacts): Check[] {
  const r = f.row, b = r?.binding ?? {};
  return [
    { name: "primary_read_only_snapshot", ok: f.replica === false && f.readOnly === "on" },
    { name: "writer_fence_active", ok: f.fence.state === "active" },
    { name: "request_present_indeterminate_unsettled", ok: !!r && r.state === "indeterminate" && !r.settled && r.terminalNull && !r.tokenNull },
    { name: "request_route_provider_model", ok: !!r && r.routeId === "product-translate" && r.provider === "abcllm" && r.model === ORIGINAL_MODEL },
    { name: "binding_product_translation_gateway", ok: b.kind === "product_translation_gateway" && b.totalTokenBound === b.chargedTokens
      && Number.isSafeInteger(b.chargedTokens) && b.chargedTokens > 0 && /^[a-f0-9]{64}$/.test(String(b.wireHash)) && /^[a-f0-9]{64}$/.test(String(b.servingContractHash)) },
    { name: "binding_hash_canonical", ok: !!r?.bindingHashOk },
    { name: "dispatch_at_millisecond_exact", ok: !!r?.dispatchMsExact, detail: r?.dispatchAt },
  ];
}

export function buildPlan(f: DbFacts, reference: string): { plan: ReplacedProviderPlan; artifacts: Map<string, Buffer>; originalWire: string; checks: Check[] } {
  const checks = [...rowChecks(f), { name: "capacity_draining", ok: f.control.mode === "draining", detail: f.control.mode }];
  const owner = originalOwnerFrom(f); checks.push(...owner.checks);
  const r = f.row, b = r?.binding ?? {};
  const wire = r ? reconstructOriginalWire(b.members as BindingMember[], f.products, r.model) : null;
  checks.push({ name: "original_wire_reconstructed_matches_ledger", ok: !!wire?.ok && wire.wireHash === b.wireHash,
    detail: { sourceCommit: ORIGINAL_SOURCE_COMMIT, sources: wire?.sources.map(s => ({ productId: s.productId, field: s.field, matches: s.matches })), wireHash: wire?.ok ? wire.wireHash : null } });
  if (!checks.every(c => c.ok) || !r || !owner.owner || !wire?.ok) throw Object.assign(new Error("release_29877f65_plan_blocked"), { checks });
  const artifacts = new Map<string, Buffer>();
  const put = (bytes: Buffer) => { const h = sha256(bytes); artifacts.set(h, bytes); return h; };
  const ownerArtifact = put(Buffer.from(`${JSON.stringify({ kind: "nmv-release-29877f65-original-owner", requestId: r.requestId, readAt: f.now, originalOwner: owner.owner })}\n`));
  put(Buffer.from(wire.wire, "utf8"));
  const plan = replacedProviderPlanSchema.parse({ version: 1, kind: "replaced_provider_boundary_plan", createdAt: f.now, reviewReference: reference,
    request: { requestId: r.requestId, owner: { instanceId: r.ownerInstanceId, bootId: r.ownerBootId }, state: "indeterminate", tokenHash: r.tokenHash,
      epoch: r.epoch, revision: r.revision, policyHash: r.policyHash, bindingHash: r.bindingHash, dispatchAt: r.dispatchAt,
      providerBudgetId: r.providerBudgetId, groupId: r.groupId, servingContractHash: b.servingContractHash,
      rowHash: r.rowHash, wireHash: b.wireHash, chargedTokens: b.chargedTokens },
    control: f.control, writer: { lineageId: f.fence.lineageId, writerEpoch: f.fence.writerEpoch },
    originalOwner: { ...owner.owner, artifactHash: ownerArtifact } });
  return { plan, artifacts, originalWire: wire.wire, checks };
}

const decode = (entry: Json) => {
  const bytes = Buffer.from(entry.base64, "base64");
  if (sha256(bytes) !== entry.sha256) throw new Error("release_29877f65_bundle_entry_hash");
  return bytes;
};

/** Bundle facts that must hold before any DRAIN; also the receipt preconditions. `dispatchAt` from the ledger row. */
export function bundleChecks(dispatchAt: string, docker: Json[], m1: Json | null): Check[] {
  const checks: Check[] = [];
  for (const [role, host, name] of ROLES) {
    const bundle = docker.find(d => d.kind === "nmv-release-29877f65-docker-bundle" && d.host === host);
    const service = bundle?.services?.find((s: Json) => s.role === role);
    const c = service?.capture, active = c?.containers ?? [], tasks: Json[] = c?.tasks ?? [];
    const started = active.length === 1 ? new Date(active[0].startedAt).toISOString() : null;
    const running = tasks.filter(t => t.DesiredState === "Running");
    checks.push({ name: `${role}_single_current_container`, ok: !!c && c.serviceName === name && c.replicas === 1 && active.length === 1 && active[0].running === true
      && active[0].privileged === false && active[0].pidMode === "" && /^[a-f0-9]{64}$/.test(active[0].id), detail: { host, containers: active.length } });
    checks.push({ name: `${role}_started_after_dispatch`, ok: !!started && started > dispatchAt, detail: started });
    checks.push({ name: `${role}_no_live_predecessor_task`, ok: running.length === 1 && running[0].ID === active[0]?.taskId
      && tasks.every(t => t.ID === active[0]?.taskId || TERMINAL_TASK.test(String(t.CurrentState))),
      detail: tasks.map(t => `${String(t.ID).slice(0, 12)}:${t.DesiredState}:${t.CurrentState}`) });
  }
  const gw = docker.find(d => d.host === "m3ultra")?.gatewaySource;
  checks.push({ name: "gateway_source_snapshot", ok: !!gw?.files?.length && gw.files.every((f: Json) => { try { return decode(f).length > 0; } catch { return false; } }) });
  if (!m1) return checks;
  const receipt = (() => { try { return JSON.parse(decode(m1.receipt).toString("utf8")); } catch { return null; } })();
  const recovery = (() => { try { return m1.recoveryCandidates?.length === 1 ? JSON.parse(decode(m1.recoveryCandidates[0]).toString("utf8")) : null; } catch { return null; } })();
  const relay = m1.relayProcess, native = m1.nativeProcess, ids: string[] = m1.nativeModels?.ids ?? [];
  checks.push({ name: "m1_collected_as_root", ok: m1.kind === "nmv-release-29877f65-m1-bundle" && m1.euid === 0 });
  checks.push({ name: "m1_original_relay_receipt_indeterminate_timeout", ok: !!receipt && receipt.requestId === RELAY_REQUEST_ID && receipt.requestModel === REQUEST_MODEL
    && receipt.state === "indeterminate" && receipt.error === "upstream_timeout" && msIso.test(receipt.startedAt) && msIso.test(receipt.endedAt) && receipt.startedAt >= dispatchAt,
    detail: receipt && { startedAt: receipt.startedAt, endedAt: receipt.endedAt, state: receipt.state, error: receipt.error } });
  checks.push({ name: "m1_recovery_proof_single_and_bound_to_receipt", ok: !!recovery && recovery.originalReceiptSha256 === m1.receipt.sha256
    && recovery.originalRelayGeneration === receipt?.relayGeneration && recovery.nativeRestarted === false
    && recovery.nativeExit?.oldPidESRCH === true && recovery.nativeExit?.processGroupESRCH === true
    && recovery.relayExit?.oldPidESRCH === true && recovery.relayExit?.processGroupESRCH === true && recovery.relayExit?.allKnownDescendantsESRCH === true,
    detail: { candidates: m1.recoveryCandidates?.length ?? 0 } });
  checks.push({ name: "m1_original_model_identity_millisecond", ok: !!recovery && Number.isSafeInteger(recovery.originalNativeIdentity?.pid)
    && msIso.test(String(recovery.originalNativeIdentity?.startedAt)) && recovery.originalNativeIdentity.startedAt <= dispatchAt, detail: recovery?.originalNativeIdentity });
  checks.push({ name: "m1_current_relay_is_recovered_process", ok: !!relay && !!recovery && String(m1.launchd?.pid) === String(relay.pid)
    && relay.pid === recovery.newRelayPid && m1.launchd?.state === "running" && !!receipt && relay.startedAt > receipt.endedAt
    && Date.parse(recovery.completedAt) >= Date.parse(relay.startedAt) && typeof recovery.restored?.relayGeneration === "string",
    detail: { launchdPid: m1.launchd?.pid, relayPid: relay?.pid, recoveryPid: recovery?.newRelayPid, relayStartedAt: relay?.startedAt, recoveryCompletedAt: recovery?.completedAt } });
  checks.push({ name: "m1_native_model_replaced", ok: !!native && !!recovery && native.pid !== recovery.originalNativeIdentity?.pid && !!receipt
    && native.startedAt > receipt.endedAt && ids.length > 0 && !ids.includes(REQUEST_MODEL) && ids.join(",").length <= 200,
    detail: { nativePid: native?.pid, nativeStartedAt: native?.startedAt, models: ids } });
  checks.push({ name: "m1_original_model_pid_and_group_absent", ok: m1.originalModel?.pidPresent === false && m1.originalModel?.groupPresent === false, detail: m1.originalModel });
  return checks;
}

/** Container capture and reviewed topology artifacts, relay receipt/recovery raw bytes, composed current relay artifact. */
export function buildReceipt(plan: ReplacedProviderPlan, originalWire: string, docker: Json[], m1: Json, bundleShas: Record<string, string>, reviewer: string) {
  const checks = bundleChecks(plan.request.dispatchAt, docker, m1);
  checks.push({ name: "bundles_collected_after_plan", ok: [...docker.flatMap(d => d.services.map((s: Json) => s.capture.observedAt)), m1.observedAt]
    .every(at => msIso.test(at) && at >= plan.createdAt) });
  const relayWire = relayWireFromOriginal(originalWire, REQUEST_MODEL);
  const receiptRaw = decode(m1.receipt), original = JSON.parse(receiptRaw.toString("utf8"));
  checks.push({ name: "relay_wire_matches_receipt_request_hash", ok: sha256(relayWire) === original.requestHash && sha256(originalWire) === plan.request.wireHash });
  if (!reviewer.trim()) checks.push({ name: "topology_reviewed_by_operator", ok: false });
  if (!checks.every(c => c.ok)) throw Object.assign(new Error("release_29877f65_receipt_blocked"), { checks });
  const artifacts = new Map<string, Buffer>();
  const put = (bytes: Buffer) => { const h = sha256(bytes); artifacts.set(h, bytes); return h; };
  const json = (value: unknown) => put(Buffer.from(`${JSON.stringify(value)}\n`));
  const containers = ROLES.map(([role, host]) => {
    const bundle = docker.find(d => d.host === host)!, service = bundle.services.find((s: Json) => s.role === role)!, c = service.capture, active = c.containers[0];
    return { role, host, serviceName: c.serviceName, serviceId: c.serviceId, taskId: active.taskId, containerId: active.id,
      startedAt: new Date(active.startedAt).toISOString(), observedAt: c.observedAt, replicas: 1 as const,
      privatePidNamespace: true as const, noPreDispatchActiveTask: true as const, noAlternativeIngress: true as const,
      artifactHash: json(c),
      topologyArtifactHash: json({ kind: "nmv-release-29877f65-topology", role, host, serviceName: c.serviceName, serviceId: c.serviceId,
        noAlternativeIngress: true, privatePidNamespace: true, reviewed: true, reviewer,
        observed: { bundleSha256: bundleShas[host], pidMode: active.pidMode, privileged: active.privileged, endpointPorts: service.endpointPorts,
          networks: service.networks, serviceList: bundle.serviceList.map((s: Json) => s.Name) } }) };
  });
  const recoveryRaw = decode(m1.recoveryCandidates[0]), recovery = JSON.parse(recoveryRaw.toString("utf8"));
  const relay = m1.relayProcess, native = m1.nativeProcess, models: string[] = m1.nativeModels.ids;
  const current = { kind: "nmv-release-29877f65-current-relay", observedAt: m1.observedAt, m1BundleSha256: bundleShas.m1,
    pid: relay.pid, startedAt: relay.startedAt, relayGeneration: recovery.restored.relayGeneration,
    // service.ts draws relayGeneration once per process; same launchd PID and start not after recovery completion => same generation.
    generationSource: "same_process_as_recovery", generationCorroboration: (m1.recentReceipts ?? []).filter((r: Json) => r.startedAt >= relay.startedAt),
    model: models.join(","), modelPid: native.pid, modelStartedAt: native.startedAt, oldModelPidAbsent: true, oldModelGroupAbsent: true,
    launchd: m1.launchd, relayActiveJsonPresent: m1.relayState?.activeJsonPresent ?? null };
  const gw = docker.find(d => d.host === "m3ultra")!.gatewaySource;
  const receipt = replacedProviderReceiptSchema.parse({ version: 1, kind: "replaced_provider_boundary_receipt", planHash: replacedProviderPlanHash(plan),
    observedAt: [...containers.map(c => c.observedAt), m1.observedAt].sort().at(-1),
    containers,
    relay: { requestId: original.requestId, requestModel: original.requestModel, requestHash: original.requestHash, relayGeneration: original.relayGeneration,
      startedAt: original.startedAt, endedAt: original.endedAt, state: original.state, error: original.error,
      receiptArtifactHash: put(receiptRaw), recoveryArtifactHash: put(recoveryRaw),
      currentGeneration: recovery.restored.relayGeneration, currentStartedAt: relay.startedAt, currentPid: relay.pid, currentArtifactHash: json(current),
      oldRelayGroupEnded: true, oldModelGroupEnded: true,
      originalModelPid: recovery.originalNativeIdentity.pid, originalModelStartedAt: recovery.originalNativeIdentity.startedAt,
      currentModelPid: native.pid, currentModelStartedAt: native.startedAt, currentModel: models.join(","),
      originalWireArtifactHash: plan.request.wireHash,
      gatewaySourceArtifactHash: json({ kind: "nmv-release-29877f65-gateway-source", containerId: gw.containerId,
        files: gw.files.map((f: Json) => ({ path: f.path, sha256: f.sha256, size: f.size, base64: f.base64 })) }),
      originalWire, relayWire, transform: "abcllm-qwen-nonstream-httpx-0.27.2" } });
  return { receipt, artifacts, checks };
}

/** The same offline checks as the release CLI plus the evidence predicate at the local clock. DB/trigger checks still follow in dry-run. */
export function offlineVerify(plan: ReplacedProviderPlan, receipt: ReplacedProviderReceipt, read: (hash: string) => Buffer, operator: string, evaluatedAt: string): Check[] {
  const checks: Check[] = [];
  try { verifyReplacedProviderArtifacts(plan, receipt, read); checks.push({ name: "artifacts_verified", ok: true }); }
  catch (error) { checks.push({ name: "artifacts_verified", ok: false, detail: (error as Error).message }); }
  const evidence = { version: 1, kind: "replaced_provider_boundary_exit", requestId: plan.request.requestId, owner: plan.request.owner, fromState: "indeterminate",
    dispatchAt: plan.request.dispatchAt, bindingHash: plan.request.bindingHash, notBefore: receipt.observedAt, evaluatedAt, operator,
    reference: plan.reviewReference, plan, receipt };
  const parsed = replacedProviderEvidenceSchema.safeParse(evidence);
  checks.push({ name: "evidence_predicate_at_local_clock", ok: parsed.success,
    detail: parsed.success ? { planAgeSeconds: (Date.parse(evaluatedAt) - Date.parse(plan.createdAt)) / 1000, receiptAgeSeconds: (Date.parse(evaluatedAt) - Date.parse(receipt.observedAt)) / 1000 }
      : parsed.error.issues.map(i => i.path.join(".") || i.message) });
  return checks;
}

// ---------------- I/O ----------------
function options(args: readonly string[], allowed: readonly string[], flags: readonly string[] = []) {
  const map = new Map<string, string>(), set = new Set<string>();
  for (const arg of args) {
    if (flags.includes(arg) && !set.has(arg)) { set.add(arg); continue; }
    const m = /^--([a-z0-9-]+)=([^\n]+)$/.exec(arg);
    if (!m || !allowed.includes(m[1]) || map.has(m[1])) throw new Error(`release_29877f65_option:${arg.split("=")[0]}`);
    map.set(m[1], m[2]);
  }
  return { get: (k: string) => map.get(k), need: (k: string) => { const v = map.get(k); if (!v) throw new Error(`release_29877f65_required:${k}`); return v; }, flag: (k: string) => set.has(k) };
}
function readPinned(path: string, expected: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("release_29877f65_input_file");
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expected) throw new Error(`release_29877f65_input_sha_mismatch:${path}`);
  return bytes;
}
const writePrivate = (path: string, bytes: Buffer) => writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
function writeArtifacts(dir: string, artifacts: Map<string, Buffer>) {
  for (const [hash, bytes] of artifacts) {
    const path = join(dir, `${hash}.json`);
    try { writePrivate(path, bytes); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readFileSync(path).equals(bytes)) throw error;
    }
  }
}
async function databaseUrl(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 4096) throw new Error("dr_cli_invalid_database_url"); }
  const { parseDatabaseUrl } = await import("../dr/promotion");
  return parseDatabaseUrl(Buffer.concat(chunks).toString("utf8"));
}

const MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`, US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export async function readDbFacts(url: string): Promise<DbFacts> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, connect_timeout: 10, prepare: false, idle_timeout: 5, connection: { application_name: "nomorevibe:release-29877f65" } });
  try {
    return await sql.begin("isolation level repeatable read read only", async tx => {
      await tx.unsafe(`SET LOCAL statement_timeout='15s'`);
      await tx.unsafe(`SET LOCAL TIME ZONE 'UTC'`);
      const [clock] = await tx.unsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',${MS}) now, pg_is_in_recovery() replica, current_setting('transaction_read_only') ro`);
      const [c] = await tx.unsafe(`SELECT mode, epoch::int, revision::int, policy_hash, to_char(updated_at AT TIME ZONE 'UTC',${US}) updated_at FROM model_capacity_control WHERE id=1`);
      const [w] = await tx.unsafe(`SELECT state, lineage_id::text, writer_epoch::text FROM dr_writer_fence WHERE id=1`);
      const [r] = await tx.unsafe(`WITH x AS (SELECT r.*, coalesce(r.dispatched_at,(SELECT min(e.created_at) FROM model_capacity_events e WHERE e.request_id=r.request_id AND e.kind='dispatch_started')) d
          FROM model_capacity_requests r WHERE r.request_id=$1::uuid)
        SELECT x.request_id::text, x.state, x.owner_instance_id, x.owner_boot_id::text, x.epoch::int, x.revision::int, x.policy_hash, x.dispatch_binding_hash,
          x.dispatch_binding, x.provider_budget_id, x.group_id, x.route_id, x.provider, x.model, x.settled_at IS NOT NULL settled,
          x.terminal_evidence IS NULL AND x.terminal_evidence_hash IS NULL terminal_null, x.token IS NULL token_null,
          encode(sha256(convert_to(x.token::text,'UTF8')),'hex') token_hash,
          (SELECT encode(sha256(convert_to(to_jsonb(q)::text,'UTF8')),'hex') FROM model_capacity_requests q WHERE q.request_id=x.request_id) row_hash,
          to_char(x.d AT TIME ZONE 'UTC',${MS}) dispatch_at, to_char(x.d AT TIME ZONE 'UTC',${MS})::timestamptz = x.dispatched_at dispatch_ms_exact,
          x.dispatch_binding_hash = encode(sha256(convert_to(nmv_boundary_canonical(x.dispatch_binding),'UTF8')),'hex') binding_hash_ok
        FROM x`, [REQUEST_ID]);
      const events = r ? await tx.unsafe(`SELECT e.id::int, e.kind, e.seq, e.run_id::text, encode(sha256(convert_to(e.run_id::text,'UTF8')),'hex') run_id_hash, e.pid, e.method,
          to_char(e.recorded_at AT TIME ZONE 'UTC',${MS}) recorded_at, e.recorded_at < q.dispatched_at before_dispatch,
          e.recorded_at <= q.dispatched_at at_or_before, e.recorded_at >= q.dispatched_at at_or_after
        FROM dr_process_group_events e, model_capacity_requests q WHERE q.request_id=$1::uuid
          AND e.owner_instance_id=q.owner_instance_id AND e.owner_boot_id=q.owner_boot_id ORDER BY e.id`, [REQUEST_ID]) : [];
      const ends = await tx.unsafe(`SELECT e.id::int, encode(sha256(convert_to(e.evidence::text,'UTF8')),'hex') evidence_hash, e.from_state, e.to_state,
          to_char(e.created_at AT TIME ZONE 'UTC',${MS}) created_at, e.created_at >= q.dispatched_at after_dispatch
        FROM model_capacity_events e JOIN model_capacity_requests q USING (request_id) WHERE e.request_id=$1::uuid AND e.kind='dispatch_local_ended' ORDER BY e.id`, [REQUEST_ID]);
      const ids = r ? [...new Set(((r.dispatch_binding?.members ?? []) as BindingMember[]).map(m => m.productId))] : [];
      const products = ids.length ? await tx.unsafe(`SELECT id::int, name, tagline, description FROM products WHERE id = ANY($1::int[]) ORDER BY id`, [ids]) : [];
      const [s] = await tx.unsafe(`SELECT to_regprocedure('public.nmv_replaced_provider_records_valid(jsonb,jsonb)') IS NOT NULL has0143,
          EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='model_capacity_replaced_provider_guard' AND NOT tgisinternal) guard,
          to_regclass('drizzle.__drizzle_migrations') IS NOT NULL drizzle`);
      const drizzleRows = s.drizzle ? Number((await tx.unsafe(`SELECT count(*)::int n FROM drizzle.__drizzle_migrations`))[0].n) : null;
      return { now: clock.now, replica: clock.replica, readOnly: clock.ro,
        control: { mode: c.mode, epoch: c.epoch, revision: c.revision, policyHash: c.policy_hash, updatedAt: c.updated_at },
        fence: { state: w.state, lineageId: w.lineage_id, writerEpoch: Number(w.writer_epoch) },
        row: r ? { requestId: r.request_id, state: r.state, ownerInstanceId: r.owner_instance_id, ownerBootId: r.owner_boot_id, epoch: r.epoch, revision: r.revision,
          policyHash: r.policy_hash, bindingHash: r.dispatch_binding_hash, binding: r.dispatch_binding, providerBudgetId: r.provider_budget_id, groupId: r.group_id,
          routeId: r.route_id, provider: r.provider, model: r.model, settled: r.settled, terminalNull: r.terminal_null, tokenNull: r.token_null, tokenHash: r.token_hash,
          rowHash: r.row_hash, dispatchAt: r.dispatch_at, dispatchMsExact: r.dispatch_ms_exact, bindingHashOk: r.binding_hash_ok } : null,
        events: events.map(e => ({ id: e.id, kind: e.kind, seq: e.seq, runId: e.run_id, runIdHash: e.run_id ? e.run_id_hash : null, pid: e.pid, method: e.method,
          recordedAt: e.recorded_at, beforeDispatch: e.before_dispatch, atOrBeforeDispatch: e.at_or_before, atOrAfterDispatch: e.at_or_after })),
        localEnds: ends.map(e => ({ id: e.id, evidenceHash: e.evidence_hash, fromState: e.from_state, toState: e.to_state, createdAt: e.created_at, afterDispatch: e.after_dispatch })),
        products: products.map(p => ({ id: p.id, name: p.name, tagline: p.tagline, description: p.description })),
        schema: { has0143: s.has0143, guardTrigger: s.guard, drizzleRows } } satisfies DbFacts;
    });
  } finally { await sql.end({ timeout: 5 }); }
}

/** DB functions that exist before 0143 (0129) re-check the owner records read-only; after 0143 the full records predicate too. */
async function dbRecheck(url: string, plan: ReplacedProviderPlan, has0143: boolean): Promise<Check[]> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, connect_timeout: 10, prepare: false, idle_timeout: 5 });
  try {
    return await sql.begin("isolation level repeatable read read only", async tx => {
      await tx.unsafe(`SET LOCAL statement_timeout='15s'`);
      const [owner] = await tx.unsafe(`SELECT nmv_boundary_original_owner_records_valid($1::text::jsonb,to_jsonb(r)) ok FROM model_capacity_requests r WHERE request_id=$2::uuid`, [JSON.stringify(plan), REQUEST_ID]);
      const checks: Check[] = [{ name: "db_original_owner_records_valid", ok: owner?.ok === true }];
      if (has0143) {
        const [records] = await tx.unsafe(`SELECT nmv_replaced_provider_records_valid($1::text::jsonb,to_jsonb(r)) ok FROM model_capacity_requests r WHERE request_id=$2::uuid`, [JSON.stringify({ plan }), REQUEST_ID]);
        checks.push({ name: "db_replaced_provider_records_valid", ok: records?.ok === true });
      }
      return checks;
    });
  } finally { await sql.end({ timeout: 5 }); }
}

/** Post-apply (or unclear response) readback from the primary. Never a substitute write. */
async function readback(url: string) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1, connect_timeout: 10, prepare: false, idle_timeout: 5 });
  try {
    return await sql.begin("isolation level repeatable read read only", async tx => {
      await tx.unsafe(`SET LOCAL statement_timeout='15s'`);
      const [clock] = await tx.unsafe(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',${MS}) now, pg_is_in_recovery() replica`);
      const [c] = await tx.unsafe(`SELECT mode, epoch::int, revision::int FROM model_capacity_control WHERE id=1`);
      const [r] = await tx.unsafe(`SELECT state, terminal_evidence->>'kind' terminal_kind, terminal_evidence_hash, settled_at IS NULL unsettled,
          (dispatch_binding->>'chargedTokens')::int charged_tokens FROM model_capacity_requests WHERE request_id=$1::uuid`, [REQUEST_ID]);
      const events = await tx.unsafe(`SELECT id::int, kind, from_state, to_state, to_char(created_at AT TIME ZONE 'UTC',${MS}) created_at
        FROM model_capacity_events WHERE request_id=$1::uuid AND kind='dispatch_released' ORDER BY id`, [REQUEST_ID]);
      const audits = await tx.unsafe(`SELECT id::int, action, to_char(created_at,${MS}) created_at FROM operations_audit
        WHERE action='model-replaced-provider-boundary-release' AND target=$1 ORDER BY id`, [REQUEST_ID]);
      const unknown = await tx.unsafe(`SELECT request_id::text, route_id, group_id, state FROM model_capacity_requests WHERE state IN ('dispatched','indeterminate') ORDER BY dispatched_at`);
      return { dbNow: clock.now, replica: clock.replica, capacity: c, request: r ?? null, releaseEvents: events, audits, active: unknown,
        released: r?.state === "withdrawn" && r.terminal_kind === "replaced_provider_boundary_exit" && r.unsettled === true && events.length === 1 && audits.length === 1 };
    });
  } finally { await sql.end({ timeout: 5 }); }
}

function bundlesFrom(o: ReturnType<typeof options>, required: boolean) {
  const out: { docker: Json[]; m1: Json | null; shas: Record<string, string> } = { docker: [], m1: null, shas: {} };
  for (const [key, host] of [["bundle-m3", "m3ultra"], ["bundle-mini", "9mini"]] as const) {
    const path = required ? o.need(key) : o.get(key);
    if (!path) continue;
    const sha = o.need(`${key}-sha`), bundle = JSON.parse(readPinned(path, sha).toString("utf8"));
    if (bundle.kind !== "nmv-release-29877f65-docker-bundle" || bundle.host !== host) throw new Error(`release_29877f65_bundle_kind:${key}`);
    out.docker.push(bundle); out.shas[host] = sha;
  }
  const m1 = required ? o.need("bundle-m1") : o.get("bundle-m1");
  if (m1) { out.shas.m1 = o.need("bundle-m1-sha"); out.m1 = JSON.parse(readPinned(m1, out.shas.m1).toString("utf8")); }
  return out;
}
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 1)}\n`);

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "db-target") {
    const o = options(args, [], ["--database-url-stdin"]);
    if (!o.flag("--database-url-stdin")) throw new Error("release_29877f65_required:database-url-stdin");
    const url = new URL(await databaseUrl());
    print({ host: url.hostname, port: url.port, database: url.pathname.slice(1), queryKeys: [...url.searchParams.keys()], parseDatabaseUrl: "ok" });
    return 0;
  }
  if (command === "readback") {
    const o = options(args, [], ["--database-url-stdin"]);
    if (!o.flag("--database-url-stdin")) throw new Error("release_29877f65_required:database-url-stdin");
    const result = await readback(await databaseUrl());
    print({ command: "readback", requestId: REQUEST_ID, ...result });
    return result.released ? 0 : 3;
  }
  if (command === "preflight") {
    const o = options(args, ["bundle-m3", "bundle-m3-sha", "bundle-mini", "bundle-mini-sha", "bundle-m1", "bundle-m1-sha"], ["--database-url-stdin"]);
    if (!o.flag("--database-url-stdin")) throw new Error("release_29877f65_required:database-url-stdin");
    const url = await databaseUrl(), facts = await readDbFacts(url), b = bundlesFrom(o, false);
    const checks = facts.row ? [...rowChecks(facts), ...originalOwnerFrom(facts).checks] : rowChecks(facts);
    if (facts.row) {
      const wire = reconstructOriginalWire(facts.row.binding.members as BindingMember[], facts.products, facts.row.model);
      checks.push({ name: "original_wire_reconstructed_matches_ledger", ok: wire.ok && wire.wireHash === facts.row.binding.wireHash,
        detail: { sourceCommit: ORIGINAL_SOURCE_COMMIT, sources: wire.sources.map(s => ({ productId: s.productId, field: s.field, matches: s.matches })) } });
      if (wire.ok && b.m1) {
        const receipt = JSON.parse(decode(b.m1.receipt).toString("utf8"));
        checks.push({ name: "relay_wire_matches_receipt_request_hash", ok: sha256(relayWireFromOriginal(wire.wire, REQUEST_MODEL)) === receipt.requestHash });
      }
      if (b.docker.length || b.m1) checks.push(...bundleChecks(facts.row.dispatchAt, b.docker, b.m1));
      const owner = originalOwnerFrom(facts).owner;
      if (owner) {
        const probe = { createdAt: facts.now, request: { requestId: REQUEST_ID }, originalOwner: { ...owner, artifactHash: "0".repeat(64) } };
        checks.push(...(await dbRecheck(url, probe as unknown as ReplacedProviderPlan, false)).map(c => ({ ...c, name: `${c.name}_at_now` })));
      }
    }
    const blockedNow = checks.filter(c => !c.ok).map(c => c.name);
    print({ command: "preflight", requestId: REQUEST_ID, dbNow: facts.now, capacity: { mode: facts.control.mode, epoch: facts.control.epoch, revision: facts.control.revision },
      schema: facts.schema, applyRequires0143: !facts.schema.has0143 || !facts.schema.guardTrigger, requestState: facts.row?.state ?? null,
      checks, blockedNow, readyForDrainWindow: blockedNow.length === 0 && facts.schema.has0143 && facts.schema.guardTrigger });
    return blockedNow.length ? 3 : 0;
  }
  if (command === "plan") {
    const o = options(args, ["out-dir", "reference"], ["--database-url-stdin"]);
    if (!o.flag("--database-url-stdin")) throw new Error("release_29877f65_required:database-url-stdin");
    const dir = resolve(o.need("out-dir")), reference = o.need("reference"), url = await databaseUrl(), facts = await readDbFacts(url);
    let built: ReturnType<typeof buildPlan>;
    try { built = buildPlan(facts, reference); } catch (error) { print({ command: "plan", blocked: true, checks: (error as { checks?: Check[] }).checks ?? [] }); return 3; }
    const recheck = await dbRecheck(url, built.plan, facts.schema.has0143);
    if (!recheck.every(c => c.ok)) { print({ command: "plan", blocked: true, checks: [...built.checks, ...recheck] }); return 3; }
    mkdirSync(dir, { mode: 0o700 }); mkdirSync(join(dir, "artifacts"), { mode: 0o700 });
    const bytes = Buffer.from(`${JSON.stringify(built.plan)}\n`);
    writePrivate(join(dir, "plan.json"), bytes); writeArtifacts(join(dir, "artifacts"), built.artifacts);
    print({ command: "plan", planPath: join(dir, "plan.json"), planSha: sha256(bytes), planHash: replacedProviderPlanHash(built.plan), createdAt: built.plan.createdAt,
      receiptDeadline: new Date(Date.parse(built.plan.createdAt) + 30 * 60_000).toISOString(), schema: facts.schema, checks: [...built.checks, ...recheck] });
    return 0;
  }
  if (command === "receipt") {
    const o = options(args, ["dir", "plan-sha", "bundle-m3", "bundle-m3-sha", "bundle-mini", "bundle-mini-sha", "bundle-m1", "bundle-m1-sha", "topology-reviewed-by", "operator"]);
    const dir = resolve(o.need("dir")), planSha = o.need("plan-sha");
    const plan = replacedProviderPlanSchema.parse(JSON.parse(readPinned(join(dir, "plan.json"), planSha).toString("utf8")));
    const originalWire = readFileSync(join(dir, "artifacts", `${plan.request.wireHash}.json`), "utf8");
    const b = bundlesFrom(o, true);
    let built: ReturnType<typeof buildReceipt>;
    try { built = buildReceipt(plan, originalWire, b.docker, b.m1!, b.shas, o.need("topology-reviewed-by")); }
    catch (error) { print({ command: "receipt", blocked: true, checks: (error as { checks?: Check[] }).checks ?? [(error as Error).message] }); return 3; }
    writeArtifacts(join(dir, "artifacts"), built.artifacts);
    const verify = offlineVerify(plan, built.receipt, h => readFileSync(join(dir, "artifacts", `${h}.json`)), o.need("operator"), new Date().toISOString());
    const bytes = Buffer.from(`${JSON.stringify(built.receipt)}\n`);
    writePrivate(join(dir, "receipt.json"), bytes);
    const ok = verify.every(c => c.ok);
    print({ command: "receipt", receiptPath: join(dir, "receipt.json"), receiptSha: sha256(bytes), observedAt: built.receipt.observedAt,
      applyBefore: new Date(Math.min(Date.parse(built.receipt.observedAt) + 5 * 60_000, Date.parse(plan.createdAt) + 30 * 60_000)).toISOString(),
      checks: [...built.checks, ...verify], readyForDryRun: ok });
    return ok ? 0 : 3;
  }
  throw new Error("release_29877f65_usage:db-target|preflight|plan|receipt|readback");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  const code = error instanceof Error && /^(release_29877f65|dr_cli)_[a-z0-9_:./-]+$/.test(error.message) ? error.message : "release_29877f65_failed";
  process.stderr.write(`${JSON.stringify({ code, name: error instanceof Error ? error.name : typeof error })}\n`); process.exitCode = 1;
});
