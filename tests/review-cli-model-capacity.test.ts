import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { agentReviewBinding } from '@/lib/crawl/agent-review-ownership';
import type { CrawlCandidate, CrawlDocument, CrawlReviewAttempt, SecondReview } from '@/lib/db/schema';
import { itemBindingHash, type Ai2ItemBinding } from '@/lib/jobs/items/types';
import { cliDispatchBindingHash, type CliDispatchBinding, type CliModelDispatch } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { readCliProcessTerminal } from '@/lib/llm/cli-process-runner';
import { claudeCliTokenBound, type CliServingContract } from '@/lib/llm/cli-serving-contract';
import type { PreparedReviewCliCall } from '@/lib/crawl/review-cli-call';

/*
 * 05c-4 coordinator 와 consumer 접점. 장부·claim TX·도메인 writer 는 경계에서 mock 이다(실제 DB 증거는 통합 driver 가 낸다).
 * CLI 실행은 실제 runner + 가짜 CLI 프로세스이고, 실제 claude/grok·provider 는 부르지 않는다. 계약은 이 파일의 fixture 만 연다.
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
const mocks = vi.hoisted(() => ({ pending: vi.fn(), request: vi.fn(), cancel: vi.fn(), unknown: vi.fn(), reconcile: vi.fn(),
  gatewayRequest: vi.fn(), ai1Claim: vi.fn(), ai1ItemClaim: vi.fn(), ai1Consumer: vi.fn(), load: vi.fn(), observe1: vi.fn(), renew1: vi.fn(),
  record1: vi.fn(), spam: vi.fn(), preparation: vi.fn(), ai2Claim: vi.fn(), ai2Consumer: vi.fn(), observe2: vi.fn(), renew2: vi.fn(), record2: vi.fn() }));
vi.mock('@/lib/llm/cli-serving-contract', async original => ({
  ...await original<typeof import('@/lib/llm/cli-serving-contract')>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));
vi.mock('@/lib/llm/capacity-repository', () => ({ findOwnPendingModelRequest: mocks.pending, requestCliModelSlot: mocks.request,
  cancelReservedModelSlot: mocks.cancel, markModelDispatchIndeterminate: mocks.unknown, reconcileCliProcessTerminal: mocks.reconcile,
  requestAi1ModelSlot: mocks.gatewayRequest, requestAi2ItemModelSlot: mocks.gatewayRequest }));
vi.mock('@/lib/crawl/agent-review-repository', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review-repository')>(),
  claimAgentReviewWithCliModelReservation: mocks.ai1Claim, claimConsumerItemAgentReviewWithCliModelReservation: mocks.ai1ItemClaim,
  claimConsumerItemAgentReview: mocks.ai1Consumer, loadFirstReviewConsumerContext: mocks.load, observeAgentReviewItemDispatch: mocks.observe1,
  renewAgentReviewItemOwnership: mocks.renew1, recordAgentReview: mocks.record1, recordConsumerSuspectedSpam: mocks.spam }));
vi.mock('@/lib/crawl/agent-review-preparation', () => ({ prepareAgentReview: mocks.preparation }));
vi.mock('@/lib/crawl/agent-review', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review')>(),
  firstReviewer: () => ({ provider: 'claude-cli', model: 'fake-model' }) }));
vi.mock('@/lib/crawl/second-review-ownership', async load => ({ ...await load<typeof import('@/lib/crawl/second-review-ownership')>(),
  claimSecondReviewItemWithCliModelReservation: mocks.ai2Claim, claimConsumerItemSecondReview: mocks.ai2Consumer,
  observeSecondReviewItemDispatch: mocks.observe2, renewSecondReviewOwnership: mocks.renew2 }));
vi.mock('@/lib/crawl/second-review', () => ({ recordSecondReview: mocks.record2 }));
import { AgentReviewItemCliModelReservationRequired, AgentReviewItemModelReservationRequired } from '@/lib/crawl/agent-review-repository';
import { SecondReviewCliModelReservationRequired, SecondReviewModelReservationRequired } from '@/lib/crawl/second-review-ownership';
import { claimAgentReviewCliModelCapacity, claimAgentReviewItemCliModelCapacity, claimSecondReviewCliModelCapacity,
  reviewCliModelCapacity, abandonCliModelCapacity } from '@/lib/crawl/review-cli-model-capacity';
import { executeFirstReviewConsumerItem } from '@/lib/crawl/agent-review-item-lifecycle';
import { executeSecondReviewConsumerItem } from '@/lib/crawl/second-review-item-lifecycle';

const model = 'fake-model', owner = { instanceId: 'cli-capacity-unit', bootId: randomUUID() };
const lease = { name: 'crawl-agent-review', token: randomUUID(), requestedVersion: 4 };
const claudeShape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const claude = (routeId: string): CliServingContract => ({ version: 1, protocol: 'cli-process-v1', routeId, provider: 'claude-cli', model,
  cliVersion: 'fake 0.0.0', totalTokenBound: claudeCliTokenBound(claudeShape), costBoundUsdMicros: 150_000, boundProvenance: 'derived', ...claudeShape });
const grok = (routeId: string): CliServingContract => ({ version: 1, protocol: 'cli-process-v1', routeId, provider: 'grok-cli', model,
  cliVersion: 'fake 0.0.0', inputByteCap: 200_000, totalTokenBound: 300_000, costBoundUsdMicros: null, boundProvenance: 'declared' });
let root = '', bin = '', records = '', tmp = '', empty = '';
const PROCESS_TEST_MS = 20_000;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nmv-review-cli-capacity-'));
  empty = path.join(root, 'empty-path'); records = path.join(root, 'records'); tmp = path.join(root, 'tmp');
  for (const dir of [empty, records, tmp]) await mkdir(dir);
  const fake = path.resolve('tests/fixtures/fake-cli/fake.mjs');
  for (const value of [root, fake, process.execPath]) expect(value).not.toContain("'");
  bin = path.join(root, 'fake-cli'); await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`); await chmod(bin, 0o755);
});
afterAll(() => rm(root, { recursive: true, force: true }));
const grandchildren: number[] = [];
afterEach(async () => {
  for (const pid of grandchildren.splice(0)) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  vi.unstubAllEnvs();
  for (const name of await readdir(records)) await rm(path.join(records, name));
});
type Recorded = { pid: number; argv: string[]; grandchild?: number };
async function recorded(): Promise<Recorded[]> {
  return Promise.all((await readdir(records)).map(async name => JSON.parse(await readFile(path.join(records, name), 'utf8')) as Recorded));
}
function stub(mode: string) {
  vi.stubEnv('TMPDIR', tmp); vi.stubEnv('PATH', empty); vi.stubEnv('FAKE_CLI_MODE', mode); vi.stubEnv('FAKE_CLI_RECORD', records);
  vi.stubEnv('CLAUDE_CLI', bin); vi.stubEnv('GROK_CLI', bin); vi.stubEnv('GROK_HOME', undefined);
  vi.stubEnv('ROLE_LEASE_ROLE', 'reviewer'); vi.stubEnv('ROLE_LEASE_INSTANCE_ID', owner.instanceId); vi.stubEnv('ROLE_LEASE_BOOT_ID', owner.bootId);
  vi.stubEnv('ROLE_LEASE_RELEASE', 'cli-capacity-unit-release'); vi.stubEnv('ROLE_LEASE_EPOCH', '1');
}
function world() {
  const now = new Date(), settings = structuredClone({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'observe' as const });
  const candidate = { id: 3, repo: 'cli-capacity/app', productUrl: 'https://cli-capacity.example', state: 'approved', decidedBy: 'auto',
    judgedAt: now, updatedAt: now } as CrawlCandidate;
  const document = { id: 5, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'Task application' }, pageMeta: { title: 'Tasks' } } as CrawlDocument;
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] });
  return { candidate, document, settings, input };
}
const reservation = () => ({ requestId: randomUUID(), owner, token: randomUUID(), epoch: 1, revision: 1, policyHash: 'e'.repeat(64) });
function dispatchOf(slot: ReturnType<typeof reservation>, binding: CliDispatchBinding): CliModelDispatch {
  return { ...slot, binding, bindingHash: cliDispatchBindingHash(binding) } as CliModelDispatch;
}
const charge = (call: PreparedReviewCliCall) => ({ provider: call.provider, model: call.model, transport: call.transport,
  totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound });
const attempt = { id: 7, candidateId: 3, state: 'running', kind: 'automatic', attemptNumber: 1, reusedFromAttemptId: null, outcome: null } as CrawlReviewAttempt;
/** 실제 claim TX 대신: 넘어온 예약·준비 호출로 진짜 모양의 legacy dispatch 를 돌려준다 */
function legacyClaim() {
  mocks.ai1Claim.mockImplementation(async (value: { reservation: ReturnType<typeof reservation>; call: PreparedReviewCliCall; input: ReturnType<typeof world>['input'] }) => {
    const binding: CliDispatchBinding = { kind: 'ai1_legacy_cli', version: 1, logicalWorkKey: 'ai1:3', candidateId: 3, attemptId: 7,
      inputHash: value.input.inputHash, sourceRevisionHash: value.input.sourceRevisionHash, reviewPolicyHash: value.input.policyHash,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, routeId: 'crawl-agent-review', stageEpoch: 1, ...charge(value.call),
      job: { name: 'crawl-agent-review', token: lease.token, requestedVersion: lease.requestedVersion } };
    return { kind: 'claimed', attempt, receipt: { attemptId: 7, origin: 'fresh', ownership: { kind: 'legacy', stageEpoch: 1, job: lease } },
      dispatch: dispatchOf(value.reservation, binding) };
  });
}
let value: ReturnType<typeof world>;
beforeEach(() => {
  vi.resetAllMocks(); value = world();
  fixture.contracts = [claude('crawl-agent-review'), claude('second-review'), grok('crawl-agent-review'), grok('second-review')];
  mocks.pending.mockResolvedValue(null); mocks.request.mockImplementation(async () => ({ kind: 'granted', reservation: reservation() }));
  mocks.cancel.mockResolvedValue(true); mocks.unknown.mockResolvedValue(true); mocks.reconcile.mockResolvedValue({ kind: 'settled' });
  legacyClaim();
});
const context = (provider = 'claude-cli', timeoutMs = 20_000) => ({ ...value, provider, model, lease, timeoutMs });

