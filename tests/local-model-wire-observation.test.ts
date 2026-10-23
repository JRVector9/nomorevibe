import { expect, it } from "vitest";
import { observedLocalModelWireHash, recordLocalModelWireObservation } from "@/lib/llm/local-model-wire-observation";

it("keeps a response wire observation separate from server headers and copied responses", () => {
  const hash = "a".repeat(64), response = new Response("{}", { headers: { "x-nmv-wire-hash": "b".repeat(64) } });
  expect(observedLocalModelWireHash(response)).toBeUndefined();
  recordLocalModelWireObservation(response, hash);
  expect(observedLocalModelWireHash(response)).toBe(hash);
  expect(observedLocalModelWireHash(response.clone())).toBeUndefined();
  expect(() => recordLocalModelWireObservation(response, "not-a-hash")).toThrow("invalid_local_model_wire_hash");
});
