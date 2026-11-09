import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, gateSplitTiebreaks, jobs, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, getSettings, saveSettings, setQwenAutoStep } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { judgeRevision } from "@/lib/crawl/rules";
import { tiebreakGateSplits } from "@/lib/crawl/jobs/split-tiebreak";
import { confirmGateSplits } from "@/lib/crawl/jobs/split-confirm";
import { QWEN_DIRECT_DEFAULT_MODEL } from "@/lib/crawl/qwen-direct-review";
import { resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { resetDeepseekConfirmBackoff } from "@/lib/crawl/gate-split-confirm";
import { DEEPSEEK_REVIEW_BASE, DEEPSEEK_REVIEW_MODEL } from "@/lib/crawl/deepseek-review-policy";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { tryAcquireRole, renewRole, releaseRole, type RoleLease } from "@/lib/jobs/role-leader";
import { localModelContractHash, localModelServingContractSchema } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { cancelReservedModelSlot, requestLocalModelSlot } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { enqueueSecondReviewsFixture as enqueueSecondReviews, recordSecondReviewFixture } from "./second-review-receipt-fixtures";

/**
 * 갈림 확인(split-confirm)이 공통 장부(local-direct route local-deepseek-confirm)가 open 일 때 실제로 DeepSeek 을 부르고 정산하는가 — 2026-11-09 운영:
 * 10-24 route 가 생긴 뒤 4,254건이 모두 withdrawn(증명 거절 target_not_open·예약 만료)이고 정산 0건이었다. 이 파일은 운영과 같은 길
 * (claim → requestLocalModelSlot → dispatchLocalModelCapacity → 도메인 증명 → native 호출 → 정산 → 적용)을 잡 한 틱으로 그대로 돈다.
 * M3 는 가짜 HTTP 서버다(gatewayFetch 가 계약 주소를 그 서버로 돌린다 — 계약·wire 검사는 원래 주소로 한다).
 */
vi.mock("server-only", () => ({}));
let m3Url = "";
vi.mock("@/lib/llm/gateway-local-end-fetch", async original => {
  const actual = await original<typeof import("@/lib/llm/gateway-local-end-fetch")>();
  return { ...actual, gatewayFetch: (...args: Parameters<typeof actual.gatewayFetch>) => {
    if (String(args[1]) !== `${DEEPSEEK_REVIEW_BASE}/chat/completions`) throw new Error("fixture_native_endpoint_required");
    return actual.gatewayFetch(args[0], m3Url, args[2]);
  } };
});

type Outcome = { decision: "approve" | "reject" | "needs_review"; reason: string; confidence?: number };
type ChatBody = { model: string; messages: { role: string; content: string }[] };
const admin = postgres(TEST_DATABASE_URL, { max: 3, prepare: false, onnotice: () => {} });
const qwenRequests: ChatBody[] = [];
const deepseekRequests: ChatBody[] = [];
let deepseekOutcome: Outcome = { decision: "reject", reason: "Only a placeholder page.", confidence: 0.8 };
const qwen = createServer(async (request, response) => {
  let data = ""; for await (const chunk of request) data += chunk;
  qwenRequests.push(JSON.parse(data) as ChatBody);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ model: QWEN_DIRECT_DEFAULT_MODEL, usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ decision: "reject", reason: "The page is only a placeholder.",
      evidenceIds: ["product"], confidence: 0.95 }) } }] }));
});
const m3: Server = createServer(async (request, response) => {
  let data = ""; for await (const chunk of request) data += chunk;
  deepseekRequests.push(JSON.parse(data) as ChatBody);
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ model: DEEPSEEK_REVIEW_MODEL, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ evidenceIds: ["product"], ...deepseekOutcome }) } }] }));
});

/** 운영 정책과 같은 모양 — DeepSeek 확인과 위임이 M3 의 한 물리 group(m3-mlx, 1칸)을 나눈다 */
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { "m3-deepseek": 4 }, groupLimits: { "m3-mlx": 1 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [{ routeId: "local-deepseek-confirm", provider: "local-direct", model: DEEPSEEK_REVIEW_MODEL, providerBudgetId: "m3-deepseek", groupId: "m3-mlx" },
    { routeId: "local-human-deepseek", provider: "local-direct", model: DEEPSEEK_REVIEW_MODEL, providerBudgetId: "m3-deepseek", groupId: "m3-mlx" }] };