it('운영 resolver(null)면 세 coordinator 모두 큐 행·claim·spawn·임시 디렉터리 없이 provider_contract_unavailable 로 미룬다', async () => {
  stub('ok'); fixture.contracts = [];
  await expect(claimAgentReviewCliModelCapacity(context())).rejects.toMatchObject({ name: 'ModelCapacityDeferredError', reason: 'provider_contract_unavailable' });
  const item = new AgentReviewItemCliModelReservationRequired({ context: value, provider: 'grok-cli', model, owner });
  await expect(claimAgentReviewItemCliModelCapacity(item)).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  await expect(claimSecondReviewCliModelCapacity(ai2World('claude-cli').intent)).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  for (const mock of [mocks.pending, mocks.request, mocks.ai1Claim, mocks.ai1ItemClaim, mocks.ai2Claim, mocks.gatewayRequest]) expect(mock).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]); expect(await readdir(tmp)).toEqual([]);
});

it('gateway 의도·gateway provider 는 CLI coordinator 로 들어오지 않는다(고정 class)', async () => {
  stub('ok');
  const gatewayIntent = new AgentReviewItemModelReservationRequired({ context: value, provider: 'abcllm', model, owner });
  await expect(claimAgentReviewItemCliModelCapacity(gatewayIntent as never)).rejects.toThrow('invalid_agent_review_item_model_intent');
  await expect(claimAgentReviewItemCliModelCapacity(new ModelCapacityDeferredError('reservation_required') as never)).rejects.toThrow('invalid_agent_review_item_model_intent');
  await expect(claimSecondReviewCliModelCapacity(ai2World('abcllm').gatewayIntent as never)).rejects.toThrow('invalid_second_review_model_intent');
  await expect(claimAgentReviewCliModelCapacity(context('abcllm'))).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(() => new AgentReviewItemCliModelReservationRequired({ context: value, provider: 'abcllm' as 'grok-cli', model, owner })).toThrow();
  expect(() => new SecondReviewCliModelReservationRequired(ai2World('abcllm').gatewayIntent.intent)).toThrow('invalid_second_review_model_intent');
  expect(mocks.request).not.toHaveBeenCalled(); expect(await readdir(tmp)).toEqual([]);
});

