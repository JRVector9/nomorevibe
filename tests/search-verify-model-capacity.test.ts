import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { SearchVerifyInput, SearchVerifyMember, SearchVerifyOutcome, SearchVerifyParent, SearchVerifyStep } from "@/lib/llm/capacity";
import type { ProfileTask } from "@/lib/domain/products/search-profiles";
import type { JobContext } from "@/lib/jobs/runner";

// Coordinator boundary only: the ledger, domain TX and native leaf are scripted fixtures, never DB or provider authority.
const state = vi.hoisted(() => ({
  mode: "open" as "open" | "disabled" | "draining", mapped: true,
  continuation: null as null | Record<string, unknown>,
  slots: [] as ("granted" | "capacity")[], prepares: [] as ("ready" | "expired" | "skipped")[],
  replies: [] as ({ result: { ok: true; unsupported: string[] } | { ok: false; error: string }; outcome: SearchVerifyOutcome | null; delayMs?: number })[],
  posts: [] as { keywords: string[]; timeoutMs: number; requestId: string }[],
  inputs: [] as SearchVerifyInput[], reserved: [] as { remainingMs: number; input: SearchVerifyInput }[],
  cancelled: 0, marked: [] as string[], settled: [] as string[], legacy: [] as string[],
  writes: vi.fn(), pending: vi.fn(),
}));
vi.mock("@/lib/llm/capacity-repository", () => ({
  readModelCapacityCallerControl: async () => ({ mode: state.mode, epoch: 1, revision: 1, policyHash: null,
    policy: { routes: state.mapped ? [{ routeId: "product-search-verify", provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }] : [] } }),
  findOwnPendingModelRequest: async () => null,
  requestSearchVerifyModelSlot: async (request: { requestId: string }, input: SearchVerifyInput) => {
    state.inputs.push(structuredClone(input));
    const next = state.slots.shift() ?? "granted";
    return next === "granted" ? { kind: "granted", reservation: { requestId: request.requestId } } : { kind: "deferred", reason: next };
  },
  cancelReservedModelSlot: async () => { state.cancelled++; return true; },
  markModelDispatchIndeterminate: async (dispatch: { requestId: string }) => { state.marked.push(dispatch.requestId); return true; },
  reconcileSearchVerifyGatewayTerminal: async (terminal: { requestId: string }) => { state.settled.push(terminal.requestId); return { kind: "settled" }; },
  readSearchVerifyContinuation: async () => state.continuation ?? { generationHash: "9".repeat(64), nowMs: Date.now(), unresolved: false, nextExecution: 0, latest: null },
}));
vi.mock("@/lib/domain/products/search-profiles", () => ({
  pendingVerifications: state.pending, recordVerificationResult: state.writes, sealSearchVerifyWriteExpectation: () => {},
  prepareSearchVerifyModelDispatch: async (_task: unknown, _lease: unknown, options: { mode: "full" | "chunk"; keywords: string[];
    reserved?: { remainingMs: number; input: SearchVerifyInput; reservation: { requestId: string } } }) => {
    if (!options.reserved) return state.mode === "disabled" ? { kind: "disabled" } : { kind: "ready", role: { instanceId: "text-unit", bootId: boot }, expectation,
      member: member(options.mode, options.mode === "chunk" ? new Set(options.keywords).size : options.keywords.length) };
    state.reserved.push({ remainingMs: options.reserved.remainingMs, input: structuredClone(options.reserved.input) });
    const next = state.prepares.shift() ?? "ready";
    return next === "ready" ? { kind: "ready", dispatch: { requestId: options.reserved.reservation.requestId, bindingHash: "b".repeat(64) } } : { kind: next };
  },
}));
vi.mock("@/lib/crawl/agent-review-gateway", () => ({
  prepareSearchVerifyGatewayCall: (item: { keywords: string[] }, options: { timeoutMs: number }) => ({ kind: "prepared", keywords: item.keywords, timeoutMs: options.timeoutMs }),
  verifyKeywordsWithReservedGateway: async (item: { keywords: string[] }, dispatch: { requestId: string }, _call: unknown, options: { timeoutMs: number }) => {
    state.posts.push({ keywords: [...item.keywords], timeoutMs: options.timeoutMs, requestId: dispatch.requestId });
    const reply = state.replies.shift() ?? { result: { ok: true, unsupported: [] }, outcome: { ok: true, removed: [] } };
    if (reply.delayMs) vi.setSystemTime(Date.now() + reply.delayMs);
    return { result: reply.result, terminal: reply.outcome ? { requestId: dispatch.requestId, outcome: reply.outcome } : null };
  },
  readSearchVerifyGatewayTerminal: (terminal: { requestId: string; outcome: SearchVerifyOutcome } | null) =>
    terminal ? { responseHash: "d".repeat(64), outcome: terminal.outcome } : null,
}));
vi.mock("@/lib/domain/products/search-verify", async load => ({ ...await load<typeof import("@/lib/domain/products/search-verify")>(),
  verifyKeywords: async (item: { keywords: string[] }) => { state.legacy.push(`full:${item.keywords.length}`); return { ok: true, unsupported: [] }; },
  verifyKeywordsInChunks: async (item: { keywords: string[] }) => { state.legacy.push(`chunk:${item.keywords.length}`); return { ok: true, unsupported: [] }; } }));
