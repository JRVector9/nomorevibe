import { modelRequestBudget, modelRouteTimeoutMs } from "@/lib/llm/model-registry";
import { deferredJob, type JobContext, type JobOutcome } from "@/lib/jobs/runner";
import { tickRemaining } from "@/lib/jobs/tick-deadline";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel, modelCapacityDeferralIsPerWork } from "@/lib/llm/capacity-deferred";
import { getSettings } from "@/lib/crawl/settings";
import { taglineEvidence, taglineHash } from "@/lib/crawl/tagline";
import { writeCrawlTaglineWithModelCapacity } from "@/lib/crawl/tagline-model-capacity";
import { pendingTaglines, recordTaglineResult, readCrawlTaglineAffinityMember } from "@/lib/crawl/taglines";
import { jobKnob } from "@/lib/operations/runtime-settings-schema";
import { runtimeSettings } from "@/lib/operations/runtime-settings-store";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { pendingTextPoolTargetModel } from "@/lib/llm/text-task-pool-resume";
import { TextTaskRanks } from "@/lib/llm/ai-task-resolver";

/**
 * 소개 짓기 — 페이지에도 레포에도 소개가 없어 발행이 멈춘 후보의 한 줄을 모델이 짓는다.
 *
 * 전용 text 워커에서 번역·소개 생성이 차례로 돈다. 발행 워커는 이 호출을 기다리지 않는다.
 *
 * 지은 줄로 곧바로 발행하지 않는다. 후보를 "승인됨"으로 되돌려 놓기만 하고, 발행할지는 발행 잡이
 * 평소 관문(두 모델 승인·원본 리비전·분류)을 그대로 거쳐 정한다.
 *
 * 한도는 틱마다 읽는다(관리자 실시간 한도 — 저장하면 재배포 없이 다음 틱에 반영):
 * - 묶음(batch 12: 한 건이 4초쯤이라 둘씩 돌리면 한 틱에 20여 건)·최소 남은 시간(minCallMs 15초: 틱 끝에 부르면 제한이 짧아져
 *   헛실패가 난다)은 runtime_settings jobs.crawl-tagline,
 * - 동시 호출·한 번 부르는 데 둘 시간은 등록부 경로 crawl-tagline(routes.limits / routes.timeouts),
 * - 틱의 남은 시간은 러너가 준 deadlineAt(틱 예산 budgets)에서 — 잡 안의 TICK_MS 상수는 없다(lib/jobs/tick-deadline.ts).
 *
 * 2026-10-30 소유자 결정("미확인이 되어도 절대 멈추지 않는다"): 한 후보만의 미룸(dispatched·work_busy — 앞선 단계가 보내진 중이거나
 * 미확인 단계 행·다른 요청이 같은 후보를 쥠)은 그 후보만 이 틱에서 넘기고 다음 후보를 계속 본다. 다른 요청에 묶인 후보는 고르기에서도
 * 뺀다(pendingTaglines skipBusy). 포화·정책·owner 미룸만 예전처럼 틱을 미룬다.
 * 2026-10-31(PR 3a-B): 한 후보의 실패(시간 초과·429·5xx)는 그 후보의 시도로만 남고 다음 후보를 본다 — 예전의 "잇따라 둘이 막히면 틱을 접는다"는
 * 없앴다. 틱을 접는 것은 엔진이 모든 후보에 대해 내려갔음이 증명될 때만이다(lib/jobs/engine-down.ts).
 * 2026-11-02(PR B, 「작업 ↔ 모델」 1~3순위): 모델·주소·키는 순위가 고른다(lib/llm/ai-task-resolver.ts). 한 순위만의 까닭(경로 없음·장비 행 없음·
 * 계약 닫힘·포화·엔진 내려감)이면 그 순위를 이 틱 동안 쉬게 하고 같은 후보를 다음 순위로 넘긴다. 순위가 없으면 no_task_models, 모두 쓸 수 없으면
 * all_ranks_unusable 로 제 일 못 한 틱을 남긴다(관리자 상태 화면). 틱 끝의 ai_task.ranks 가 순위마다 맡은 수·쉰 까닭을 센다.
 */
const JOB = "crawl-tagline";

type Flow = "next" | "stop";

export async function writeTaglines(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  // 「작업 ↔ 모델」 순위(PR B)만 부른다 — 순위마다 그 연결을 가리키는 엔진 직접 계약(관리자 엔진 연결·순위 저장이 만든다)이 있어야 쓸 수 있다.
  // 순위가 없거나 모두 쓸 수 없으면 코드 기본값·환경변수로 부르지 않고 제 일 못 한 틱(degraded)으로 남긴다 — 관리자 상태 화면에 보인다.
  const ranks = await TextTaskRanks.open(JOB);
  try { return await writeTaglinesWithRanks(ctx, ranks); }
  finally { ctx.log("ai_task.ranks", ranks.summary()); }
}