it.skipIf(process.platform === 'win32')('AI1 legacy: slot → 같은 TX claim(dispatch) → 가짜 CLI 한 번 → terminal 정산, 임시 디렉터리 정리', async () => {
  stub('ok');
  const { claim, call } = await claimAgentReviewCliModelCapacity(context());
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ owner, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review',
    provider: 'claude-cli', model, workKey: `ai1:3:${itemBindingHash(agentReviewBinding(3, value.input, { provider: 'claude-cli', model }))}`,
    requestId: expect.any(String) }), { kind: 'ai1', candidateId: 3 });
  expect(mocks.ai1Claim).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lease, provider: 'claude-cli', model,
    call: expect.objectContaining({ kind: 'prepared_cli', routeId: 'crawl-agent-review', inputHash: value.input.inputHash }) }));
  expect(call.transport.timeoutMs).toBe(20_000); expect(mocks.cancel).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]);
  const result = await reviewCliModelCapacity(value.input, claim.dispatch!, call, {});
  expect(result).toMatchObject({ ok: true, outcome: { decision: 'approve' } });
  expect(await recorded()).toHaveLength(1);
  expect(mocks.reconcile).toHaveBeenCalledTimes(1); expect(mocks.unknown).not.toHaveBeenCalled();
  expect(readCliProcessTerminal(mocks.reconcile.mock.calls[0][0])).toMatchObject({ ending: 'exited', exitCode: 0, requestId: claim.dispatch!.requestId,
    transport: call.transport });
  expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === 'win32')('spawn 전 포기(D5): commit 된 dispatch 는 not_started 로 정산하고 spawn 0', async () => {
  stub('ok');
  const { claim, call } = await claimAgentReviewCliModelCapacity(context());
  expect(await abandonCliModelCapacity(claim.dispatch!, call)).toBe(true);
  expect(readCliProcessTerminal(mocks.reconcile.mock.calls[0][0])).toMatchObject({ ending: 'not_started', requestId: claim.dispatch!.requestId });
  expect(mocks.unknown).not.toHaveBeenCalled(); expect(await recorded()).toEqual([]); expect(await readdir(tmp)).toEqual([]);
  // 이미 정산한 호출은 다시 실행되지 않는다(장부의 settled 행은 indeterminate 표시도 받지 않는다)
  await expect(reviewCliModelCapacity(value.input, claim.dispatch!, call, {})).rejects.toThrow('review_cli_call_mismatch');
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(claim.dispatch, 'transport_unknown');
  expect(await recorded()).toEqual([]);
  // 실행 중 abort 가 이미 걸렸으면 runner 가 spawn 없이 not_started 로 닫고 결과는 legacy 처럼 cancelled 다
  const next = await claimAgentReviewCliModelCapacity(context()), aborted = new AbortController(); aborted.abort();
  expect(await reviewCliModelCapacity(value.input, next.claim.dispatch!, next.call, { signal: aborted.signal })).toEqual({ ok: false, error: 'cancelled' });
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  expect(readCliProcessTerminal(mocks.reconcile.mock.calls[1][0])).toMatchObject({ ending: 'not_started', requestId: next.claim.dispatch!.requestId });
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === 'win32')('pipe 쥔 손자: terminal 없이 process_exit indeterminate 로 점유를 유지하고, 재진입은 spawn·slot·claim 0', async () => {
  stub('grandchild-hold');
  const { claim, call } = await claimAgentReviewCliModelCapacity(context());
  const result = await reviewCliModelCapacity(value.input, claim.dispatch!, call, {});
  for (const record of await recorded()) if (record.grandchild) grandchildren.push(record.grandchild);
  expect(result).toEqual({ ok: false, error: 'cli_error' });
  expect(mocks.unknown).toHaveBeenCalledExactlyOnceWith(claim.dispatch, 'process_exit'); expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(await recorded()).toHaveLength(1);
  mocks.pending.mockResolvedValue({ requestId: claim.dispatch!.requestId, state: 'indeterminate' }); mocks.request.mockClear(); mocks.ai1Claim.mockClear();
  await expect(claimAgentReviewCliModelCapacity(context())).rejects.toMatchObject({ reason: 'dispatched' });
  expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.ai1Claim).not.toHaveBeenCalled();
  expect(await recorded()).toHaveLength(1); expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);

it('슬롯 대기·대기 순번 유지: deferred 면 claim(attempt) 0, 같은 requestId 를 다시 묻고 예약 취소도 없다', async () => {
  stub('ok');
  const requestId = randomUUID();
  mocks.pending.mockResolvedValue({ requestId, state: 'waiting' }); mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
  await expect(claimAgentReviewCliModelCapacity(context())).rejects.toMatchObject({ reason: 'capacity' });
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ requestId }), { kind: 'ai1', candidateId: 3 });
  expect(mocks.ai1Claim).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  expect(await readdir(tmp)).toEqual([]);
});