let role: RoleLease, qwenEndpoint = "", originalControl: Record<string, unknown>;

async function clearLedger() {
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests`;
  });
}
const setControl = (mode: "open" | "disabled") => mode === "open"
  ? admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},
      cursor=0,updated_at=clock_timestamp() WHERE id=1`
  : admin`UPDATE model_capacity_control SET mode='disabled',policy=NULL,policy_hash=NULL,updated_at=clock_timestamp() WHERE id=1`;

beforeAll(async () => {
  ensureSchema();
  await new Promise<void>(resolve => qwen.listen(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => m3.listen(0, "127.0.0.1", resolve));
  qwenEndpoint = `http://127.0.0.1:${(qwen.address() as AddressInfo).port}/v1`;
  m3Url = `http://127.0.0.1:${(m3.address() as AddressInfo).port}/v1/chat/completions`;
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  const acquired = await tryAcquireRole({ role: "reviewer", instanceId: `splitc-${randomUUID().slice(0, 8)}`, bootId: randomUUID(), release: "fixture", kind: "primary" });
  if (!acquired) throw new Error("fixture_role");
  role = acquired;
});
afterAll(async () => {
  for (const server of [qwen, m3]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  try {
    await clearLedger();
    await admin.begin(async tx => {
      await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
      await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
        updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
    });
    if (role) await releaseRole(role);
  } finally { vi.unstubAllEnvs(); await admin.end(); }
});
beforeEach(async () => {
  await clearLedger();
  await setControl("disabled");
  await db.delete(gateSplitTiebreaks);
  await db.delete(secondReviews);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  qwenRequests.length = 0; deepseekRequests.length = 0;
  deepseekOutcome = { decision: "reject", reason: "Only a placeholder page.", confidence: 0.8 };
  resetQwenAuditBackoff(); resetDeepseekConfirmBackoff();
  expect(await renewRole(role)).toBe(true);
  const contract = localModelServingContractSchema.parse({ version: 1, protocol: "local-openai-chat-v1", provider: "local-direct",
    backendId: "m3-deepseek", physicalGroup: "m3-mlx", endpoint: `${DEEPSEEK_REVIEW_BASE}/chat/completions`, model: DEEPSEEK_REVIEW_MODEL,
    responseModel: DEEPSEEK_REVIEW_MODEL, modelFamily: "deepseek-v4.1-flash", deploymentRevision: "fixture-m3", contextWindowTokens: 65_536,
    totalTokenBound: 65_536, maxOutputTokens: 4_000, maxInputBytes: 400_000, capabilities: { vision: false, jsonSchema: false },
    thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } });
  vi.stubEnv("LOCAL_MODEL_SERVING_CONTRACTS", JSON.stringify([contract]));
  vi.stubEnv("LOCAL_MODEL_VERIFIED_CONTRACT_HASHES", JSON.stringify({ [contract.backendId]: localModelContractHash(contract) }));
  vi.stubEnv("LOCAL_MODEL_PHYSICAL_LIMITS", JSON.stringify({ [contract.physicalGroup]: 1 }));
  vi.stubEnv("ROLE_LEASE_ROLE", "reviewer"); vi.stubEnv("ROLE_LEASE_INSTANCE_ID", role.instanceId); vi.stubEnv("ROLE_LEASE_BOOT_ID", role.bootId);
  vi.stubEnv("ROLE_LEASE_RELEASE", role.release); vi.stubEnv("ROLE_LEASE_EPOCH", String(role.epoch));
  vi.stubEnv("AUDIT_SECOND_OPINION_URL", qwenEndpoint); vi.stubEnv("AUDIT_SECOND_OPINION_MODEL", ""); vi.stubEnv("AUDIT_SECOND_OPINION_API_KEY", "");
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: "test-model" },
    secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "[MLX] second-test" }], sampleRate: 0 } }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "split confirm capacity fixture" })).toMatchObject({ ok: true });
  const current = (await getSettings()).qwenAuto.splitTiebreak;
  expect(await setQwenAutoStep({ step: "splitTiebreak", next: { ...current, enabled: true, perTick: 10, dailyRejectCap: 50 }, expected: current,
    actor: "test", reason: "운영과 같은 설정" })).toMatchObject({ ok: true });
});

