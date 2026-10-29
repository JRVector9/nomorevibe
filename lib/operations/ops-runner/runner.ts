import type { ReclaimPolicyWithReference, DispatchReleaseRow } from "../dr/reclaim";
import { opsStepsFor, type OpsState, type OpsStep } from "./contract";

export type StepResult = { ok: boolean; code?: string; manual?: boolean };
export type OpsDriver = {
  /** Must persist BEFORE returning; throwing here must prevent the next external mutation. */
  save: (state: OpsState) => Promise<void>;
  execute: (step: OpsStep, state: OpsState) => Promise<StepResult>;
  /** Reconcile attempted targets read-only; only untouched subtargets may receive their first mutation. */
  reconcile: (step: OpsStep, state: OpsState) => Promise<StepResult>;
};
type AutoInput = { automatic: true; policies: ReadonlyMap<string, ReclaimPolicyWithReference>; operator: string;
  audit: (event: string, detail: Record<string, unknown>) => void };

/** Both admin commands and PR712 enter here. Automatic mode retains PR712's DB-locked evidence judgement,
 * never stops hosts and never substitutes an elapsed TTL for end evidence. */
export async function runModelOpsRunner(input: AutoInput): Promise<{ rows: DispatchReleaseRow[] }>;
export async function runModelOpsRunner(input: { state: OpsState; driver: OpsDriver }): Promise<OpsState>;
export async function runModelOpsRunner(input: AutoInput | { state: OpsState; driver: OpsDriver }): Promise<OpsState | { rows: DispatchReleaseRow[] }> {
  if ("automatic" in input) {
    if (!input.policies.size) return { rows: [] };
    input.audit("ops_runner.auto.prepare", { budgets: [...input.policies.keys()] });
    const { releaseEvidencedDispatches } = await import("../dr/reclaim");
    const result = await releaseEvidencedDispatches({ policies: input.policies, operator: input.operator, onlyDeclaredBudgets: true }, true);
    input.audit("ops_runner.auto.release", { rows: result.rows });
    return result;
  }
  const { driver } = input;
  let state: OpsState = structuredClone(input.state);
  if (state.status === "completed") return state;
  for (const step of opsStepsFor(state)) {
    if (state.steps[step] === "done") continue;
    const previous = state.steps[step];
    state = { ...state, status: "running", step, code: null, steps: { ...state.steps, [step]: "running" } };
    await driver.save(state);
    let result: StepResult;
    try {
      // All interrupted/failed mutations are reconciled. A known verify-stop failure is retried by read-only verify.
      result = previous && ["stop", "restore", "drain", "open"].includes(step)
        ? await driver.reconcile(step, state) : await driver.execute(step, state);
    } catch (error) {
      // Never serialize remote output, command arguments, exception messages or credentials to the UI/log.
      const known = new Set(["ops_runner_drain_lost", "ops_runner_other_requests_active", "ops_runner_capacity_pin_changed",
        "ops_runner_control_missing", "ops_runner_request_changed", "ops_runner_adapter_changed"]);
      result = { ok: false, code: error instanceof Error && known.has(error.message) ? error.message : "outcome_unknown_readback_required" };
    }
    if (!result.ok) {
      state = { ...state, status: result.manual ? "manual" : "blocked", code: result.code ?? "step_failed",
        steps: { ...state.steps, [step]: result.manual ? "manual" : "blocked" } };
      await driver.save(state);
      return state;
    }
    state = { ...state, steps: { ...state.steps, [step]: "done" } };
    await driver.save(state);
  }
  state = { ...state, status: "completed", code: null };
  await driver.save(state);
  return state;
}