it('claim 이 skipped·reused 면 예약만 돌려주고, claim 오류는 예약을 돌려준 뒤 그대로 던진다', async () => {
  stub('ok');
  mocks.ai1Claim.mockResolvedValueOnce({ kind: 'skipped', reason: 'input_changed' });
  expect((await claimAgentReviewCliModelCapacity(context())).claim).toEqual({ kind: 'skipped', reason: 'input_changed' });
  mocks.ai1Claim.mockResolvedValueOnce({ kind: 'reused', attempt, receipt: { attemptId: 7, origin: 'semantic_reuse', ownership: { kind: 'legacy', stageEpoch: 1, job: lease } } });
  expect((await claimAgentReviewCliModelCapacity(context())).claim.kind).toBe('reused');
  mocks.ai1Claim.mockRejectedValueOnce(new Error('domain_failure'));
  await expect(claimAgentReviewCliModelCapacity(context())).rejects.toThrow('domain_failure');
  mocks.ai1Claim.mockResolvedValueOnce({ kind: 'claimed', attempt, receipt: { attemptId: 7, origin: 'fresh', ownership: { kind: 'legacy', stageEpoch: 1, job: lease } } });
  await expect(claimAgentReviewCliModelCapacity(context())).rejects.toThrow('cli_model_dispatch_missing');
  expect(mocks.cancel).toHaveBeenCalledTimes(4); expect(await recorded()).toEqual([]); expect(await readdir(tmp)).toEqual([]);
  const aborted = new AbortController(); aborted.abort(); mocks.ai1Claim.mockClear();
  await expect(claimAgentReviewCliModelCapacity({ ...context(), signal: aborted.signal })).rejects.toMatchObject({ reason: 'reservation_lost' });
  expect(mocks.ai1Claim).not.toHaveBeenCalled(); expect(mocks.cancel).toHaveBeenCalledTimes(5);
});

