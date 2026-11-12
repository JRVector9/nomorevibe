import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { checkKoreanTaglineOutput } from "@/lib/domain/products/korean-tagline";
import { translateKoreanTaglinesWithModelCapacity } from "@/lib/domain/products/korean-tagline-model-capacity";
import { homeListSlugs, koreanTaglineSource, pendingKoreanTaglineBatch, type KoreanTaglineTask } from "@/lib/domain/products/korean-taglines";
import type { JobContext } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { runInTextTaskRank, type TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { aiTaskModelSnapshotRows } from "@/lib/llm/ai-task-models-snapshot";
import { bindApiTaskRank } from "@/lib/llm/ai-task-resolver";
import { capacityOwnerFromEnv } from "@/lib/llm/capacity-busy-targets";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { cancelOwnPendingProductTextRequest, findOwnPendingProductTextRequests } from "@/lib/llm/capacity-repository";
import { modelRouteTimeoutMs } from "@/lib/llm/model-registry";
import { productTaglineKoServingProvider } from "@/lib/llm/product-tagline-ko-serving-contract";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { claimModelSampleComparison, saveModelSampleProgress } from "@/lib/operations/model-sample-compare-repository";
import { applySampleResults, nextSampleBatch, SAMPLE_COMPARE_LIMITS, sampleComplete, type SampleComparison, type SampleSideResult } from "@/lib/operations/model-sample-compare";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";

/**
 * 한국어 소개 표본 비교 한 걸음(2026-11-12 운영 콘솔 조각 3a). 한국어 소개 잡(product-tagline-ko)이 틱 처음에 부른다 —
 * 관리자가 요청한 비교가 있을 때만, 이 잡의 lease·역할로 한 묶음(최대 8건·1,200자)을 지금 모델 또는 후보 모델 하나로 부른다.
 *
 * - 부르는 길은 실제 잡과 같다(translateKoreanTaglinesWithModelCapacity — 계약 확인·정책 route·장부 예약·dispatch·정산). 장부 밖 호출은 없다.
 * - 결과는 기존 품질 검사(checkKoreanTaglineOutput)만 돌려 비교 기록(model_sample_comparisons)에 쓰고, 한국어 소개 표(product_korean_taglines)에는 쓰지 않는다.
 *   그래서 표본 제품은 나중에 실제 잡이 다시 옮긴다.
 * - 용량·접수로 미뤄지면 이 잡이 남긴 대기·예약 줄을 바로 물린다(다른 틱이 주워 실제 쓰기로 가져가지 않게) — 다음 틱에 다시 부른다.
 * - 표본 제품이 그 사이 옮겨졌거나 원문이 바뀌었으면 그 표본은 「이미 처리됨」으로 건너뛴다.
 * 무슨 일이 있어도 실제 잡의 일을 막지 않는다 — 부르는 쪽이 오류를 받아 남기고 넘어간다.
 */

const JOB = "product-tagline-ko";
const TASK = "product-tagline-ko";

type RawConnection = Parameters<typeof aiTaskModelSnapshotRows>[0][number];

/** 기록에 적힌 연결·모델로 이 작업의 순위 묶음을 만든다(실제 순위와 같은 계약 찾기) — 없거나 쓸 수 없으면 까닭 코드 */
async function bindingFor(connectionId: string, model: string): Promise<{ binding: TextTaskRankBinding } | { unusable: string }> {
  await ensureServingContracts();
  const [raw] = await onPrimary(() => db.execute<RawConnection>(sql`SELECT ${TASK}::text AS task, 1 AS slot, 1 AS rank, ${model}::text AS model, true AS enabled,
      '{}'::jsonb AS options, c.id AS connection_id, c.label, c.kind, c.base_url, c.api_key_ciphertext, c.cli_tool, c.device_id,
      c.enabled AS connection_enabled, c.models, c.options AS connection_options, c.version AS connection_version, c.cli_models, c.capacity_slots
    FROM ai_connections c WHERE c.id = ${connectionId}::uuid`));
  if (!raw) return { unusable: "connection_missing" };
  const [rank] = aiTaskModelSnapshotRows([raw]);
  const candidate = bindApiTaskRank(TASK, rank);
  return candidate.binding ? { binding: candidate.binding } : { unusable: candidate.unusable ?? "binding_unusable" };
}

/** 이 프로세스가 이 묶음으로 남긴 대기·예약 줄을 물린다(보낸 줄·결과 모르는 줄은 건드리지 않는다) */
async function withdrawOwnPending(binding: TextTaskRankBinding, productIds: readonly number[]): Promise<void> {
  const owner = capacityOwnerFromEnv();
  if (!owner) return;
  const keys = new Set(productIds.map(id => `product-tagline-ko:${id}`));
  const expected = { owner, model: binding.identity, routeId: TASK, provider: productTaglineKoServingProvider(binding.identity) } as const;
  for (const pending of await findOwnPendingProductTextRequests(expected))
    if (pending.memberKeys.length && pending.memberKeys.every(key => keys.has(key))) await cancelOwnPendingProductTextRequest(pending, expected);
}

/** 지금도 옮길 차례인 표본만(실제 잡과 같은 대기 조건) — 묶음이 그대로면 한 번에, 아니면 하나씩 */
async function stillPending(ids: readonly number[], home: readonly string[]): Promise<KoreanTaglineTask[]> {
  const all = await pendingKoreanTaglineBatch(ids.map(id => `product-tagline-ko:${id}`), home);
  if (all) return all;
  const one = await Promise.all(ids.map(id => pendingKoreanTaglineBatch([`product-tagline-ko:${id}`], home)));
  return one.flatMap(rows => rows ?? []);
}

export type SampleStepOutcome = { kind: "idle" } | { kind: "ran"; id: number; side: string; called: number; status: string };

export async function runKoreanTaglineSampleStep(ctx: Pick<JobContext<null>, "lease" | "signal" | "deadlineAt" | "log" | "hasBudget">): Promise<SampleStepOutcome> {
  const lease = ctx.lease;
  if (!lease) return { kind: "idle" };
  const record = await claimModelSampleComparison(TASK);
  if (!record) return { kind: "idle" };
  const save = (items: SampleComparison["items"], deferrals: number, statusCode: string | null = null, failed = false) => {
    const status = failed ? "failed" as const : sampleComplete({ items, current: record.current }) ? "done" as const : "running" as const;
    return saveModelSampleProgress(record.id, { items, deferrals, status, statusCode }).then(() => status);
  };
  const batch = nextSampleBatch(record);
  if (!batch) return { kind: "ran", id: record.id, side: "none", called: 0, status: await save(record.items, record.deferrals) };
  const target = batch.side === "current" ? record.current : record.candidate;
  const mark = (result: SampleSideResult, ids = batch.items.map(item => item.productId)) =>
    applySampleResults(record.items, batch.side, new Map(ids.map(id => [id, result])));
  if (!target) return { kind: "ran", id: record.id, side: batch.side, called: 0,
    status: await save(mark({ state: "skipped", reason: "no_current_model" }), record.deferrals) };
  const bound = await bindingFor(target.connectionId, target.model);
  if ("unusable" in bound) return { kind: "ran", id: record.id, side: batch.side, called: 0,
    status: await save(mark({ state: "skipped", reason: `unusable:${bound.unusable}` }), record.deferrals) };
  // 남은 틱이 한 번 부르기에 모자라면 다음 틱에(실제 잡과 같은 손잡이)
  const remaining = tickRemaining(ctx, JOB);
  if (remaining() < jobKnob(runtimeSettings(), JOB, "minCallMs")) return { kind: "ran", id: record.id, side: batch.side, called: 0, status: "running" };
  const home = await homeListSlugs();
  const tasks = await stillPending(batch.items.map(item => item.productId), home);
  const gone = batch.items.filter(item => !tasks.some(task => task.productId === item.productId)).map(item => item.productId);
  let items = gone.length ? applySampleResults(record.items, batch.side, new Map(gone.map(id => [id, { state: "skipped", reason: "already_done" } as SampleSideResult]))) : [...record.items];
  if (!tasks.length) return { kind: "ran", id: record.id, side: batch.side, called: 0, status: await save(items, record.deferrals) };
  const timeoutMs = Math.max(1_000, Math.min(modelRouteTimeoutMs(JOB), remaining() - 1_000));
  let outcome: Awaited<ReturnType<typeof translateKoreanTaglinesWithModelCapacity>>;
  try {
    // 실제 잡이 남긴 대기 줄은 이어받지 않는다 — 이 묶음과 같은 제품 묶음(앞서 이 걸음이 남긴 것)만 받는다
    const own = new Set(tasks.map(task => task.productId));
    const pendingClaims = { requestIds: new Set<string>(),
      claimBatch: (batchTasks: readonly KoreanTaglineTask[]) => batchTasks.length === own.size && batchTasks.every(task => own.has(task.productId)) };
    outcome = await runInTextTaskRank(bound.binding, () => translateKoreanTaglinesWithModelCapacity(tasks, home, lease, { timeoutMs, signal: ctx.signal, pendingClaims }));
  } catch (error) {
    if (!(error instanceof ModelCapacityDeferredError)) throw error;
    // 미룸(칸 가득·접수 중단 등) — 남긴 대기 줄을 물리고 다음 틱에 같은 묶음을 다시 부른다. 너무 오래 미뤄지면 닫는다
    await withdrawOwnPending(bound.binding, tasks.map(task => task.productId)).catch(cleanup => ctx.log("tagline_ko.sample_withdraw_failed", { error: String(cleanup).slice(0, 120) }));
    const deferrals = record.deferrals + 1;
    const failed = deferrals >= SAMPLE_COMPARE_LIMITS.maxDeferrals;
    ctx.log("tagline_ko.sample_deferred", { id: record.id, side: batch.side, reason: error.reason, deferrals });
    return { kind: "ran", id: record.id, side: batch.side, called: 0, status: await save(items, deferrals, failed ? `deferred:${error.reason}` : null, failed) };
  }
  if (outcome.kind === "skipped") {
    items = applySampleResults(items, batch.side, new Map(tasks.map(task => [task.productId, { state: "skipped", reason: "input_changed" } as SampleSideResult])));
    return { kind: "ran", id: record.id, side: batch.side, called: 0, status: await save(items, record.deferrals) };
  }
  // 앞서 이 걸음이 남긴 같은 묶음을 이어받았으면 그 차례(outcome.batch)로 결과를 읽는다
  const called = outcome.batch ?? tasks;
  const result = outcome.result;
  const results = new Map<number, SampleSideResult>();
  called.forEach((task, index) => {
    if (!tasks.some(own => own.productId === task.productId)) return;
    if (!result.ok) { results.set(task.productId, { state: "failed", output: null, pass: false, reason: result.error }); return; }
    const output = result.outputs[index] ?? "";
    const checked = checkKoreanTaglineOutput(output, { name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task) });
    results.set(task.productId, checked.ok ? { state: "done", output: checked.line, pass: true, reason: checked.cleaned ? `cleaned:${checked.cleaned}` : null }
      : { state: "done", output: output.slice(0, 400), pass: false, reason: `rejected:${checked.reason}` });
  });
  items = applySampleResults(items, batch.side, results);
  ctx.log("tagline_ko.sample_called", { id: record.id, side: batch.side, model: bound.binding.identity, items: results.size, ok: result.ok });
  return { kind: "ran", id: record.id, side: batch.side, called: results.size, status: await save(items, record.deferrals) };
}
