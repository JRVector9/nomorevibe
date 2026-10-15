import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ReplayCallRequest, ReplayLedger, ReplayReceipt, ReplayRun } from "@/lib/operations/pipeline-replay-ledger";
import { fullReviewPolicyHash as settingsHash } from "@/lib/operations/pipeline-capacity";
import { MAX_REVIEW_INPUT_BYTES, REVIEW_FRESH_MS, reviewHash, validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
import type { AgentReviewResult } from "./agent-review";
import { storedReviewEvidenceRequired } from "./review-replay-context";
import type { CrawlSettings } from "./settings-schema";

const positive = z.number().int().positive().safe();
const base = { candidateId: positive, provider: z.enum(["abcllm", "claude-cli", "grok-cli"]),
  model: z.string().min(1).max(160).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value)) };
const bindingSchema = z.discriminatedUnion("stage", [
  z.object({ ...base, stage: z.literal("first"), firstAttemptId: positive }).strict(),
  z.object({ ...base, stage: z.literal("second"), firstAttemptId: positive.nullable(), secondReviewId: positive,
    generationKey: z.string().min(1).max(160), vote: positive }).strict(),
]);
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative().safe().optional(),
  outputTokens: z.number().int().nonnegative().safe().optional(), costUsd: z.number().nonnegative().optional() }).strict();
const resultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), outcome: z.unknown(), usage: usageSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(["not_configured", "input_too_large", "timeout", "cancelled", "output_too_large",
    "missing_cli", "auth", "cli_error", "invalid_output", "max_turns", "budget", "rate_limited", "model_unavailable", "gateway_error"]),
  detail: z.string().optional(), usage: usageSchema.optional() }).strict(),
]);
export type ReviewFixtureCallBinding = z.infer<typeof bindingSchema>;
export type ReviewFixtureLedger = Pick<ReplayLedger, "fixtureMode" | "reserve" | "markDispatching" | "markInFlight"
  | "cancelBeforeDispatch" | "settle" | "markIndeterminate">;
export type ReviewFixtureCallback = (call: Readonly<{ request: ReplayCallRequest; input: ReviewInput;
  timeoutMs: number | undefined; signal: AbortSignal }>) => Promise<{ result: AgentReviewResult; receipt: ReplayReceipt }>;
type Options = { ledger: ReviewFixtureLedger; run: ReplayRun; fixture: ReviewFixtureCallback; tokenUpperBound: number;
  inputs: readonly { candidateId: number; input: ReviewInput }[]; fullReviewPolicyHash: string };
type Scope = Options & { frozenInputs: ReadonlyMap<string, string>; active: boolean; closing: boolean;
  running: Set<Promise<unknown>>; controllers: Set<AbortController> };
const fixtureTransport = new AsyncLocalStorage<Scope>();

function assertActive(scope: Scope): void {
  if (!scope.active || scope.closing || fixtureTransport.getStore() !== scope) throw new Error("replay_fixture_scope_closed");
}

/** A replay may only call the fixture boundary, never a live model adapter. */
export function assertLiveReviewAdapterAllowed(): void {
  if (fixtureTransport.getStore() || storedReviewEvidenceRequired() || currentReplayDb()) throw new Error("replay_raw_review_adapter_rejected");
}

/** Check the handler's own settings read before its cleanup, rules, claims or model calls. */
export function assertReviewFixtureSettings(settings: CrawlSettings): void {
  const scope = fixtureTransport.getStore();
  if (!scope) {
    if (storedReviewEvidenceRequired() || currentReplayDb()) throw new Error("replay_fixture_transport_required");
    return;
  }
  assertActive(scope);
  if (settingsHash(settings) !== scope.fullReviewPolicyHash) throw new Error("replay_fixture_settings_mismatch");
}

/** The owned runner closes this scope before its database scope, including on failure. */
export async function withReviewFixtureTransport<T>(options: Options, load: () => Promise<T>): Promise<T> {
  if (fixtureTransport.getStore()) throw new Error("replay_fixture_scope_conflict");
  if (!Number.isSafeInteger(options.tokenUpperBound) || options.tokenUpperBound < 1
    || !/^[a-f0-9]{64}$/.test(options.fullReviewPolicyHash)) throw new Error("replay_fixture_binding_mismatch");
  const frozenInputs = new Map<string, string>();
  for (const item of options.inputs) {
    const input = frozenInput(item.input), key = inputKey(item.candidateId, input);
    if (!Number.isSafeInteger(item.candidateId) || item.candidateId < 1 || frozenInputs.has(key)) throw new Error("replay_fixture_input_mismatch");
    frozenInputs.set(key, fullInputHash(input));
  }
  const scope: Scope = { ...options, frozenInputs, active: true, closing: false, running: new Set(), controllers: new Set() };
  return fixtureTransport.run(scope, async () => {
    try { return await load(); }
    finally {
      scope.closing = true;
      const unfinished = [...scope.running];
      for (const controller of scope.controllers) controller.abort();
      await Promise.allSettled(unfinished);
      scope.active = false;
      if (unfinished.length) throw new Error("replay_fixture_work_not_awaited");
    }
  });
}