function ai2World(provider: string) {
  const binding: Ai2ItemBinding = { stage: 'ai2', secondReviewId: 8, candidateId: 3, source: { kind: 'first_attempt', firstAttemptId: 7 },
    inputHash: value.input.inputHash, sourceRevisionHash: value.input.sourceRevisionHash, policyHash: 'c'.repeat(64),
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, reviewer: { provider, model }, generationKey: 'd'.repeat(64),
    vote: 8, fallbackForId: null };
  const intentValue = { binding, input: value.input, rowIdentityHash: 'b'.repeat(64), failureCount: 0, owner };
  const row = { id: 8, candidateId: 3, firstAttemptId: 7, fallbackForId: null, generationKey: binding.generationKey, provider, model, failureCount: 0 } as SecondReview;
  const itemLease = { stage: 'ai2' as const, workKey: 'ai2:8', binding, bindingHash: itemBindingHash(binding), owner, token: randomUUID(),
    stageEpoch: 1, itemEpoch: 1, leaseUntil: new Date(Date.now() + 90_000) };
  const receipt = { binding, rowIdentityHash: intentValue.rowIdentityHash, ownership: { kind: 'item' as const, lease: itemLease } };
  return { binding, row, receipt, itemLease, intentValue,
    get intent() { return new SecondReviewCliModelReservationRequired(intentValue); },
    get gatewayIntent() { return new SecondReviewModelReservationRequired({ ...intentValue, binding: { ...binding, reviewer: { provider: 'abcllm', model } } }); } };
}

