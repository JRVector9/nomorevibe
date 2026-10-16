import { beforeEach, expect, it, vi } from "vitest";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { assertCliModelAdmission } from "@/lib/llm/cli-capacity-admission";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: mocks.read }));

const route = { routeId: "product-intro-check", provider: "claude-cli", model: "sonnet" } as const;
const control = (mode: string, routes: Array<{ routeId: string; provider: string; model: string }> = [route]) =>
  ({ mode, epoch: 1, revision: 1, policyHash: "a".repeat(64), policy: { routes } });

beforeEach(() => { vi.resetAllMocks(); });

it("disabled returns after exactly one control read", async () => {
  mocks.read.mockResolvedValue({ mode: "disabled", epoch: 1, revision: 1, policyHash: null, policy: null });
  await expect(assertCliModelAdmission(route)).resolves.toBeUndefined();
  expect(mocks.read).toHaveBeenCalledTimes(1);
});

it.each([
  { name: "draining", value: control("draining"), reason: "draining" },
  { name: "open exact mapping", value: control("open"), reason: "provider_contract_unavailable" },
  { name: "open other provider", value: control("open", [{ ...route, provider: "grok-cli" }]), reason: "unmapped" },
  { name: "open other model", value: control("open", [{ ...route, model: "opus" }]), reason: "unmapped" },
  { name: "open other route", value: control("open", [{ ...route, routeId: "product-audit" }]), reason: "unmapped" },
  { name: "open without routes", value: control("open", []), reason: "unmapped" },
])("$name is a typed admission refusal, never a permit", async ({ value, reason }) => {
  mocks.read.mockResolvedValue(value);
  const refusal = await assertCliModelAdmission(route).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(ModelCapacityDeferredError);
  expect(refusal).toMatchObject({ reason });
});

it("an unknown control mode is an error, not a defer", async () => {
  mocks.read.mockResolvedValue(control("paused"));
  await expect(assertCliModelAdmission(route)).rejects.toThrow("model_capacity_control_invalid");
});

it.each([
  { routeId: "product-intro-check", provider: "abcllm" },
  { routeId: "grok-session-check", provider: "claude-cli" },
  { routeId: "product-audit", provider: "grok-cli" },
  { routeId: "crawl-agent-review", provider: "claude-cli" },
  { routeId: "toString", provider: "claude-cli" },
])("rejects the unknown CLI route $routeId/$provider before reading control", async input => {
  await expect(assertCliModelAdmission({ ...input, model: "sonnet" } as never)).rejects.toThrow("invalid_cli_model_route");
  expect(mocks.read).not.toHaveBeenCalled();
});