/** 1차 승인·관문 표 거부로 갈린 보류를 만들고, 판가름 잡(장부 disabled — 이 파일의 대상이 아니다)으로 awaiting_deepseek 까지 둔다 */
async function awaitingConfirm(index: number) {
  const repo = `split-confirm/product-${index}`, productUrl = `https://split-confirm-${index}.example`, now = new Date(Date.now() - 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: "A useful application" }, pageMeta: { title: `Split confirm ${index}`, description: "An application for daily work" } }).returning();
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed", decidedBy: "auto",
    judgedAt: now, updatedAt: new Date(now.getTime() + index), signals: { judgedRevision: judgeRevision(document) } }).returning();
  const input = await loadReviewInput(row, document, await getSettings());
  await db.insert(crawlReviewAttempts).values({ candidateId: row.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "claude-cli", model: "test-model", attemptNumber: 1,
    outcome: { decision: "approve", reason: "Product description confirmed", evidenceIds: ["product"], confidence: 0.95 },
    validUntil: input.validUntil, startedAt: now, completedAt: now });
  await enqueueSecondReviews(await getSettings());
  const [gate] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, row.id));
  await recordSecondReviewFixture(gate.id, { ok: true, decision: "reject", confidence: 0.9, reason: "Only a docs page for a CLI",
    model: gate.model!, provider: "abcllm", status: "agreed" });
  expect(await runJob("split-tiebreak", tiebreakGateSplits, { budgetMs: jobRunOptions("split-tiebreak", { requestedOnly: true }).budgetMs }))
    .toMatchObject({ status: "completed" });
  const [tiebreak] = await db.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.candidateId, row.id));
  // 운영의 15행과 같은 상태 — 판가름은 끝났고 DeepSeek 확인만 기다린다(deepseek_model 은 아직 없다)
  expect(tiebreak).toMatchObject({ state: "succeeded", applied: "awaiting_deepseek", decision: "reject", deepseekState: "waiting", deepseekModel: null });
  return { candidateId: row.id, tiebreakId: tiebreak.id, repo, generationKey: tiebreak.generationKey };
}
const confirm = () => runJob("split-confirm", confirmGateSplits, { budgetMs: jobRunOptions("split-confirm", { requestedOnly: true }).budgetMs });
const ledger = async () => Array.from(await admin`SELECT request_id, route_id, state, logical_work_key FROM model_capacity_requests ORDER BY queue_ordinal`);
const events = async () => Array.from(await admin`SELECT e.kind, e.evidence FROM model_capacity_events e
  JOIN model_capacity_requests r USING (request_id) WHERE r.route_id='local-deepseek-confirm' ORDER BY e.id`).map(row => ({ kind: row.kind, evidence: row.evidence }));

it("장부가 open 이어도 기다리던 확인이 실제로 DeepSeek 을 부르고 정산한 뒤 거부로 닫는다(운영 4,254건 withdrawn·정산 0의 재현)", async () => {
  const split = await awaitingConfirm(0);
  await setControl("open");
  expect(await confirm()).toMatchObject({ status: "completed" });
  expect(deepseekRequests).toHaveLength(1);
  expect(deepseekRequests[0].model).toBe(DEEPSEEK_REVIEW_MODEL);
  expect(await ledger()).toMatchObject([{ route_id: "local-deepseek-confirm", state: "settled", logical_work_key: `direct:split:${split.candidateId}:deepseek_confirm` }]);
  expect((await events()).map(event => event.kind)).toEqual(["queued", "reserved", "dispatch_started", "dispatch_settled"]);
  const [row] = await db.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.id, split.tiebreakId));
  expect(row).toMatchObject({ applied: "rejected", deepseekState: "succeeded", deepseekModel: DEEPSEEK_REVIEW_MODEL, deepseekLeaseToken: null,
    deepseekOutcome: { decision: "reject", confidence: 0.8 } });
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, split.candidateId)))[0])
    .toMatchObject({ state: "rejected", reason: "second_review_split_qwen_reject" });
});

