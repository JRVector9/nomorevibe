import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkAi2TokenBudget, verifyAi2TokenBudget } from "@/lib/crawl/second-review-direct-tokenize";

const fixture = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("undici", () => ({ fetch: fixture.request }));
const contract = { model: "fixture-engine", tokenizerEndpoint: "http://tokenizer.test/tokenize",
  totalTokenBound: 50_000, requestTokenBound: 32_000 as const, maxOutputTokens: 1_000 };
const wire = (change: Record<string, unknown> = {}) => JSON.stringify({ model: contract.model, max_tokens: contract.maxOutputTokens,
  stream: false, messages: [{ role: "user", content: "untrusted source" }], chat_template_kwargs: { enable_thinking: false }, ...change });
const reply = (count = 100, change: Record<string, unknown> = {}) => new Response(JSON.stringify({ count,
  max_model_len: contract.totalTokenBound, tokens: Array.from({ length: count }, () => 1), ...change }));
const run = (value = wire(), options: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: 1_000 }) =>
  checkAi2TokenBudget(contract, value, options);
beforeEach(() => { fixture.request.mockReset(); });
afterEach(() => vi.restoreAllMocks());

it("proves overflow only from a complete matching response, including the exact request boundary", async () => {
  fixture.request.mockResolvedValueOnce(reply(31_000)).mockResolvedValueOnce(reply(31_001));
  expect(await run()).toEqual({ kind: "within_budget" });
  expect(await run()).toEqual({ kind: "too_large" });
  const sent = JSON.parse(fixture.request.mock.calls[0][1].body);
  expect(sent).toEqual({ model: contract.model, messages: JSON.parse(wire()).messages, add_generation_prompt: true,
    chat_template_kwargs: { enable_thinking: false } });
});

it.each([401, 403, 404, 429, 500, 503])("keeps HTTP %i unavailable rather than proving an oversized input", async status => {
  fixture.request.mockResolvedValue(new Response("{}", { status }));
  expect(await run()).toEqual({ kind: "unavailable", reason: "http_error" });
});

it.each(["not-json", JSON.stringify({ count: 1, tokens: [] }), JSON.stringify({ count: -1, tokens: [] }),
  JSON.stringify({ count: 1, tokens: [-1] }), JSON.stringify({ count: 1, tokens: [0.5] })])
("keeps malformed tokenizer evidence unavailable: %s", async body => {
  fixture.request.mockResolvedValue(new Response(body));
  expect(await run()).toEqual({ kind: "unavailable", reason: "invalid_response" });
});

it("does not mistake a changed engine context identity for overflow", async () => {
  fixture.request.mockResolvedValue(reply(31_001, { max_model_len: 98_304 }));
  expect(await run()).toEqual({ kind: "unavailable", reason: "contract_mismatch" });
});

it("does not tokenize a mismatched frozen wire or invalid contract", async () => {
  for (const value of ["not-json", wire({ model: "another-engine" }), wire({ max_tokens: 2_000 }), wire({ stream: true })])
    expect(await run(value)).toEqual({ kind: "unavailable", reason: "request_mismatch" });
  expect(await checkAi2TokenBudget({ ...contract, totalTokenBound: 16_000 }, wire(), { timeoutMs: 1_000 }))
    .toEqual({ kind: "unavailable", reason: "contract_mismatch" });
  expect(fixture.request).not.toHaveBeenCalled();
});

it("separates a failed tokenizer transport, an oversized response, cancellation and deadline", async () => {
  fixture.request.mockRejectedValueOnce(new Error("untrusted network detail"));
  expect(await run()).toEqual({ kind: "unavailable", reason: "network" });
  fixture.request.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
  expect(await run()).toEqual({ kind: "unavailable", reason: "response_too_large" });
  expect(await run(wire(), { timeoutMs: 1_000, signal: AbortSignal.abort(new Error("operator cancellation")) }))
    .toEqual({ kind: "cancelled" });
  expect(await run(wire(), { timeoutMs: 1_000, signal: AbortSignal.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" })) }))
    .toEqual({ kind: "unavailable", reason: "timeout" });
  expect(fixture.request).toHaveBeenCalledTimes(2);
});

it("keeps the old boolean helper false for unknown evidence, never a truthy result object", async () => {
  fixture.request.mockResolvedValueOnce(reply()).mockResolvedValueOnce(new Response("{}", { status: 503 }));
  expect(await verifyAi2TokenBudget(contract, wire(), { timeoutMs: 1_000 })).toBe(true);
  expect(await verifyAi2TokenBudget(contract, wire(), { timeoutMs: 1_000 })).toBe(false);
});

it("classifies a deadline during tokenizer transport as unavailable, and caller cancellation as cancelled", async () => {
  const signals: AbortSignal[] = [];
  fixture.request.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    // Fetch accepts both (url, init) and Request. Observe the effective transport signal in either form.
    const signal = new Request(input, init).signal;
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  expect(await run(wire(), { timeoutMs: 1 })).toEqual({ kind: "unavailable", reason: "timeout" });
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
  expect(signals[0].reason).toMatchObject({ name: "TimeoutError" });
  const controller = new AbortController(), running = run(wire(), { timeoutMs: 1_000, signal: controller.signal });
  const cancellation = new Error("caller cancellation");
  controller.abort(cancellation);
  expect(await running).toEqual({ kind: "cancelled" });
  expect(signals).toHaveLength(2);
  expect(signals[1].aborted).toBe(true);
  expect(signals[1].reason).toBe(cancellation);
  expect(fixture.request).toHaveBeenCalledTimes(2);
});
