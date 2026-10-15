import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";
import { ReplayLedger, replayFinalRunBinding, type ReplayRun } from "@/lib/operations/pipeline-replay-ledger";
import { prepareReplayFinalWrite, recordReplayFinalWrite, recordReplayFirstReviewTransition,
  recordReplaySecondReviewTransition, withReplayFinalScope, type ReplayFinalWrite } from "@/lib/operations/pipeline-replay-final";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { fullReviewPolicyHash, comparisonReviewPolicyHash } from "@/lib/operations/pipeline-capacity";

vi.mock("@/lib/operations/pipeline-replay-database", () => ({
  assertVerifiedReplayDatabase: vi.fn(), verifyReplayDatabaseSession: vi.fn(),
}));
const scopeMock = vi.hoisted(() => ({ current: vi.fn(), identity: vi.fn() }));
const inputMock = vi.hoisted(() => ({ load: vi.fn(), gate: vi.fn() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: scopeMock.current, assertReplayDatabaseScopeIdentity: scopeMock.identity }));
vi.mock("@/lib/crawl/agent-review-repository", () => ({ loadReviewInput: inputMock.load, secondReviewApprovalPredicate: inputMock.gate }));
const begin = vi.fn();
const database = { client: { begin }, identity: { databaseName: "nomorevibe_test", roleName: "isolated-test-role",
  databaseOid: 1, schemaOid: 2 } } as unknown as VerifiedReplayDatabase;
const run = {} as ReplayRun;
const goodHash = "a".repeat(64);
const tx = {} as ProductTransaction;
const executor = {};
beforeEach(() => {
  begin.mockReset().mockRejectedValue(new Error("unexpected_transaction"));
  scopeMock.current.mockReset().mockReturnValue(executor); scopeMock.identity.mockReset();
  inputMock.load.mockReset(); inputMock.gate.mockReset();
});

it.each([
  { ok: true, outcomeHash: null, decisionHash: goodHash },
  { ok: true, outcomeHash: goodHash, decisionHash: null },
  { ok: true, outcomeHash: "bad", decisionHash: goodHash },
  { ok: false, outcomeHash: goodHash, decisionHash: null },
  { ok: false, outcomeHash: null, decisionHash: goodHash },
  { ok: true, outcomeHash: goodHash, decisionHash: goodHash, extra: true },
  { ok: "true", outcomeHash: goodHash, decisionHash: goodHash },
])("rejects malformed result evidence before opening a settlement transaction: %j", async proof => {
  const ledger = new ReplayLedger(database);
  await expect(ledger.settle(run, "call", { inputTokens: 1, outputTokens: 1 }, proof as never))
    .rejects.toThrow("replay_result_proof_invalid");
  expect(begin).not.toHaveBeenCalled();
});

async function authenticRun() {
  const reference = new Date("2001-10-01T00:00:00.000Z");
  const candidate = { id: 1, repo: "scope/app", productUrl: "https://scope.example", judgedAt: reference } as CrawlCandidate;
  const document = { id: 1, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: reference,
    pageStatus: 200, repoMeta: { description: "A service" }, pageMeta: { title: "App", readmeSample: "" } } as CrawlDocument;
  const settings = structuredClone(DEFAULT_CRAWL_SETTINGS);
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] }, reference);
  const raw = Object.assign(vi.fn(async () => [{ event_seq: 1 }]), { json: (value: unknown) => value });
  begin.mockImplementation(async load => load(raw));
  const ledger = new ReplayLedger(database);
  const owned = await ledger.prepare({ version: 1, runId: "unit-final-scope", revision: "9601e3b", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: "2001-10-01T00:00:10.000Z",
    inputPolicyHash: input.policyHash, fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings), initialStateHash: reviewHash({ candidate }),
    models: { first: { provider: "abcllm", model: "first", canonicalModel: "first" }, second: [], fallbacks: [] },
    inputs: [{ candidateId: 1, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 1, maxTokens: 100, perCallTokenUpperBound: 100, maxDurationMs: 10_000, concurrency: 1 } }, [{ candidateId: 1, input }]);
  return { owned, ledger, input, settings, candidate, document };
}

it("leaves ordinary writer paths inert when no final scope is active", async () => {
  await expect(prepareReplayFinalWrite(tx, {} as never)).resolves.toBeUndefined();
  await expect(recordReplayFinalWrite(tx, undefined, [])).resolves.toBeUndefined();
  await expect(recordReplayFirstReviewTransition(tx, {} as never)).resolves.toBeUndefined();
  await expect(recordReplaySecondReviewTransition(tx, {} as never)).resolves.toBeUndefined();
  expect(begin).not.toHaveBeenCalled(); expect(scopeMock.current).not.toHaveBeenCalled();
});

it("rejects forged and spread run handles before invoking the scope callback", async () => {
  const load = vi.fn(async () => undefined), { owned } = await authenticRun();
  await expect(withReplayFinalScope(run, load)).rejects.toThrow("replay_run_required");
  await expect(withReplayFinalScope({ ...owned }, load)).rejects.toThrow("replay_run_required");
  expect(load).not.toHaveBeenCalled();
});

it("requires the authenticated handler database and rejects conflicting nested scopes", async () => {
  const { owned } = await authenticRun();
  scopeMock.current.mockReturnValue(undefined);
  await expect(withReplayFinalScope(owned, async () => undefined)).rejects.toThrow("replay_database_scope_required");
  scopeMock.current.mockReturnValue(executor);
  await withReplayFinalScope(owned, async () => {
    await expect(withReplayFinalScope(owned, async () => undefined)).rejects.toThrow("replay_final_scope_conflict");
  });
  expect(scopeMock.identity).toHaveBeenCalledWith(database);
});