const { verifyKeywordsWithModelCapacity } = await import("@/lib/domain/products/search-verify-model-capacity");
const { verifySearchKeywords } = await import("@/lib/jobs/products/search-verify");

const boot = randomUUID(), expectation = Object.freeze({ kind: "search_verify_write" as const });
const keywords = Array.from({ length: 12 }, (_, index) => `keyword-${index}`);
function member(mode: "full" | "chunk" = "chunk", count = 12): SearchVerifyMember {
  return { productId: 7, slug: "docs", evidenceHash: "e".repeat(64), profile: { rowIdentityHash: "f".repeat(64), sourceRevision: 0, verifyAttempts: 1 },
    keywordsHash: "a".repeat(64), keywordCount: count, mode, policyHash: "c".repeat(64) };
}
function task(words = keywords, verifyError: string | null = "invalid_output"): ProfileTask {
  return { product: { id: 7, slug: "docs", name: "Docs", url: "https://docs.test", category: "Tools", tagline: "Docs", description: "Docs",
    status: "verified", searchTopics: null, searchPageText: null, searchReadme: null },
  reviewerNote: null, profile: { keywordsEn: words, keywordsKo: [], verifyError } as unknown as ProfileTask["profile"] };
}
const lease = { name: "product-search-verify", token: randomUUID(), requestedVersion: 1 };
const role = { role: "text" as const, instanceId: "text-unit", bootId: boot, release: "unit", epoch: 1, kind: "primary" as const };
const ok = (removed: string[] = []) => ({ result: { ok: true as const, unsupported: removed }, outcome: { ok: true as const, removed } });
const invalid = () => ({ result: { ok: false as const, error: "invalid_output" }, outcome: { ok: false as const, error: "invalid_output" as const } });
const run = (overrides: Partial<Parameters<typeof verifyKeywordsWithModelCapacity>[2]> = {}, value = task()) =>
  verifyKeywordsWithModelCapacity(value, lease, { timeoutMs: 60_000, chunked: true, roleLease: role, ...overrides });