const inputKey = (candidateId: number, input: ReviewInput) => `${candidateId}:${input.inputHash}:${input.sourceRevisionHash}`;
const fullInputHash = (input: ReviewInput) => reviewHash(JSON.parse(JSON.stringify(input)));

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozenInput(value: ReviewInput): ReviewInput {
  try {
    const input = structuredClone(value), semantic = { ...input.snapshot, evidence: input.snapshot.evidence.map(item => item.observation) };
    const fetched = Date.parse(input.source.documentFetchedAt);
    const scan = input.source.scanCompletedAt === null ? Infinity : Date.parse(input.source.scanCompletedAt);
    if (input.inputHash !== reviewHash({ snapshot: semantic, policyHash: input.policyHash })
      || input.sourceRevisionHash !== reviewHash(input.source) || !(input.validUntil instanceof Date)
      || +input.validUntil !== Math.min(fetched + REVIEW_FRESH_MS, scan + REVIEW_FRESH_MS)
      || !Number.isFinite(+input.validUntil) || Buffer.byteLength(JSON.stringify(input.snapshot)) > MAX_REVIEW_INPUT_BYTES)
      throw new Error("input_mismatch");
    return freeze(input);
  } catch { throw new Error("replay_fixture_input_mismatch"); }
}

function validReceipt(receipt: ReplayReceipt, bound: number): boolean {
  return !!receipt && Number.isSafeInteger(receipt.inputTokens) && receipt.inputTokens >= 0
    && Number.isSafeInteger(receipt.outputTokens) && receipt.outputTokens >= 0
    && Number.isSafeInteger(receipt.inputTokens + receipt.outputTokens) && receipt.inputTokens + receipt.outputTokens <= bound;
}

/** Undefined is allowed solely for ordinary workers, before their unchanged provider branch. */
export async function dispatchReviewFixtureCall(value: ReviewFixtureCallBinding, input: ReviewInput,
  options: { timeoutMs?: number; signal?: AbortSignal }): Promise<AgentReviewResult | undefined> {
  const scope = fixtureTransport.getStore();
  if (!scope) {
    if (storedReviewEvidenceRequired() || currentReplayDb()) throw new Error("replay_fixture_transport_required");
    return undefined;
  }
  assertActive(scope);
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)))
    throw new Error("replay_fixture_binding_mismatch");
  const binding = parsed.data, frozen = frozenInput(input);
  if (scope.frozenInputs.get(inputKey(binding.candidateId, frozen)) !== fullInputHash(frozen)) throw new Error("replay_fixture_input_mismatch");
  const request: ReplayCallRequest = Object.freeze({ ...binding, callId: randomUUID(), inputHash: frozen.inputHash,
    sourceRevisionHash: frozen.sourceRevisionHash, tokenUpperBound: scope.tokenUpperBound,
    requestHash: reviewHash({ version: "review-fixture-call-v1", binding, input: { ...frozen, validUntil: frozen.validUntil.toISOString() },
      timeoutMs: options.timeoutMs }) });
  const controller = new AbortController(), deadline = new AbortController();
  const signal = AbortSignal.any([controller.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
  const check = () => {
    assertActive(scope);
    if (signal.aborted) throw new Error(deadline.signal.aborted ? "replay_call_indeterminate" : "replay_fixture_cancelled");
  };
  check();
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => deadline.abort(), options.timeoutMs);
  timer?.unref?.();
  scope.controllers.add(controller);
  const work = async () => {
    let state: "none" | "reserved" | "dispatching" | "in_flight" | "settled" = "none", callbackStarted = false;
    try {
      await scope.ledger.fixtureMode(scope.run); check();
      await scope.ledger.reserve(scope.run, request); state = "reserved"; check();
      await scope.ledger.markDispatching(scope.run, request.callId); state = "dispatching"; check();
      await scope.ledger.markInFlight(scope.run, request.callId); state = "in_flight"; check();
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => { try { check(); } catch (error) { reject(error); } };
        signal.addEventListener("abort", abort, { once: true });
      });
      let answer: Awaited<ReturnType<ReviewFixtureCallback>>;
      try {
        check(); callbackStarted = true;
        answer = await Promise.race([scope.fixture(Object.freeze({ request, input: frozen, timeoutMs: options.timeoutMs, signal })), cancelled]);
      } finally { signal.removeEventListener("abort", abort); }
      check();
      const { result: value, receipt } = structuredClone(answer);
      if (!validReceipt(receipt, scope.tokenUpperBound)) throw new Error("invalid_fixture_receipt");
      const parsedResult = resultSchema.parse(value);
      // Keep the existing outcome policy gate at the fixture boundary, too.
      const result: AgentReviewResult = parsedResult.ok
        ? { ...parsedResult, outcome: validateReviewOutcome(frozen, parsedResult.outcome) } : parsedResult;
      await scope.ledger.settle(scope.run, request.callId, receipt); state = "settled"; check();
      return result;
    } catch (error) {
      if (state === "reserved") await scope.ledger.cancelBeforeDispatch(scope.run, request.callId).catch(() => {});
      if (state === "dispatching" || state === "in_flight") await scope.ledger.markIndeterminate(scope.run, request.callId).catch(() => {});
      if (callbackStarted && !signal.aborted) throw new Error("replay_call_indeterminate");
      throw error;
    }
  };
  const pending = work();
  scope.running.add(pending);
  const remove = () => { clearTimeout(timer); scope.running.delete(pending); scope.controllers.delete(controller); };
  void pending.then(remove, remove);
  return pending;
}
