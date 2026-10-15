import { beforeEach, expect, it, vi } from "vitest";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import type { AgentReviewResult } from "@/lib/crawl/agent-review";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { dispatchSecondReviewTransport, secondReviewTransportTimeoutMs,
  type SecondReviewTransportBinding } from "@/lib/crawl/second-review-transport";

const adapters = vi.hoisted(() => ({ fixture: vi.fn(), gateway: vi.fn(), grok: vi.fn(), cli: vi.fn() }));
// Keep the adapters' real constants; replace only the external transport calls.
vi.mock("@/lib/crawl/agent-review", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: adapters.cli,
}));
vi.mock("@/lib/crawl/agent-review-gateway", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: adapters.gateway,
}));
vi.mock("@/lib/crawl/agent-review-grok", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: adapters.grok,
}));
vi.mock("@/lib/crawl/review-fixture-transport", () => ({ dispatchReviewFixtureCall: adapters.fixture }));

const routes = [
  { provider: "abcllm", adapter: "gateway", model: "[MLX] second model", timeout: 60_000 },
  { provider: "grok-cli", adapter: "grok", model: "grok-4.7", timeout: 90_000 },
  { provider: "claude-cli", adapter: "cli", model: "opus", timeout: 20_000 },
] as const;
const answer: AgentReviewResult = { ok: true, outcome: { decision: "approve", confidence: .96,
  reason: "The captured page introduces a task tracker.", evidenceIds: ["product"] },
usage: { inputTokens: 8, outputTokens: 2, costUsd: .02 } };

function input() {
  const now = new Date();
  return createReviewInput({ id: 7, repo: "transport/actual", productUrl: "https://transport.example", judgedAt: now } as CrawlCandidate,
    { id: 3, repo: "transport/actual", productUrl: "https://transport.example", fetchedAt: now, pageStatus: 200,
      repoMeta: { description: "A task tracker" }, pageMeta: { title: "Tasks", textSample: "Create tasks and projects" } } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
function binding(provider: SecondReviewTransportBinding["provider"], model: string): SecondReviewTransportBinding {
  return Object.freeze({ stage: "second", candidateId: 7, firstAttemptId: null, secondReviewId: 23,
    generationKey: "d".repeat(64), vote: 19, provider, model });
}
function noLiveCall() {
  expect(adapters.gateway).not.toHaveBeenCalled();
  expect(adapters.grok).not.toHaveBeenCalled();
  expect(adapters.cli).not.toHaveBeenCalled();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
beforeEach(() => {
  vi.resetAllMocks();
  adapters.fixture.mockResolvedValue(undefined);
  adapters.gateway.mockResolvedValue(answer); adapters.grok.mockResolvedValue(answer); adapters.cli.mockResolvedValue(answer);
});

it.each(routes)("keeps the existing $provider timeout", ({ provider, timeout }) => {
  expect(secondReviewTransportTimeoutMs(provider)).toBe(timeout);
});

it.each(routes)("uses the fixture result before the live $provider adapter", async ({ provider, model, timeout }) => {
  adapters.fixture.mockResolvedValue(answer);
  const request = binding(provider, model), value = input(), signal = new AbortController().signal;
  expect(await dispatchSecondReviewTransport(request, value, { timeoutMs: timeout, signal })).toBe(answer);
  expect(adapters.fixture).toHaveBeenCalledExactlyOnceWith(request, value, { timeoutMs: timeout, signal });
  expect(adapters.fixture.mock.calls[0][0]).toBe(request);
  expect(adapters.fixture.mock.calls[0][1]).toBe(value);
  noLiveCall();
});

it("returns a structured fixture failure without retrying a live adapter", async () => {
  const failure: AgentReviewResult = { ok: false, error: "auth", detail: "fixed_code", usage: { inputTokens: 3 } };
  adapters.fixture.mockResolvedValue(failure);
  expect(await dispatchSecondReviewTransport(binding("abcllm", "second"), input(), { timeoutMs: 60_000 })).toBe(failure);
  noLiveCall();
});

it.each(routes)("routes undefined fixture output only to the actual $provider and preserves input/options", async ({ provider, model, adapter }) => {
  const request = binding(provider, model), value = input(), signal = new AbortController().signal;
  // Caller-selected time is passed unchanged; the original adapter owns its cap.
  expect(await dispatchSecondReviewTransport(request, value, { timeoutMs: 1_234, signal })).toBe(answer);
  expect(adapters[adapter]).toHaveBeenCalledExactlyOnceWith(value, { model, timeoutMs: 1_234, signal });
  expect(adapters[adapter].mock.calls[0][0]).toBe(value);
  for (const other of routes.filter(route => route.adapter !== adapter)) expect(adapters[other.adapter]).not.toHaveBeenCalled();
  expect(adapters.fixture).toHaveBeenCalledExactlyOnceWith(request, value, { timeoutMs: 1_234, signal });
  expect(request).toMatchObject({ firstAttemptId: null, secondReviewId: 23, vote: 19, generationKey: "d".repeat(64) });
});

it("awaits the fixture before deciding whether a live call is needed", async () => {
  const fixture = deferred<AgentReviewResult | undefined>();
  adapters.fixture.mockReturnValue(fixture.promise);
  const pending = dispatchSecondReviewTransport(binding("abcllm", "second"), input(), { timeoutMs: 60_000 });
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve(); noLiveCall(); expect(settled).toBe(false);
  fixture.resolve(answer);
  expect(await pending).toBe(answer); noLiveCall();
});

it.each(["fixture", "gateway", "grok", "cli"] as const)("preserves the original $0 exception without remapping or retrying", async adapter => {
  const error = new Error(`original_${adapter}`);
  adapters[adapter].mockRejectedValue(error);
  const route = routes.find(route => route.adapter === adapter) ?? routes[0];
  await expect(dispatchSecondReviewTransport(binding(route.provider, route.model), input(), { timeoutMs: route.timeout })).rejects.toBe(error);
  if (adapter === "fixture") noLiveCall();
  else for (const other of routes.filter(route => route.adapter !== adapter)) expect(adapters[other.adapter]).not.toHaveBeenCalled();
});

it.each(routes)("preserves the $provider structured failure, detail and usage", async ({ provider, model, adapter, timeout }) => {
  const failure: AgentReviewResult = { ok: false, error: "invalid_output", detail: "schema_validation",
    usage: { inputTokens: 12, outputTokens: 4, costUsd: .01 } };
  adapters[adapter].mockResolvedValue(failure);
  expect(await dispatchSecondReviewTransport(binding(provider, model), input(), { timeoutMs: timeout })).toBe(failure);
});

it("awaits a live adapter after abort and leaves late-success cancellation to its owner", async () => {
  const transport = deferred<AgentReviewResult>(), stopping = new AbortController();
  adapters.gateway.mockReturnValue(transport.promise);
  const pending = dispatchSecondReviewTransport(binding("abcllm", "second"), input(), { timeoutMs: 60_000, signal: stopping.signal });
  let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
  await vi.waitFor(() => expect(adapters.gateway).toHaveBeenCalledTimes(1));
  stopping.abort(); await Promise.resolve();
  expect(settled).toBe(false);
  expect(adapters.gateway.mock.calls[0][1].signal).toBe(stopping.signal);
  transport.resolve(answer); expect(await pending).toBe(answer);
});