it.skipIf(process.platform === 'win32')('AI2 consumer: CLI 의도 → CLI slot → dispatch → 가짜 CLI 한 번 → 정산 뒤에만 표 기록, gateway slot 0', async () => {
  stub('ok');
  const ai2 = ai2World('claude-cli');
  mocks.ai2Consumer.mockRejectedValue(ai2.intent);
  mocks.ai2Claim.mockImplementation(async (input: { reservation: ReturnType<typeof reservation>; call: PreparedReviewCliCall }) => ({ kind: 'claimed',
    row: ai2.row, input: value.input, receipt: ai2.receipt, dispatch: dispatchOf(input.reservation, { kind: 'ai2_item_cli', version: 1,
      logicalWorkKey: 'ai2:3:8', review: ai2.binding, rowIdentityHash: ai2.receipt.rowIdentityHash, failureCount: 0, inputPolicyHash: value.input.policyHash,
      item: { workKey: 'ai2:8', owner, token: ai2.itemLease.token, stageEpoch: 1, itemEpoch: 1, bindingHash: ai2.itemLease.bindingHash },
      routeId: 'second-review', ...charge(input.call) }) }));
  mocks.observe2.mockResolvedValue({ kind: 'current', row: ai2.row, input: value.input }); mocks.renew2.mockResolvedValue(ai2.itemLease);
  const order: string[] = [];
  mocks.reconcile.mockImplementation(async () => { order.push('settled'); return { kind: 'settled' }; });
  mocks.record2.mockImplementation(async () => { order.push('recorded'); return { state: 'recorded' }; });
  expect(await executeSecondReviewConsumerItem({ secondReviewId: 8, owner })).toEqual({ state: 'recorded' });
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ class: 'second', routeId: 'second-review', provider: 'claude-cli',
    workKey: `ai2:3:8:${itemBindingHash(ai2.binding)}` }), { kind: 'ai2', candidateId: 3, vote: 8 });
  expect(mocks.ai2Claim.mock.calls[0][0].call.transport.timeoutMs).toBe(20_000);
  expect(order).toEqual(['settled', 'recorded']);
  expect(mocks.record2).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result: expect.objectContaining({ ok: true, decision: 'approve',
    provider: 'claude-cli', model }) }));
  expect(await recorded()).toHaveLength(1); expect(mocks.gatewayRequest).not.toHaveBeenCalled(); expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);

it('AI2 consumer: 슬롯 대기는 표 기록(실패 수·예비모델 행) 0 으로 deferred 를 던진다', async () => {
  stub('ok');
  const ai2 = ai2World('claude-cli');
  mocks.ai2Consumer.mockRejectedValue(ai2.intent); mocks.request.mockResolvedValue({ kind: 'deferred', reason: 'capacity' });
  await expect(executeSecondReviewConsumerItem({ secondReviewId: 8, owner })).rejects.toMatchObject({ name: 'ModelCapacityDeferredError', reason: 'capacity' });
  for (const mock of [mocks.ai2Claim, mocks.record2, mocks.observe2]) expect(mock).not.toHaveBeenCalled();
  expect(await recorded()).toEqual([]); expect(await readdir(tmp)).toEqual([]);
});

