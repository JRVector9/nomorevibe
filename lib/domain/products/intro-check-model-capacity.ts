import { isDeepStrictEqual } from "node:util";
import { db, onPrimary } from "@/lib/db";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { introCheckInputHash, introCheckLogicalWorkKey, modelCapacityRequestIdentitySchema } from "@/lib/llm/capacity";
import { capturedClaudeCliRun, reviewerModelOwner } from "@/lib/llm/cli-model-capacity";
import { checkIntros, INTRO_CHECK_MODEL, type IntroCheckResult, type IntroItem } from "./intro-check";
import { lockIntroCheckMembers, type IntroTask } from "./intro-checks";

export type IntroCheckCapacityResult = Readonly<{ kind: "result"; result: IntroCheckResult } | { kind: "skipped" | "not_started" }>;

/**
 * 소개 검수 한 묶음(1–10건)을 공통 슬롯에 묶어 묻는다(05c-5). argv·stdin·parser 는 checkIntros 그대로이고 run 만 runner 로 바뀐다.
 * 슬롯이 미뤄지면 ModelCapacityDeferredError — recordIntroCheck 를 부르지 않으므로 제품별 시도·재시도 시각이 그대로다.
 * skipped(그사이 묶음이 바뀜)·not_started(dispatch 뒤 틱 여유 부족)도 적지 않는다. 기존 cancelled·timeout 시도 소모는 실제로 띄운 호출에만 남는다.
 */
export async function checkIntrosWithModelCapacity(tasks: readonly IntroTask[], items: readonly IntroItem[], lease: JobLease,
  options: { timeoutMs: number; signal?: AbortSignal; beforeSpawn: () => boolean }): Promise<IntroCheckCapacityResult> {
  if (lease.name !== "product-intro-check") throw new Error("intro_check_job_lease_required");
  const model = INTRO_CHECK_MODEL, job = { name: "product-intro-check" as const, token: lease.token, requestedVersion: lease.requestedVersion };
  const native = capturedClaudeCliRun("product-intro-check", model, {
    beforeSpawn: options.beforeSpawn,
    plan: async () => {
      const owner = reviewerModelOwner();
      const members = await onPrimary(() => db.transaction(tx => lockIntroCheckMembers(tx, tasks)));
      return members && { target: { kind: "intro", members }, identity: modelCapacityRequestIdentitySchema.parse({ owner, class: "background",
        pool: "reviewer", routeId: "product-intro-check", provider: "claude-cli", model,
        workKey: `${introCheckLogicalWorkKey(members)}:${introCheckInputHash({ members, model })}` }) };
    },
    prove: async (tx, call, plan) => {
      const members = await lockIntroCheckMembers(tx, tasks);
      if (!members || plan.target.kind !== "intro" || !isDeepStrictEqual(members, plan.target.members)) return null;
      await assertJobLeaseAtWallTime(tx, lease, "update");
      return { kind: "intro_check_cli", version: 1, members, model, logicalWorkKey: introCheckLogicalWorkKey(members),
        inputHash: introCheckInputHash({ members, model }), provider: "claude-cli", routeId: "product-intro-check", transport: call.transport,
        totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job };
    },
  });
  const result = await checkIntros(items, { timeoutMs: options.timeoutMs, signal: options.signal, run: native.run });
  const run = native.settled();
  return !run || run.kind === "ran" ? { kind: "result", result } : { kind: run.kind };
}
