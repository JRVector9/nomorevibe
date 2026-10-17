import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { resolveAi1GatewayServingContract } from "@/lib/crawl/agent-review-serving-contract";
import { resolveAi2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { LIVE_MIN_WINDOW_MS, parseLiveCapacityArtifact } from "./pipeline-capacity-live";
import { collectLiveCapacityWindow } from "./pipeline-capacity-live-repository";
import { startEvidenceRecorder } from "./pipeline-evidence-ledger";
import { assertIsolatedReplayDatabase, FIXED_INPUT_TIMING, fixedInputRunConditions, parseFixedInputArtifact, parseFixedInputRunManifest,
  parseFixedInputRunResult, type FixedInputArtifact, type FixedInputRunResult, type FixedInputTiming } from "./pipeline-replay-fixed-input";
import { dbClockIso, fixedInputOrdinals, fixedInputWrites, loadFixedInputs } from "./pipeline-replay-fixed-input-repository";
import { installReplayEgressGuard, startReplayModelMeter, type ReplayMeterDrain, type ReplayMeterStop } from "./pipeline-replay-model-meter";

const DEFAULT_GATEWAY = "https://abcllm-api.brut.bot";
/** 같은 reviewer 역할 워커지만 고정 입력 밖(소개 검수·발행분 감사·판정)을 부르는 잡은 돌리지 않는다. 기준선을 낮추지 않는 쪽이다. */
const REPLAY_JOBS = ["crawl-agent-review", "second-review"] as const;
const BLOCKED_CLI = "/nonexistent/nomorevibe-replay-cli-blocked";
type Env = Readonly<Record<string, string | undefined>>;
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

/**
 * 네트워크·DB 없이 실행 조건을 판정한다. legacy는 설정·키·upstream만 보면 되고, item 모드는 실제 consumer가 요구하는
 * serving 계약(resolver)과 모델 슬롯 route가 모든 1차·2차·대체 모델에 있어야 한다. 막히면 이유 목록을 돌려준다.
 */
export function fixedInputPreflight(manifestValue: unknown, artifactValue: unknown, env: Env = process.env,
  timing: FixedInputTiming = FIXED_INPUT_TIMING) {
  const manifest = parseFixedInputRunManifest(manifestValue, timing), artifact = parseFixedInputArtifact(artifactValue);
  const stored = mergeWithDefaults(artifact.settings);
  ensure(isDeepStrictEqual(JSON.parse(JSON.stringify(stored)), artifact.settings), "replay_settings_invalid");
  const settings: CrawlSettings = manifest.secondReviewFallbacks
    ? { ...stored, secondReview: { ...stored.secondReview, fallbacks: manifest.secondReviewFallbacks } } : stored;
  ensure(isDeepStrictEqual(mergeWithDefaults(JSON.parse(JSON.stringify(settings))), settings), "replay_settings_invalid");
  ensure(settings.enabled && settings.reviewMode === "enforce" && settings.secondReview.enabled && settings.firstReview, "replay_settings_not_enforced");
  const first = settings.firstReview, second = [...settings.secondReview.voters, ...settings.secondReview.fallbacks ?? []];
  // CLI 심사자는 계량기·상한 밖에서 외부로 나가고 item consumer 계약도 없다. 두 실행 모두 게이트웨이 모델만 받는다.
  ensure([first, ...second].every(row => row.provider === "abcllm"), "replay_cli_provider_unsupported");
  // 게이트웨이 모듈은 이 값을 그대로 이어 붙인다. origin만 같고 경로·슬래시가 붙으면 egress 관문이 모든 호출을 막는다.
  ensure((env.ABCLLM_BASE_URL?.trim() || DEFAULT_GATEWAY) === manifest.upstream, "replay_upstream_mismatch");
  ensure(env.ABCLLM_API_KEY?.trim(), "replay_api_key_missing");
  // 심사 잡은 README 표본이 없거나 판이 다르면 원본 옆 표본을 새로 받는다(lib/crawl/jobs/review-document.ts). 그 요청은 명시 dispatcher로
  // 나가 egress 관문·계량기를 거치지 않는다. 이 코드 판과 다른 표본이 하나라도 있으면 실행 전에 거절한다(F1).
  ensure(artifact.inputs.every(row => typeof row.document.pageMeta?.readmeSample === "string"
    && row.document.pageMeta.readmeSampleVersion === README_SAMPLE_VERSION), "replay_readme_sample_version_mismatch");
  const blocked: string[] = [];
  if (manifest.items) {
    const routes = manifest.items.capacityPolicy.routes, mapped = (routeId: string, model: string) =>
      routes.some(route => route.routeId === routeId && route.provider === "abcllm" && route.model === model);
    const ai1 = resolveAi1GatewayServingContract(first.model);
    if (!ai1) blocked.push("ai1_serving_contract_unavailable");
    else if (new URL(ai1.endpoint).origin !== manifest.upstream) blocked.push("ai1_serving_endpoint_outside_upstream");
    if (!mapped("crawl-agent-review", first.model)) blocked.push("ai1_capacity_route_unmapped");
    for (const row of second) {
      const ai2 = resolveAi2GatewayServingContract(row.model);
      if (!ai2) blocked.push("ai2_serving_contract_unavailable");
      else if (new URL(ai2.endpoint).origin !== manifest.upstream) blocked.push("ai2_serving_endpoint_outside_upstream");
      if (!mapped("second-review", row.model)) blocked.push("ai2_capacity_route_unmapped");
    }
  }
  return { manifest, artifact, settings, blocked: [...new Set(blocked)] };
}

/**
 * 격리 DB에서 고정 입력을 한 모드로 실모델 심사한다. 순서: 관문 → 적재 → 0097 기록 시작 marker → 구간 시작까지 대기 → 계량기·egress 가둠 →
 * 운영과 같은 scheduler·reviewer 워커(두 심사 잡만)와, item 모드면 AI1·AI2 consumer → 구간 끝 또는 상한에 정지 →
 * 진행 중 호출 정리 → 운영 구간과 같은 수집기로 읽기 전용 수집. 발행·공개 상태·외부 반영 잡은 돌리지 않는다.
 * 구간 끝(두 모드 같다): 정지 신호와 계량기가 새 claim·새 호출을 막고, 계량기에 이미 보낸 호출은 drain 상한(벽시간 안) 안에서 upstream이
 * 끝나 usage를 남긴다(budget에 센다). 워커는 그 답을 받지 않으므로 최종·처리량·p95는 구간 안 그대로다. 상한을 넘긴 호출은 끊는다.
 * item consumer는 새 claim만 멈추고 이미 보낸 호출의 답을 drain 상한까지 받아 장부에 정산한다. 그 기록은 구간 뒤라 최종에 들지 않는다.
 */
export async function runFixedInputReplay(options: { manifest: unknown; artifact: FixedInputArtifact; artifactSha256: string;
  manifestSha256: string; revision: string; env?: Env; timing?: FixedInputTiming }): Promise<FixedInputRunResult> {
  const env = options.env ?? process.env, timing = options.timing ?? FIXED_INPUT_TIMING, startedHost = Date.now();
  if (currentReplayDb()) throw new Error("replay_runner_scope_conflict");
  assertIsolatedReplayDatabase(env.DATABASE_URL, env);
  const { manifest, artifact, settings, blocked } = fixedInputPreflight(options.manifest, options.artifact, env, timing);
  ensure(manifest.artifactSha256 === options.artifactSha256, "replay_artifact_sha_mismatch");
  ensure(!blocked.length, "consumer_mode_blocked");
  const [{ runWorker, jobRunOptions }, { runScheduler }, control, { runJob }, { JOBS }, { batchLanesForRole }] = await Promise.all([
    import("@/scripts/worker"), import("@/scripts/scheduler"), import("@/lib/jobs/control"), import("@/lib/jobs/runner"),
    import("@/lib/jobs/registry"), import("@/lib/jobs/batches")]);
  const consumers = manifest.items ? await Promise.all([import("@/lib/crawl/consumers/first"), import("@/lib/crawl/consumers/second")]) : null;

  const load = await loadFixedInputs({ artifact, settings, mode: manifest.mode, capacityPolicy: manifest.items?.capacityPolicy });
  ensure(load.items.length, "replay_inputs_empty");
  const startedAt = plus(load.anchorAt, timing.leadMs), endedAt = plus(startedAt, manifest.durationMs);
  // PR01b-9: 격리 DB(위 관문 통과)에만, 모든 워커·호출보다 먼저 기록 시작 marker를 남긴다. 그래야 구간 안의 사람 결정 덮음·lease 위반·
  // AI2 호출이 0097 장부에 쌓이고 수집기가 그 구간을 verified로 셀 수 있다. 아래 lead 검사가 marker도 구간 시작 전임을 보장한다.
  await startEvidenceRecorder(db, { revision: options.revision, operator: "pipeline-replay" });
  // 두 실행이 같은 lead를 써야 구간 시작의 근거 나이가 같다. 적재가 늦으면 실행하지 않는다.
  ensure(Date.parse(await dbClockIso()) < Date.parse(startedAt), "replay_load_exceeded_lead");
  for (let now = await dbClockIso(); Date.parse(now) < Date.parse(startedAt); now = await dbClockIso())
    await sleep(Math.min(1_000, Date.parse(startedAt) - Date.parse(now)));

  const controller = new AbortController(), signal = controller.signal, failures: string[] = [];
  // item consumer 는 두 신호를 받는다: claims 는 정지 순간 새 claim·dispatch 를 막고, consumerCancel 은 진행 중 호출을 끊는다.
  // 구간 끝에는 consumerCancel 을 drain 상한까지 미뤄, 이미 보낸 호출이 terminal(usage)을 장부에 정산하게 한다(아니면 local_abort 로 C 청구).
  const claims = new AbortController(), consumerCancel = new AbortController();
  let consumerCancelTimer: ReturnType<typeof setTimeout> | undefined;
  const halted: { reason: FixedInputRunResult["stop"]["reason"] | null; at: number; calls: number | null; deadline: number;
    drain: Promise<ReplayMeterDrain> | null; meterStop: ReplayMeterStop | null } = { reason: null, at: 0, calls: null, deadline: 0, drain: null, meterStop: null };
  let guardRejected = 0, meterCalls = () => 0, drainMeter: ((deadlineAt: number) => Promise<ReplayMeterDrain>) | null = null;
  // 정지 순간까지 보낸 호출 수를 남긴다(그 뒤에 나간 호출이 있으면 budget 구간이 흐려지므로 미검증이 된다).
  // 구간 끝이면 신호보다 먼저 계량기를 drain으로 돌린다: 이후 호출은 거부하고, 진행 중 호출은 호출자가 끊겨도 상한까지 끝나게 둔다.
  const stop = (value: FixedInputRunResult["stop"]["reason"]) => {
    if (halted.reason) return;
    halted.reason = value; halted.at = Date.now(); halted.calls = meterCalls();
    claims.abort();
    if (value === "window_end" && drainMeter) {
      halted.deadline = Math.min(halted.at + timing.drainMs, startedHost + manifest.limits.maxWallMs); halted.drain = drainMeter(halted.deadline);
      consumerCancelTimer = setTimeout(() => consumerCancel.abort(), Math.max(0, halted.deadline - Date.now()));
    } else consumerCancel.abort();
    controller.abort();
  };
  // drain 중 계량기 상한(호출당 상한 위반 등)은 정지 사유를 바꾸지 않고 drain 기록에 남긴다(보고서가 비교 불가로 표시한다).
  const meter = await startReplayModelMeter({ upstream: manifest.upstream, limits: manifest.limits,
    onStop: (value: ReplayMeterStop) => { if (halted.reason === "window_end") halted.meterStop ??= value; else stop(value); } });
  meterCalls = () => meter.stats().calls; drainMeter = deadlineAt => meter.drain(deadlineAt);
  const release = installReplayEgressGuard(manifest.upstream, meter, () => { guardRejected++; });
  const savedCli = { CLAUDE_CLI: process.env.CLAUDE_CLI, GROK_CLI: process.env.GROK_CLI };
  process.env.CLAUDE_CLI = BLOCKED_CLI; process.env.GROK_CLI = BLOCKED_CLI;
  const windowTimer = setTimeout(() => stop("window_end"), Math.max(0, Date.parse(endedAt) - Date.parse(await dbClockIso())));
  const wallTimer = setTimeout(() => stop("wall_cap"), Math.max(0, startedHost + manifest.limits.maxWallMs - Date.now()));
  let drainMs = 0, windowDrain: ReplayMeterDrain | null = null;
  try {
    const guarded = (name: string, task: () => Promise<unknown>) => task().catch(() => { failures.push(`${name}_failed`); stop("worker_failed"); });
    const names = [...REPLAY_JOBS];
    const lanes = batchLanesForRole("reviewer", "legacy").map(lane => lane.filter(name => names.includes(name as typeof names[number])))
      .filter(lane => lane.length);
    const tasks = [
      guarded("scheduler", () => runScheduler({ signal }, { requestDue: control.requestDueJobs, seen: control.markSchedulerSeen })),
      guarded("worker", () => runWorker({ role: "reviewer", signal }, { names, lanes, pending: () => control.pendingJobNames("reviewer"),
        seen: control.markWorkerSeen, run: (name, runOptions) => runJob(name, JOBS[name], jobRunOptions(name, runOptions)) })),
    ];
    if (consumers && manifest.items) {
      const [{ runFirstReviewConsumer }, { runSecondReviewConsumer }] = consumers, tag = randomUUID().slice(0, 8);
      for (let index = 0; index < manifest.items.ai1Consumers; index++) tasks.push(guarded("ai1_consumer", () =>
        runFirstReviewConsumer({ owner: { instanceId: `replay-${tag}-ai1-${index + 1}`, bootId: randomUUID() },
          signal: consumerCancel.signal, stopClaims: claims.signal })));
      for (let index = 0; index < manifest.items.ai2Consumers; index++) tasks.push(guarded("ai2_consumer", () =>
        runSecondReviewConsumer({ owner: { instanceId: `replay-${tag}-ai2-${index + 1}`, bootId: randomUUID() },
          signal: consumerCancel.signal, stopClaims: claims.signal })));
    }
    await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
    // 진행 중 호출·기록은 신호를 받고 스스로 끝난다. DB 연결을 닫거나 수집하기 전에 모두 기다린다.
    const drainStarted = Date.now();
    await Promise.allSettled(tasks);
    clearTimeout(consumerCancelTimer); consumerCancel.abort();
    drainMs = Date.now() - drainStarted;
    // 정지와 함께 시작한 계량기 drain(구간 끝만)을 마저 기다린다. 상한에서 끊으므로 drain 한도·벽시간을 넘지 않는다.
    if (halted.drain) windowDrain = await halted.drain;
  } finally {
    clearTimeout(windowTimer); clearTimeout(wallTimer); clearTimeout(consumerCancelTimer);
    for (const [key, value] of Object.entries(savedCli)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await release();
    await meter.close();
  }
  const stopReason = halted.reason ?? "worker_failed", early = stopReason !== "window_end";
  // 정상 종료는 [시작, 끝] 그대로다. 일찍 멈춘 실행은 끝을 지금으로 당기고 30분 구간을 뒤로 잡는다(비교 불가 표시가 붙는다).
  const collectionEnd = early ? await dbClockIso() : endedAt;
  // 수집기는 30분 미만 구간을 받지 않는다. 짧은 실행(시험·조기 정지)은 끝에서 30분을 거슬러 잡고 비교 불가로 표시된다.
  const collectionStart = new Date(Math.min(Date.parse(startedAt), Date.parse(collectionEnd) - LIVE_MIN_WINDOW_MS)).toISOString();
  while (Date.parse(await dbClockIso()) < Date.parse(collectionEnd)) await sleep(200);
  let live;
  try { live = await collectLiveCapacityWindow(db, { runId: manifest.runId, revision: options.revision, startedAt: collectionStart,
    endedAt: collectionEnd, target: "primary", source: "replay" }); }
  catch { throw new Error("replay_live_collection_failed"); }
  const ordinals = await fixedInputOrdinals(load.ordinalByRepo), map = (id: number) => {
    const ordinal = ordinals.get(id); ensure(ordinal, "replay_candidate_unmapped"); return ordinal;
  };
  live = parseLiveCapacityArtifact({ ...live, attempts: live.attempts.map(row => ({ ...row, candidateId: map(row.candidateId) })),
    candidates: live.candidates.map(row => ({ ...row, id: map(row.id) })),
    readiness: { ...live.readiness, sampleCandidateIds: live.readiness.sampleCandidateIds.map(map) } });
  const meterStats = meter.stats();
  return parseFixedInputRunResult({ version: 1, scope: "fixed_input_replay_run", runId: manifest.runId, mode: manifest.mode,
    revision: options.revision, artifactSha256: options.artifactSha256, manifestSha256: options.manifestSha256, inputSetHash: load.inputSetHash,
    inputs: { loaded: load.loaded, items: load.items, excluded: load.excluded },
    window: { anchorAt: load.anchorAt, startedAt, endedAt: collectionEnd, durationMs: Math.max(1, Date.parse(collectionEnd) - Date.parse(startedAt)),
      collectionStartedAt: collectionStart },
    // 정지 시각은 이 프로세스 시계, 구간 시작은 DB 시계다(수십 ms 차이는 진단용으로만 쓴다).
    stop: { reason: stopReason, atOffsetMs: Math.round(halted.at - Date.parse(startedAt)), drainMs, drainExceeded: drainMs > timing.drainMs },
    meter: { ...meterStats, egressRejected: meterStats.egressRejected + guardRejected },
    budget: { declaredConcurrentCalls: manifest.budget?.maxConcurrentCalls ?? null, callsAtStop: halted.calls ?? meterStats.calls },
    ...(windowDrain ? { windowEndDrain: { limitMs: Math.max(0, halted.deadline - halted.at), ...windowDrain, meterStop: halted.meterStop,
      accounting: "drain_calls_in_budget_not_in_finals" as const } } : {}),
    writes: await fixedInputWrites(), failures: [...new Set(failures)], conditions: fixedInputRunConditions(manifest), live });
}