it("rejects missing and counterfeit tokens inside an active scope", async () => {
  const { owned } = await authenticRun();
  await withReplayFinalScope(owned, async () => {
    await expect(recordReplayFinalWrite(tx, undefined, [])).rejects.toThrow("replay_final_token_mismatch");
    await expect(recordReplayFinalWrite(tx, {} as ReplayFinalWrite, [])).rejects.toThrow("replay_final_token_mismatch");
  });
});

it("rejects a token presented after its scope has disappeared", async () => {
  await expect(recordReplayFinalWrite(tx, {} as ReplayFinalWrite, [])).rejects.toThrow("replay_final_token_mismatch");
});

it("rejects inherited work after the final scope closes and after its database changes", async () => {
  const { owned } = await authenticRun();
  let release!: () => void, late!: Promise<void>;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  await withReplayFinalScope(owned, async () => {
    late = barrier.then(() => recordReplayFinalWrite(tx, undefined, []));
    scopeMock.current.mockReturnValue({});
    await expect(recordReplayFinalWrite(tx, undefined, [])).rejects.toThrow("replay_final_scope_closed");
    scopeMock.current.mockReturnValue(executor);
  });
  release();
  await expect(late).rejects.toThrow("replay_final_scope_closed");
});

async function capturedToken(load: (context: { owned: ReplayRun; transaction: ProductTransaction; token: ReplayFinalWrite }) => Promise<void>) {
  const fixture = await authenticRun();
  const first = { id: 2, candidateId: 1, state: "running", leaseToken: "actual-lease" };
  const rows = [[fixture.candidate], [first], [fixture.document], [{ values: fixture.settings }], [], [{ ok: false }],
    [{ token: "actual-lease", alive: true }]];
  const execute = vi.fn().mockResolvedValueOnce([{ safe: true }]).mockResolvedValueOnce([{
    frozen_input: JSON.parse(JSON.stringify(fixture.input)), frozen_hash: reviewHash(JSON.parse(JSON.stringify(fixture.input))),
  }]);
  const transaction = { execute, select: vi.fn(() => ({ from: () => ({ where: async () => rows.shift() }) })) } as unknown as ProductTransaction;
  inputMock.load.mockResolvedValue(fixture.input);
  await withReplayFinalScope(fixture.owned, async () => {
    const token = await prepareReplayFinalWrite(transaction, { stage: "first", candidateId: 1, firstAttemptId: 2,
      input: fixture.input, settings: fixture.settings });
    expect(token).toBeDefined();
    await load({ owned: fixture.owned, transaction, token: token! });
  });
}

it("binds authentic prepared tokens to their exact transaction", async () => {
  await capturedToken(async ({ token }) => {
    await expect(recordReplayFinalWrite(tx, token, [])).rejects.toThrow("replay_final_token_mismatch");
  });
});

it("never reuses a consumed token after an attempted invalid record", async () => {
  await capturedToken(async ({ token, transaction }) => {
    await expect(recordReplayFinalWrite(transaction, token, [{ job: "crawl-publish", requestedVersion: -1 }]))
      .rejects.toThrow("replay_final_request_mismatch");
    await expect(recordReplayFinalWrite(transaction, token, [])).rejects.toThrow("replay_final_token_mismatch");
  });
});

it("rejects authentic tokens after closure and in a replacement scope", async () => {
  let captured!: { owned: ReplayRun; transaction: ProductTransaction; token: ReplayFinalWrite };
  await capturedToken(async value => { captured = value; });
  await expect(recordReplayFinalWrite(captured.transaction, captured.token, [])).rejects.toThrow("replay_final_token_mismatch");
  await withReplayFinalScope(captured.owned, async () => {
    await expect(recordReplayFinalWrite(captured.transaction, captured.token, [])).rejects.toThrow("replay_final_token_mismatch");
  });
});

it.each(["first", "second"] as const)("records only job/version outbox descriptors for %s transitions", async stage => {
  const { owned } = await authenticRun();
  const execute = vi.fn().mockResolvedValueOnce([{ safe: true }]).mockResolvedValueOnce([{
    manifest_hash: reviewHash(replayFinalRunBinding(owned).manifest), state: "running",
    started_at: new Date("2001-10-01"), deadline_at: new Date("2099-10-01"),
  }]).mockResolvedValueOnce([{ wall_now: new Date("2001-10-02") }])
    .mockResolvedValueOnce([{ event_seq: 2 }]).mockResolvedValue([]);
  const transaction = { execute, select: vi.fn(() => ({ from: () => ({
    innerJoin: () => ({ where: async () => [{ state: "failed", candidateId: 1 }] }),
    where: async () => [{ id: 1, candidateId: 1 }],
  }) })) } as unknown as ProductTransaction;
  const requests = [{ job: "crawl-publish", requestedVersion: 3, status: "queued", extra: "omit" }];
  await withReplayFinalScope(owned, async () => {
    if (stage === "first") await recordReplayFirstReviewTransition(transaction,
      { kind: "failed", candidateId: 1, firstAttemptId: 1 }, requests);
    else await recordReplaySecondReviewTransition(transaction,
      { kind: "review_write", secondReviewIds: [1] }, requests);
  });
  const query = new PgDialect().sqlToQuery(execute.mock.calls.at(-1)![0]);
  expect(JSON.parse(query.params.at(-1) as string).requests)
    .toEqual([{ job: "crawl-publish", requestedVersion: 3 }]);
  expect(requests[0]).toEqual({ job: "crawl-publish", requestedVersion: 3, status: "queued", extra: "omit" });
});