it("DeepSeek 이 거부로 확인하지 않으면 정산하고 사람에게 둔다 — 다른 결과는 예전 그대로", async () => {
  const split = await awaitingConfirm(0);
  await setControl("open");
  deepseekOutcome = { decision: "approve", reason: "A usable product.", confidence: 0.9 };
  expect(await confirm()).toMatchObject({ status: "completed" });
  expect(await ledger()).toMatchObject([{ state: "settled" }]);
  const [row] = await db.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.id, split.tiebreakId));
  expect(row).toMatchObject({ applied: "held_deepseek", deepseekState: "succeeded", deepseekModel: DEEPSEEK_REVIEW_MODEL });
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, split.candidateId)))[0]).toMatchObject({ state: "needs_review" });
});

it("M3 칸이 차 있어 미뤄진 확인은 대기 행을 남기지 않는다 — 남은 대기 행이 아무도 쓰지 않는 예약으로 바뀌어 만료되던 길(운영 reservation_expired)", async () => {
  const split = await awaitingConfirm(0);
  await setControl("open");
  // 사람 큐 위임(다른 owner)이 M3 한 칸을 쥐고 있다
  const owner = { instanceId: `${role.instanceId}-other`, bootId: randomUUID() };
  const blocker = await requestLocalModelSlot({ requestId: randomUUID(), owner, class: "background", pool: "reviewer", routeId: "local-human-deepseek",
    provider: "local-direct", model: DEEPSEEK_REVIEW_MODEL, workKey: randomUUID() },
  { kind: "candidate", purpose: "human_deepseek", attemptId: 999, candidateId: 999_999, repo: "other/repo" });
  expect(blocker.kind).toBe("granted");
  expect(await confirm()).toMatchObject({ status: "completed" });
  expect(deepseekRequests).toHaveLength(0);
  const own = (await ledger()).filter(row => row.route_id === "local-deepseek-confirm");
  expect(own.filter(row => ["waiting", "reserved"].includes(row.state))).toEqual([]);
  expect((await events()).map(event => event.kind)).toEqual(["queued", "wait_cancelled"]);
  // 칸이 풀린 뒤 다른 요청이 입장 판정을 돌려도 확인 몫의 예약이 생기지 않는다(예전에는 여기서 reserved → 30초 뒤 reservation_expired)
  if (blocker.kind === "granted") expect(await cancelReservedModelSlot(blocker.reservation)).toBe(true);
  const next = await requestLocalModelSlot({ requestId: randomUUID(), owner, class: "background", pool: "reviewer", routeId: "local-human-deepseek",
    provider: "local-direct", model: DEEPSEEK_REVIEW_MODEL, workKey: randomUUID() },
  { kind: "candidate", purpose: "human_deepseek", attemptId: 1000, candidateId: 999_998, repo: "other/repo2" });
  expect(next.kind).toBe("granted");
  if (next.kind === "granted") expect(await cancelReservedModelSlot(next.reservation)).toBe(true);
  expect((await ledger()).filter(row => row.route_id === "local-deepseek-confirm" && row.state === "reserved")).toEqual([]);
  // 행은 다음 틱에 다시 묻는다 — 실패로 세지 않는다
  const [row] = await db.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.id, split.tiebreakId));
  expect(row).toMatchObject({ applied: "awaiting_deepseek", deepseekState: "waiting", deepseekFailureCount: 0, deepseekLeaseToken: null });
  expect(await confirm()).toMatchObject({ status: "completed" });
  expect(deepseekRequests).toHaveLength(1);
  expect((await db.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.id, split.tiebreakId)))[0]).toMatchObject({ applied: "rejected" });
});
