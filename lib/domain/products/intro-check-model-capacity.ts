import { configuredModelDefinition, scopedModel } from "@/lib/llm/model-registry";
import { isDeepStrictEqual } from "node:util";
import { db, onPrimary } from "@/lib/db";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { prepareRemoteCliTaskCall } from "@/lib/crawl/cli-task-remote";
import { introCheckInputHash, introCheckLogicalWorkKey, modelCapacityRequestIdentitySchema } from "@/lib/llm/capacity";
import { capturedClaudeCliRun, reviewerModelOwner, runRemoteCliTaskWithModelCapacity } from "@/lib/llm/cli-model-capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { checkIntros, introCheckChatRequest, introCheckChatResult, INTRO_CHECK_MODEL, type IntroCheckResult, type IntroItem } from "./intro-check";
import { lockIntroCheckMembers, type IntroTask } from "./intro-checks";

export type IntroCheckCapacityResult = Readonly<{ kind: "result"; result: IntroCheckResult } | { kind: "skipped" | "not_started" }>;

/**
 * 소개 검수 한 묶음(1–10건)을 공통 슬롯에 묶어 묻는다(05c-5). argv·stdin·parser 는 checkIntros 그대로이고 run 만 runner 로 바뀐다.
 * 슬롯이 미뤄지면 ModelCapacityDeferredError — recordIntroCheck 를 부르지 않으므로 제품별 시도·재시도 시각이 그대로다.
 * skipped(그사이 묶음이 바뀜)·not_started(dispatch 뒤 틱 여유 부족)도 적지 않는다. 기존 cancelled·timeout 시도 소모는 실제로 띄운 호출에만 남는다.
 * cliEngine(local-direct)이 설정되면 같은 묶음·해시·잠금 검사를 원격 CLI 경로로 하고, Claude 경로로 떨어지지 않는다.
 */
export async function checkIntrosWithModelCapacity(tasks: readonly IntroTask[], items: readonly IntroItem[], lease: JobLease,
  options: { timeoutMs: number; signal?: AbortSignal; beforeSpawn: () => boolean; effort?: string }): Promise<IntroCheckCapacityResult> {
  if (lease.name !== "product-intro-check") throw new Error("intro_check_job_lease_required");
  const job = { name: "product-intro-check" as const, token: lease.token, requestedVersion: lease.requestedVersion };
  const definition = configuredModelDefinition("product-intro-check");
  if (definition.cliEngine) {
    // local-direct CLI — Claude 경로로 떨어지지 않는다. 묶음이 그사이 바뀌었으면 아무것도 적지 않는다.
    const model = definition.model;
    const initialMembers = await onPrimary(() => db.transaction(tx => lockIntroCheckMembers(tx, tasks)));
    if (!initialMembers) return { kind: "skipped" };
    const inputHash = introCheckInputHash({ members: initialMembers, model });
    const chat = introCheckChatRequest(items);
    const prepared = await prepareRemoteCliTaskCall({
      task: "product-intro-check",
      connectionId: definition.cliEngine.connectionId,
      model,
      ...(definition.cliEngine.reasoningEffort !== undefined ? { reasoningEffort: definition.cliEngine.reasoningEffort } : {}),
      inputHash,
      messages: chat.messages,
      responseFormat: chat.responseFormat,
      timeoutMs: options.timeoutMs,
    });
    if (prepared.kind === "unsupported") throw new ModelCapacityDeferredError(prepared.reason);
    const native = await runRemoteCliTaskWithModelCapacity(prepared, options.signal, {
      beforeSpawn: options.beforeSpawn,
      plan: async () => {
        const owner = reviewerModelOwner();
        const members = await onPrimary(() => db.transaction(tx => lockIntroCheckMembers(tx, tasks)));
        return members && isDeepStrictEqual(members, initialMembers)
          ? { target: { kind: "intro", members }, identity: modelCapacityRequestIdentitySchema.parse({ owner, class: "background",
            pool: "reviewer", routeId: "product-intro-check", provider: "opencode-cli", model,
            workKey: `${introCheckLogicalWorkKey(members)}:${introCheckInputHash({ members, model })}` }) }
          : null;
      },
      prove: async (tx, call, plan) => {
        const members = await lockIntroCheckMembers(tx, tasks);
        if (!members || plan.target.kind !== "intro" || !isDeepStrictEqual(members, plan.target.members)
          || !isDeepStrictEqual(members, initialMembers)) return null;
        await assertJobLeaseAtWallTime(tx, lease, "update");
        return { kind: "intro_check_cli", version: 1, members, model, logicalWorkKey: introCheckLogicalWorkKey(members),
          inputHash: introCheckInputHash({ members, model }), provider: "opencode-cli", routeId: "product-intro-check", transport: call.transport,
          totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job };
      },
    });
    if (native.kind !== "ran") return { kind: native.kind };
    return { kind: "result", result: introCheckChatResult(items, native.result) };
  }
  const model = scopedModel("product-intro-check", INTRO_CHECK_MODEL);
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
  const result = await checkIntros(items, { timeoutMs: options.timeoutMs, signal: options.signal, run: native.run, effort: options.effort });
  const run = native.settled();
  return !run || run.kind === "ran" ? { kind: "result", result } : { kind: run.kind };
}