const parent = (): SearchVerifyParent => ({ requestId: randomUUID(), bindingHash: "b".repeat(64), responseHash: "d".repeat(64) });
function resumable(next: SearchVerifyStep | "done" | "stop", deadlineInMs: number, outcomes: { step: SearchVerifyStep; outcome: SearchVerifyOutcome }[]) {
  const now = Date.now();
  state.continuation = { generationHash: "9".repeat(64), nowMs: now, unresolved: false, nextExecution: 3,
    latest: { execution: 2, deadlineAt: now + deadlineInMs, parent: parent(), next, outcomes } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.stubEnv("ABCLLM_API_KEY", "unit-only");
  Object.assign(state, { mode: "open", mapped: true, continuation: null, slots: [], prepares: [], replies: [], posts: [], inputs: [], reserved: [],
    cancelled: 0, marked: [], settled: [], legacy: [] });
  state.writes.mockReset(); state.pending.mockReset(); state.writes.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("one permit, one physical POST, legacy step order", () => {
  it("keeps the disabled leaf and both legacy entry points without any ledger call", async () => {
    state.mode = "disabled";
    expect(await run()).toEqual({ kind: "result", result: { ok: true, unsupported: [] } });
    expect(await run({ chunked: false })).toEqual({ kind: "result", result: { ok: true, unsupported: [] } });
    expect(state.legacy).toEqual(["chunk:12", "full:12"]); expect(state.inputs).toEqual([]); expect(state.posts).toEqual([]);
  });
  it("sends full mode once with the original order, duplicates and unshortened legacy timeout", async () => {
    const words = ["b", "a", "b"]; state.replies = [ok(["a"])];
    expect(await run({ chunked: false }, task(words, null))).toEqual({ kind: "result", result: { ok: true, unsupported: ["a"] }, expectation });
    expect(state.posts.map(post => [post.keywords, post.timeoutMs])).toEqual([[["b", "a", "b"], 60_000]]);
    expect(state.inputs.map(input => input.step)).toEqual([{ kind: "full" }]);
    expect(state.reserved[0].remainingMs).toBe(60_000);
  });
  it("validates every five-keyword chunk sequentially, one permit each", async () => {
    state.replies = [ok(["keyword-1"]), ok([]), ok(["keyword-11"])];
    expect(await run()).toEqual({ kind: "result", result: { ok: true, unsupported: ["keyword-1", "keyword-11"] }, expectation });
    expect(state.posts.map(post => post.keywords.length)).toEqual([5, 5, 2]);
    expect(state.inputs.map(input => input.step)).toEqual([0, 1, 2].map(chunk => ({ kind: "chunk", chunk })));
    expect(new Set(state.posts.map(post => post.requestId)).size).toBe(3);
    expect(state.inputs.map(input => input.parent === null)).toEqual([true, false, false]);
    expect(state.settled).toHaveLength(3); expect(state.marked).toEqual([]);
  });
  it("retries only an invalid multi-keyword chunk one keyword at a time and chains each parent", async () => {
    state.replies = [invalid(), ...[0, 1, 2, 3, 4].map(index => ok(index === 2 ? ["keyword-2"] : [])), ok(), ok()];
    expect(await run()).toEqual({ kind: "result", result: { ok: true, unsupported: ["keyword-2"] }, expectation });
    expect(state.posts.map(post => post.keywords.length)).toEqual([5, 1, 1, 1, 1, 1, 5, 2]);
    expect(state.inputs.slice(0, 3).map(input => input.step)).toEqual([{ kind: "chunk", chunk: 0 }, { kind: "single", chunk: 0, item: 0 },
      { kind: "single", chunk: 0, item: 1 }]);
    expect(state.inputs.every((input, index) => index === 0 || input.parent?.requestId === state.posts[index - 1].requestId)).toBe(true);
  });
  it("stops at an invalid singleton and never sends a singleton after timeout or transport failure", async () => {
    state.replies = [invalid(), ok(), invalid()];
    expect(await run()).toEqual({ kind: "result", result: { ok: false, error: "invalid_output" }, expectation });
    expect(state.posts.map(post => post.keywords.length)).toEqual([5, 1, 1]);
    for (const error of ["timeout", "network", "http_503", "rate_limit"]) {
      Object.assign(state, { posts: [], marked: [], replies: [{ result: { ok: false, error }, outcome: null }] });
      expect(await run()).toEqual({ kind: "result", result: { ok: false, error }, expectation });
      expect(state.posts).toHaveLength(1); expect(state.marked).toHaveLength(1);
    }
  });
  it("records no physical success before every keyword is verified", async () => {
    state.replies = [ok(["keyword-0"])]; state.slots = ["granted", "capacity"];
    await expect(run()).rejects.toMatchObject({ reason: "capacity" });
    expect(state.posts).toHaveLength(1); expect(state.writes).not.toHaveBeenCalled();
  });
});

describe("shared deadline continuation", () => {
  it("resumes the stored execution with its parent, prefix and remaining deadline only", async () => {
    resumable({ kind: "chunk", chunk: 1 }, 20_000, [{ step: { kind: "chunk", chunk: 0 }, outcome: { ok: true, removed: ["keyword-3"] } }]);
    state.replies = [ok(["keyword-6"]), ok()];
    expect(await run()).toEqual({ kind: "result", result: { ok: true, unsupported: ["keyword-3", "keyword-6"] }, expectation });
    expect(state.inputs.map(input => [input.execution, input.step])).toEqual([[2, { kind: "chunk", chunk: 1 }], [2, { kind: "chunk", chunk: 2 }]]);
    expect(state.inputs[0].parent).toEqual((state.continuation as { latest: { parent: SearchVerifyParent } }).latest.parent);
    expect(state.posts.every(post => post.timeoutMs <= 20_000)).toBe(true);
    expect(state.posts.map(post => post.keywords.length)).toEqual([5, 2]);
  });
  it("uses the tick budget when it is shorter than the stored deadline", async () => {
    resumable({ kind: "chunk", chunk: 1 }, 50_000, []);
    await run({ timeoutMs: 15_000 });
    expect(state.posts[0].timeoutMs).toBeLessThanOrEqual(15_000);
  });
  it("discards an expired prefix and starts a new execution from its first step with a fresh deadline", async () => {
    resumable({ kind: "chunk", chunk: 2 }, 0, [{ step: { kind: "chunk", chunk: 0 }, outcome: { ok: true, removed: ["keyword-0"] } },
      { step: { kind: "chunk", chunk: 1 }, outcome: { ok: true, removed: ["keyword-5"] } }]);
    state.replies = [ok(), ok(), ok(["keyword-11"])];
    expect(await run()).toEqual({ kind: "result", result: { ok: true, unsupported: ["keyword-11"] }, expectation });
    expect(state.inputs.map(input => [input.execution, input.step])).toEqual([0, 1, 2].map(chunk => [3, { kind: "chunk", chunk }]));
    expect(state.inputs[0].parent).toBeNull(); expect(state.reserved[0].remainingMs).toBe(60_000);
  });
  it("returns expired without POST, attempt or failure when the deadline passed while waiting for the next permit", async () => {
    resumable({ kind: "chunk", chunk: 1 }, 5_000, []); state.prepares = ["expired"];
    expect(await run()).toEqual({ kind: "expired" });
    expect(state.posts).toEqual([]); expect(state.cancelled).toBe(1); expect(state.writes).not.toHaveBeenCalled();
  });
  it("turns a resumed timeout into expired, but keeps a fresh full-deadline timeout as the original result", async () => {
    resumable({ kind: "chunk", chunk: 1 }, 10_000, []); state.replies = [{ ...ok(), delayMs: 10_000 }];
    expect(await run()).toEqual({ kind: "expired" });
    expect(state.settled).toHaveLength(1);
    Object.assign(state, { continuation: null, posts: [], replies: [{ ...ok(), delayMs: 61_000 }] });
    expect(await run()).toEqual({ kind: "result", result: { ok: false, error: "timeout" }, expectation });
    expect(state.posts).toHaveLength(1);
  });
  it("reuses a complete execution inside its deadline instead of sending again", async () => {
    resumable("done", 5_000, [{ step: { kind: "chunk", chunk: 0 }, outcome: { ok: true, removed: ["keyword-4"] } }]);
    expect(await run()).toEqual({ kind: "result", result: { ok: true, unsupported: ["keyword-4"] }, expectation });
    expect(state.posts).toEqual([]); expect(state.inputs).toEqual([]);
  });
  it("defers on any unresolved physical call of the target without a new permit", async () => {
    state.continuation = { generationHash: "9".repeat(64), nowMs: Date.now(), unresolved: true, nextExecution: 1, latest: null };
    await expect(run()).rejects.toMatchObject({ reason: "dispatched" }); expect(state.inputs).toEqual([]);
  });
  it("cancels only the reservation when reserved preparation fails or the input changed", async () => {
    state.prepares = ["skipped"];
    expect(await run()).toEqual({ kind: "skipped" }); expect(state.cancelled).toBe(1); expect(state.posts).toEqual([]);
  });
});

describe("job wiring keeps deferred and expired unconsumed", () => {
  const ctx = (): JobContext<null> => ({ cursor: null, lease, hasBudget: () => true, log: vi.fn(), save: vi.fn() });
  const stubRole = () => { for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "text", ROLE_LEASE_INSTANCE_ID: "text-unit",
    ROLE_LEASE_BOOT_ID: boot, ROLE_LEASE_RELEASE: "unit", ROLE_LEASE_EPOCH: "1" })) vi.stubEnv(key, value); };
  it("records nothing and ends the tick when the shared deadline expired", async () => {
    stubRole(); state.pending.mockResolvedValueOnce([task()]).mockResolvedValue([]);
    resumable({ kind: "chunk", chunk: 1 }, 5_000, []); state.prepares = ["expired"];
    expect(await verifySearchKeywords(ctx())).toEqual({ done: false });
    expect(state.writes).not.toHaveBeenCalled(); expect(state.posts).toEqual([]);
  });
  it("records nothing on a capacity deferral and rethrows it", async () => {
    stubRole(); state.pending.mockResolvedValue([task()]); state.slots = ["capacity"];
    await expect(verifySearchKeywords(ctx())).rejects.toBeInstanceOf(ModelCapacityDeferredError);
    expect(state.writes).not.toHaveBeenCalled();
  });
  it("passes the one-use expectation only on the positive path", async () => {
    stubRole(); state.pending.mockResolvedValueOnce([task(["a"], null)]).mockResolvedValue([]); state.replies = [ok(["a"])];
    await verifySearchKeywords(ctx());
    expect(state.writes).toHaveBeenCalledWith(expect.anything(), lease, { kind: "success", removed: ["a"], model: "[supa] Qwen3.8-27B-NVFP4" }, expectation);
  });
});