it.skipIf(process.platform === 'win32')('AI2 consumer: 관측한 행이 dispatch 와 어긋나면 spawn 없이 not_started 정산 후 cancelled 로 둔다', async () => {
  stub('ok');
  const ai2 = ai2World('claude-cli');
  mocks.ai2Consumer.mockRejectedValue(ai2.intent);
  mocks.ai2Claim.mockImplementation(async (input: { reservation: ReturnType<typeof reservation>; call: PreparedReviewCliCall }) => ({ kind: 'claimed',
    row: ai2.row, input: value.input, receipt: ai2.receipt, dispatch: dispatchOf(input.reservation, { kind: 'ai2_item_cli', version: 1,
      logicalWorkKey: 'ai2:3:8', review: ai2.binding, rowIdentityHash: ai2.receipt.rowIdentityHash, failureCount: 0, inputPolicyHash: value.input.policyHash,
      item: { workKey: 'ai2:8', owner, token: ai2.itemLease.token, stageEpoch: 1, itemEpoch: 1, bindingHash: ai2.itemLease.bindingHash },
      routeId: 'second-review', ...charge(input.call) }) }));
  mocks.observe2.mockResolvedValue({ kind: 'current', row: { ...ai2.row, failureCount: 1 }, input: value.input }); mocks.renew2.mockResolvedValue(ai2.itemLease);
  mocks.record2.mockResolvedValue({ state: 'cancelled' });
  expect(await executeSecondReviewConsumerItem({ secondReviewId: 8, owner })).toEqual({ state: 'cancelled' });
  expect(readCliProcessTerminal(mocks.reconcile.mock.calls[0][0])).toMatchObject({ ending: 'not_started' });
  expect(mocks.record2).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ result: expect.objectContaining({ ok: false, error: 'cancelled' }) }));
  expect(await recorded()).toEqual([]); expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === 'win32')('AI1 consumer: CLI 의도 → item dispatch → 가짜 CLI → 정산 뒤 결과 기록', async () => {
  stub('ok');
  const review = agentReviewBinding(3, value.input, { provider: 'claude-cli', model });
  const itemLease = { stage: 'ai1' as const, workKey: 'ai1:3', binding: review, bindingHash: itemBindingHash(review), owner, token: randomUUID(),
    stageEpoch: 1, itemEpoch: 1, leaseUntil: new Date(Date.now() + 90_000) };
  const receipt = { attemptId: 7, origin: 'fresh' as const, ownership: { kind: 'item' as const, lease: itemLease } };
  mocks.load.mockResolvedValue({ kind: 'current', context: value });
  mocks.preparation.mockResolvedValue({ provider: 'claude-cli', model, spam: false });
  mocks.ai1Consumer.mockRejectedValue(new AgentReviewItemCliModelReservationRequired({ context: value, provider: 'claude-cli', model, owner }));
  mocks.ai1ItemClaim.mockImplementation(async (input: { reservation: ReturnType<typeof reservation>; call: PreparedReviewCliCall }) => ({ kind: 'claimed',
    attempt, receipt, dispatch: dispatchOf(input.reservation, { kind: 'ai1_item_cli', version: 1, logicalWorkKey: 'ai1:3', attemptId: 7, review,
      item: { workKey: 'ai1:3', owner, token: itemLease.token, stageEpoch: 1, itemEpoch: 1, bindingHash: itemLease.bindingHash },
      routeId: 'crawl-agent-review', ...charge(input.call) }) }));
  mocks.observe1.mockResolvedValue({ kind: 'current' }); mocks.renew1.mockResolvedValue(itemLease);
  mocks.record1.mockResolvedValue({ applied: true, state: 'succeeded' });
  expect(await executeFirstReviewConsumerItem({ candidateId: 3, owner })).toEqual({ applied: true, state: 'succeeded' });
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ class: 'first', provider: 'claude-cli',
    workKey: `ai1:3:${itemBindingHash(review)}` }), { kind: 'ai1', candidateId: 3 });
  expect(readCliProcessTerminal(mocks.reconcile.mock.calls[0][0])).toMatchObject({ ending: 'exited' });
  expect(mocks.record1).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ receipt, outcome: expect.objectContaining({ decision: 'approve' }) }));
  expect(await recorded()).toHaveLength(1); expect(mocks.gatewayRequest).not.toHaveBeenCalled(); expect(await readdir(tmp)).toEqual([]);
}, PROCESS_TEST_MS);