async function writeTaglinesWithRanks(ctx: JobContext<null>, ranks: TextTaskRanks): Promise<JobOutcome<null>> {
  const early = ranks.earlyDegraded();
  if (early) {
    ctx.log("tagline.skipped", { reason: early.code });
    return { done: true, degraded: early };
  }
  const settings = await getSettings();
  if (!settings.enabled) {
    ctx.log("tagline.skipped", { reason: "disabled" });
    return { done: true };
  }

  const lease = ctx.lease;
  if (!lease) throw new Error("Tagline worker requires a job lease");
  const controller = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
  ownershipPoll.unref?.();
  try {
    const startedAt = Date.now();
    const remaining = tickRemaining(ctx, JOB, startedAt);
    const knobs = runtimeSettings();
    const batch = jobKnob(knobs, JOB, "batch"), minCallMs = jobKnob(knobs, JOB, "minCallMs");
    const concurrency = modelRequestBudget(JOB).concurrency, callMs = modelRouteTimeoutMs(JOB);
    let written = 0, empty = 0, failed = 0, released = 0, blocked = "";
    /** 이 틱에 넘긴 후보(같은 작업의 미룸) — 다시 고르지 않는다 */
    const passed = new Set<number>();

    while (!signal.aborted && ctx.hasBudget() && remaining() >= minCallMs) {
      const tasks = (await pendingTaglines(batch, { skipBusy: true, exclude: [...passed] }))
        .filter(task => !passed.has(task.candidate.id));
      if (tasks.length === 0) {
        ctx.log("tagline.done", { written, empty, failed, released, passed: passed.size, drained: true });
        return { done: true };
      }

      let next = 0, skipped = false;
      const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        try {
          for (let index = next++; index < tasks.length; index = next++) {
            if (skipped || blocked || ranks.exhausted || signal.aborted || !ctx.hasBudget() || remaining() < minCallMs) return;
            const task = tasks[index];
            try {
              const { candidate, document, written: stored } = task;
              const evidence = taglineEvidence(candidate.repo, document);
              const sourceHash = taglineHash(evidence);

              /**
               * 다시 긁혔지만 내용은 그대로다 — 본 판만 새로 적고 넘어간다.
               *
               * 실패한 줄은 여기서 넘기면 안 된다. 실패도 그때 본 원본의 해시를 남기므로, 해시만 보고
               * 건너뛰면 다시 볼 시각이 지나도 영영 다시 묻지 않는다 — 프로드에서 게이트웨이 502 를 만난
               * 7건이 90분 동안 시도 1회에 멈춘 채 대기열을 차지했다(2026-09-20).
               */
              if (stored && stored.sourceHash === sourceHash && !stored.errorCode) {
                const saved = await recordTaglineResult(task, lease, { kind: "reuse" });
                if (saved.released) released++;
                if (!saved.stored) return;
                continue;
              }
              // 읽을 글이 아무 데도 없다. 모델을 불러도 지을 수 없으므로 사람에게 남긴다
              if (!evidence.pageText && !evidence.readme && !evidence.pageTitle) {
                const saved = await recordTaglineResult(task, lease, { kind: "success", tagline: "", source: "page", model: "" });
                if (!saved.stored) return;
                empty++;
                continue;
              }

              // 순위 차례로 부른다 — 이 모델만의 까닭(경로 없음·장비 행 없음·계약 닫힘·포화)이면 같은 후보를 다음 순위로(TextTaskRanks.run)
              let prefer: string | null = null;
              if (ranks.mode === 'workload_pool') {
                const member = await readCrawlTaglineAffinityMember(task);
                if (!member) { passed.add(task.candidate.id); continue; }
                prefer = await pendingTextPoolTargetModel(ranks, { routeId: JOB, member });
              }
              const attempt = await ranks.run(async (binding): Promise<Flow> => {
                let capacity = await writeCrawlTaglineWithModelCapacity(task, lease,
                  { signal, timeoutMs: Math.max(1_000, Math.min(callMs, remaining() - 1_000)) });
                if (capacity.kind === "skipped") { skipped = true; return "stop"; }
                let result = capacity.result;
                /**
                 * 빈 줄("증거로는 무엇인지 알 수 없다")은 흔들리는 답이다 — 같은 증거로 다시 물으면 멀쩡한
                 * 줄이 오는 때가 14건 중 3~4건이었다(2026-09-20 프로드 실측, 온도 0인데도 그렇다).
                 * 한 번만 더 묻는다. 두 번 다 빈 줄이면 그 후보는 사람이 본다. 둘째 물음은 첫 물음과 같은 순위다(장부의 이어 묻기는 모델에 묶인다).
                 */
                if (result.ok && !result.tagline && !signal.aborted && ctx.hasBudget() && remaining() >= minCallMs
                  && capacity.askOrdinal === 1) {
                  try {
                    capacity = await writeCrawlTaglineWithModelCapacity(task, lease,
                      { signal, timeoutMs: Math.max(1_000, Math.min(callMs, remaining() - 1_000)), previous: capacity });
                  } catch (error) {
                    // 첫 물음은 이 순위로 끝났다 — 둘째 물음을 다른 순위로 옮기지 않는다. 이 순위를 쉬게 하고 이 후보만 넘긴다(다음 틱이 이어 묻는다)
                    if (error instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerModel(error.reason)) {
                      ranks.pause(binding, error.reason);
                      throw new ModelCapacityDeferredError("reservation_lost");
                    }
                    throw error;
                  }
                  if (capacity.kind === "skipped") { skipped = true; return "stop"; }
                  result = capacity.result;
                }
                const save = (value: Parameters<typeof recordTaglineResult>[2]) => capacity.kind === "result" && capacity.expectation
                  ? recordTaglineResult(task, lease, value, capacity.expectation) : recordTaglineResult(task, lease, value);
                if (signal.aborted) return "stop";
                if (!result.ok) {
                  const saved = await save({ kind: "failure", error: result.error });
                  if (!saved.stored) { skipped = capacity.kind === "result"; return "stop"; }
                  failed++;
                  // 그 후보의 실패로 남겼다(같은 증거에만 502 를 돌려주는 긴 페이지 글이 있었다 — 2026-09-20). 엔진이 모든 후보에 대해
                  // 내려갔음이 증명되면(engine-down.ts) 이 순위만 쉬고 다음 후보는 다음 순위로 간다
                  if (ranks.failed(binding, result.error)) ctx.log("tagline.rank_down", binding.memberId
                    ? { memberId: binding.memberId, configRevision: binding.configRevision } : { rank: binding.rank });
                  return "next";
                }
                ranks.answered(binding);
                const saved = await save({ kind: "success", tagline: result.tagline, source: result.source, model: textTaskModel(JOB) });
                if (!saved.stored) { skipped = capacity.kind === "result"; return "stop"; }
                if (!result.tagline) { empty++; return "next"; }
                written++;
                if (saved.released) released++;
                return "next";
              }, { prefer });
              // 모든 순위를 이 틱에 쓸 수 없다 — 이 후보는 그대로 두고(호출·시도 기록 없음) 틱을 접는다
              if (attempt.kind === "unusable") return;
              if (attempt.value === "stop") return;
            } catch (error) {
              if (!(error instanceof ModelCapacityDeferredError) || !modelCapacityDeferralIsPerWork(error.reason)) throw error;
              // 이 후보만의 미룸이다(호출·시도·실패 기록 없음) — 이 후보를 넘기고 같은 줄의 다음 후보로 간다.
              passed.add(task.candidate.id);
              ctx.log("tagline.passed", { repo: task.candidate.repo, reason: error.reason });
            }
          }
        } catch (error) {
          if (error instanceof ModelCapacityDeferredError) blocked ||= "model_capacity";
          else { blocked = "result_write_failed"; controller.abort(); }
          throw error;
        }
      }));
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      const failure = failures.find(result => !(result.reason instanceof ModelCapacityDeferredError)) ?? failures[0];
      if (failure) {
        const processed = written + empty + failed;
        if (failure.reason instanceof ModelCapacityDeferredError && processed >= 1) return deferredJob("model_capacity", processed);
        throw failure.reason;
      }
      if (skipped) return { done: false };
      if (ranks.exhausted || !ranks.usable().length) {
        // 모든 순위가 이 틱에 쉰다. 포화면 예전처럼 미루고(줄이 풀리면 곧 다시), 아니면 일을 했을 때만 보통 틱 — 한 건도 못 했으면 까닭을 남긴다
        const processed = written + empty + failed;
        if (ranks.saturated()) return deferredJob("model_capacity", processed);
        // 쓸 수 있던 순위가 모두 엔진 쪽 까닭으로 쉰다 — 예전의 「엔진이 내려가 틱을 접는다」(engine-down.ts)와 같다
        const down = ranks.engineDown();
        if (down) {
          ctx.log("tagline.gateway_blocked", { error: down, written, empty, failed, released });
          return { done: true };
        }
        ctx.log("tagline.all_ranks_unusable", { written, empty, failed, released, processed });
        return processed ? { done: false } : { done: true, degraded: ranks.degraded() };
      }
    }

    ctx.log("tagline.done", { written, empty, failed, released, drained: false });
    return { done: false };
  } finally { clearInterval(ownershipPoll); }
}
