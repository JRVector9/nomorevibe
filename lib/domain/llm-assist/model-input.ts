import { assistHash, assistInputHash, assistInputSchema, type AssistInput } from "./contracts";
import type { AssistWork } from "./repository";

export type AssistCapacityInput = { kind: "llm_assist"; input: AssistInput; inputHash: string; sourceRevisionHash: string; policyHash: string };
export function assistCapacityInput(work: Pick<AssistWork, "sourceHash" | "policyVersion" | "promptVersion">, value: AssistInput): AssistCapacityInput {
  const input = assistInputSchema.parse(value);
  if (input.policyVersion !== work.policyVersion || input.promptVersion !== work.promptVersion) throw new Error("assist_version_changed");
  return { kind: "llm_assist", input, inputHash: assistInputHash(input), sourceRevisionHash: work.sourceHash,
    policyHash: assistHash({ policyVersion: work.policyVersion }) };
}
