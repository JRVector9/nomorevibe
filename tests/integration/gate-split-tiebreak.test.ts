import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, gateSplitTiebreaks, jobs, products,
  secondReviews } from "@/lib/db/schema";
import { changeReviewMode, getSettings, saveSettings, setHumanReviewEnabled, setQwenAutoStep } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { REVIEW_SYSTEM_PROMPT } from "@/lib/crawl/agent-review";
import { judgeRevision } from "@/lib/crawl/rules";
import { listAdminReviewEntries } from "@/lib/crawl/admin-review";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";
import { splitTiebreakStatus } from "@/lib/crawl/gate-split-tiebreak-read";
import { QWEN_DIRECT_DEFAULT_MODEL, QWEN_V2_ADDENDUM, QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { qwenEndpointBackingOff, qwenEndpointBackoff, resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { runJob } from "@/lib/jobs/runner";
import { reviewHumanQueue } from "@/lib/crawl/jobs/human-review";
import { jobRunOptions } from "@/scripts/worker";
import { DEEPSEEK_REVIEW_BASE, DEEPSEEK_REVIEW_MODEL } from "@/lib/crawl/deepseek-review-policy";
import { deepseekConfirmBackoff, resetDeepseekConfirmBackoff } from "@/lib/crawl/gate-split-confirm";
import { auditFloor, auditRowsAfter, ensureSchema } from "./setup";
import { enqueueSecondReviewsFixture as enqueueSecondReviews, recordSecondReviewFixture } from "./second-review-receipt-fixtures";

/**
 * 2차 갈림 판가름(lib/crawl/gate-split-tiebreak.ts) — 관문에서 갈린 보류를 gpu3090 Qwen-v2 에 한 번 더 묻고, Qwen-v2 가 거부하면 M3 DeepSeek 이
 * 따로 확인한다(gate-split-confirm.ts). 둘 다 거부해야 닫는다(사용자 결정 2안). Qwen 은 이 파일이 띄운 가짜 OpenAI 호환 서버
 * (AUDIT_SECOND_OPINION_URL), DeepSeek 은 fetch 를 갈라 받는 가짜 M3 다. 2차 잡·사람 검토 잡 한 틱을 그대로 돌린다.
 */
type Outcome = { decision: "approve" | "reject" | "needs_review"; reason: string; evidenceIds?: string[]; confidence?: number };
type Reply = { status: number; outcome?: Outcome };
type ChatBody = { model: string; messages: { role: string; content: string }[] };
const requests: ChatBody[] = [];
let reply: (body: ChatBody) => Promise<Reply> = async () => ({ status: 500 });
const server = createServer(async (request, response) => {
  let data = "";
  for await (const chunk of request) data += chunk;
  const body = JSON.parse(data) as ChatBody;
  requests.push(body);
  const answer = await reply(body);
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(answer.status === 200 ? JSON.stringify({ model: QWEN_DIRECT_DEFAULT_MODEL, usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ evidenceIds: ["product"], confidence: 0.95, ...answer.outcome }) } }] }) : "{}");
});
let endpoint = "";
const reject = (reason = "The page is only a placeholder."): Reply => ({ status: 200, outcome: { decision: "reject", reason } });
const approve: Reply = { status: 200, outcome: { decision: "approve", reason: "The homepage introduces a usable product." } };
const unsure: Reply = { status: 200, outcome: { decision: "needs_review", reason: "The page evidence conflicts." } };
const forRepo = (body: ChatBody) => /gate-split\/product-(\d+)/.exec(body.messages[1]?.content ?? "")?.[1];

/** 가짜 M3 DeepSeek — DEEPSEEK_REVIEW_BASE 로 가는 fetch 만 받는다. 동시에 떠 있던 호출 수를 센다 */
type DeepseekReply = { status?: number; outcome?: Outcome; raw?: string; down?: boolean };
const deepseekRequests: ChatBody[] = [];
const m3 = { inFlight: 0, max: 0 };
let deepseekReply: (body: ChatBody) => Promise<DeepseekReply> = async () => ({});
const deepseekReject = (confidence = 0.8): DeepseekReply => ({ outcome: { decision: "reject", reason: "Only a placeholder page.", confidence } });
const realFetch = globalThis.fetch;
async function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!String(url).startsWith(DEEPSEEK_REVIEW_BASE)) return realFetch(url, init);
  const body = JSON.parse(String(init?.body)) as ChatBody;
  deepseekRequests.push(body);
  m3.inFlight += 1; m3.max = Math.max(m3.max, m3.inFlight);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const answer = await deepseekReply(body);
    if (answer.down) throw new TypeError("fetch failed");
    if (answer.status) return new Response("{}", { status: answer.status });
    return new Response(answer.raw ?? JSON.stringify({ model: DEEPSEEK_REVIEW_MODEL, choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify({ evidenceIds: ["product"], ...(answer.outcome ?? deepseekReject().outcome) }) } }] }));
  } finally { m3.inFlight -= 1; }
}

beforeAll(async () => {
  ensureSchema();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(async () => {
  await db.delete(gateSplitTiebreaks);
  await db.delete(secondReviews);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  requests.length = 0;
  deepseekRequests.length = 0;
  m3.inFlight = 0; m3.max = 0;
  resetQwenAuditBackoff();
  resetDeepseekConfirmBackoff();
  reply = async () => reject();
  deepseekReply = async () => deepseekReject();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  vi.stubEnv("AUDIT_SECOND_OPINION_URL", endpoint);
  vi.stubEnv("AUDIT_SECOND_OPINION_MODEL", "");
  vi.stubEnv("AUDIT_SECOND_OPINION_API_KEY", "");
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  vi.stubEnv("CRAWL_REVIEW_MODEL", "test-model");
  await saveSettings({ enabled: true, secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "[MLX] second-test" }], sampleRate: 0 } }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "gate split fixture" })).toMatchObject({ ok: true });
  // 기본 꺼짐이다 — 이 파일은 켜고 시작한다(화면·운영 스크립트와 같은 setter)
  expect(await turn({ enabled: true, perTick: 10 })).toMatchObject({ ok: true });
});

type TiebreakSwitch = { enabled: boolean; perTick: number; dailyRejectCap?: number };
/** 판가름 스위치를 바꾼다 — compare-and-set, 켤 때 사유. 적지 않은 칸은 지금 값 그대로 */
async function turn(next: TiebreakSwitch, options: { expected?: TiebreakSwitch; reason?: string; actor?: string } = {}) {
  const current = (await getSettings()).qwenAuto.splitTiebreak;
  const expected = { ...current, ...(options.expected ?? {}) };
  return setQwenAutoStep({ step: "splitTiebreak", next: { ...current, ...next }, expected, actor: options.actor ?? "test", reason: options.reason ?? "테스트" });
}

/** 1차 AI 가 승인하고 관문 표(2차)가 vote 로 답해 사람에게 넘어온 후보 — 운영의 두 모델 승인 관문 그대로 */
async function split(index: number, vote: "approve" | "reject" | "needs_review" = "reject", options: { firstConfidence?: number; reason?: string } = {}) {
  const repo = `gate-split/product-${index}`, productUrl = `https://gate-split-${index}.example`;
  const now = new Date(Date.now() - 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: "A useful application" }, pageMeta: { title: `Gate split ${index}`, description: "An application for daily work" } }).returning();
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed", decidedBy: "auto",
    judgedAt: now, updatedAt: new Date(now.getTime() + index), signals: { judgedRevision: judgeRevision(document) } }).returning();
  const input = await loadReviewInput(row, document, await getSettings());
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: row.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "claude-cli", model: "test-model", attemptNumber: 1,
    outcome: { decision: "approve", reason: "Product description confirmed", evidenceIds: ["product"], confidence: options.firstConfidence ?? 0.95 },
    validUntil: input.validUntil, startedAt: now, completedAt: now }).returning();
  await enqueueSecondReviews(await getSettings());
  const [gate] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, row.id));
  await recordSecondReviewFixture(gate.id, { ok: true, decision: vote, confidence: 0.9, reason: options.reason ?? "Only a docs page for a CLI",
    model: gate.model!, provider: "abcllm", status: "agreed" });
  const [held] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.id));
  expect(held).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  return { candidate: held, first, gate: (await db.select().from(secondReviews).where(eq(secondReviews.id, gate.id)))[0] };
}

const tick = () => runJob("second-review", secondReviewCandidates);
/** 둘째 단계 — 사람 검토 잡 한 틱(보류 재심사·위임은 꺼져 있다) */
const confirm = () => runJob("human-deepseek-review", reviewHumanQueue, { budgetMs: jobRunOptions("human-deepseek-review", { requestedOnly: true }).budgetMs });
const candidateOf = async (id: number) => (await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, id)))[0];
const tiebreaksOf = (id: number) => db.select().from(gateSplitTiebreaks).where(eq(gateSplitTiebreaks.candidateId, id)).orderBy(gateSplitTiebreaks.id);
const wrapped = (snapshot: unknown) => `<untrusted_evidence_json>\n${JSON.stringify(snapshot).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}\n</untrusted_evidence_json>`;

it("Qwen-v2 와 DeepSeek 이 관문이 본 입력 그대로 따로 거부하면 닫는다 — 결정 기록·작업 로그에 두 판단을 사람·DeepSeek 결정과 같은 길로 남긴다", async () => {
  const { candidate, first, gate } = await split(0);
  const floor = await auditFloor();
  expect(await tick()).toMatchObject({ status: "completed" });

  expect(requests).toHaveLength(1);
  const [body] = requests;
  expect(body.model).toBe(QWEN_DIRECT_DEFAULT_MODEL);
  expect(body.messages[0].content).toBe(`${REVIEW_SYSTEM_PROMPT}${QWEN_V2_ADDENDUM}`);
  // 관문 표가 받은 입력 — 1차 판단에 저장된 스냅숏이다
  expect(body.messages[1].content).toBe(wrapped(first.snapshot));
  // 첫 단계는 닫지 않는다 — DeepSeek 확인을 기다린다
  expect(await candidateOf(candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ state: "succeeded", decision: "reject", applied: "awaiting_deepseek", deepseekState: "waiting",
    qwenOutcome: { decision: "reject", reason: "The page is only a placeholder.", confidence: 0.95 } }]);
  expect(await splitTiebreakStatus()).toMatchObject({ awaitingDeepseek: 1, rejected: 0 });
  expect(deepseekRequests).toHaveLength(0);

  // 둘째 단계 — 사람 검토 잡이 M3 DeepSeek 에 같은 입력으로 묻는다(원래 확신 0.80 거부 — 위임의 0.90 문턱은 이 길에 걸지 않는다)
  expect(await confirm()).toMatchObject({ status: "completed" });
  expect(deepseekRequests).toHaveLength(1);
  expect(deepseekRequests[0].model).toBe(DEEPSEEK_REVIEW_MODEL);
  expect(deepseekRequests[0].messages[1].content).toBe(wrapped(first.snapshot));
  const closed = await candidateOf(candidate.id);
  expect(closed).toMatchObject({ state: "rejected", reason: "second_review_split_qwen_reject", decidedBy: "auto",
    signals: { stoppedAt: { rule: "2차 갈림 판가름" }, splitTiebreak: { model: QWEN_DIRECT_DEFAULT_MODEL, promptVersion: QWEN_V2_PROMPT_VERSION, decision: "reject",
      deepseek: { model: DEEPSEEK_REVIEW_MODEL, confidence: 0.8 } } } });
  expect(closed.decidedAt).not.toBeNull();
  expect("second_review_split_qwen_reject".length).toBeLessThanOrEqual(40);

  const [decision] = await db.select().from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.kind, "delegated")));
  expect(decision).toMatchObject({ state: "succeeded", actor: "qwen-v2-auto", provider: "qwen-direct", model: QWEN_DIRECT_DEFAULT_MODEL,
    promptVersion: QWEN_V2_PROMPT_VERSION, inputHash: first.inputHash, sourceRevisionHash: first.sourceRevisionHash, policyHash: first.policyHash,
    outcome: { decision: "reject", reason: "The page is only a placeholder." } });
  expect(decision.snapshot).toEqual(first.snapshot);
  const audit = await auditRowsAfter(floor, "candidate-split-tiebreak-reject");
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor: "qwen-v2-auto", actorKind: "model", ok: true, target: candidate.repo,
    detail: { candidateId: candidate.id, attemptId: decision.id, secondReviewIds: [gate.id], metadata: { promptVersion: QWEN_V2_PROMPT_VERSION, model: QWEN_DIRECT_DEFAULT_MODEL,
      qwen: { model: QWEN_DIRECT_DEFAULT_MODEL, promptVersion: QWEN_V2_PROMPT_VERSION, confidence: 0.95 }, deepseek: { model: DEEPSEEK_REVIEW_MODEL, confidence: 0.8 } },
      deepseekOutcome: { decision: "reject", confidence: 0.8 } } });
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ state: "succeeded", decision: "reject", applied: "rejected", decisionAttemptId: decision.id,
    generationKey: gate.generationKey, firstAttemptId: first.id, failureCount: 0, deepseekState: "succeeded", deepseekModel: DEEPSEEK_REVIEW_MODEL,
    deepseekOutcome: { decision: "reject", confidence: 0.8 }, deepseekFailureCount: 0 }]);
  expect(await splitTiebreakStatus()).toMatchObject({ processed: 1, rejected: 1, rejectedToday: 1, awaitingDeepseek: 0 });

  // 다음 틱 — 관문 행은 사람이 거부했을 때처럼 decided_elsewhere 로 닫히고, 다시 묻지 않는다(같은 관문 세대는 두 단계 모두 한 번)
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(await confirm()).toMatchObject({ status: "completed" });
  expect(requests).toHaveLength(1);
  expect(deepseekRequests).toHaveLength(1);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, gate.id)))[0]).toMatchObject({ status: "resolved", resolution: "decided_elsewhere" });
  expect(await splitTiebreakStatus()).toMatchObject({ processed: 1, rejected: 1, approvedWaiting: 0, remaining: 0 });
});

it("DeepSeek 이 승인·판단 보류하거나 원래 확신이 0.70 아래면 닫지 않고 두 판단을 남겨 «Qwen 거부 · DeepSeek 확인 안 됨»으로 사람에게 둔다", async () => {
  const cases = [{ decision: "approve", confidence: 0.9 }, { decision: "needs_review", confidence: 0.5 }, { decision: "reject", confidence: 0.6 }] as const;
  const splits = [];
  for (let index = 0; index < cases.length; index++) splits.push(await split(index));
  await turn({ enabled: true, perTick: 10 });
  await tick();
  expect(await splitTiebreakStatus()).toMatchObject({ awaitingDeepseek: 3 });
  deepseekReply = async body => {
    const index = Number(forRepo(body));
    return { outcome: { decision: cases[index].decision, reason: `DeepSeek says ${cases[index].decision}.`, confidence: cases[index].confidence } };
  };
  // 한 틱에 둘까지 — 두 틱이면 셋 다 본다
  await confirm();
  expect(deepseekRequests).toHaveLength(2);
  await confirm();
  expect(deepseekRequests).toHaveLength(3);
  for (const [index, { candidate }] of splits.entries()) {
    expect(await candidateOf(candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
    expect(await tiebreaksOf(candidate.id)).toMatchObject([{ applied: "held_deepseek", deepseekState: "succeeded",
      deepseekOutcome: { decision: cases[index].decision, confidence: cases[index].confidence } }]);
  }
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "delegated"))).toHaveLength(0);
  const { entries } = await listAdminReviewEntries(await getSettings(), { state: "needs_review" });
  expect(entries.map(entry => [entry.tiebreak?.applied, entry.tiebreak?.deepseek?.decision]).sort()).toEqual([
    ["held_deepseek", "approve"], ["held_deepseek", "needs_review"], ["held_deepseek", "reject"]]);
  expect(await splitTiebreakStatus()).toMatchObject({ rejected: 0, awaitingDeepseek: 0, held: { deepseek: 3 } });
  // 같은 관문 세대는 다시 묻지 않는다
  await confirm();
  expect(deepseekRequests).toHaveLength(3);
});

it("하루(KST) 자동 거부 상한 — 넘으면 두 모델이 거부해도 «하루 상한»으로 사람에게 둔다. 0 이면 닫지 않는다", async () => {
  const one = await split(0), two = await split(1), three = await split(2);
  expect(await turn({ enabled: true, perTick: 10, dailyRejectCap: 1 })).toMatchObject({ ok: true, after: { dailyRejectCap: 1 } });
  await tick();
  await confirm();
  expect(deepseekRequests).toHaveLength(2);
  expect((await candidateOf(one.candidate.id)).state).toBe("rejected");
  expect(await candidateOf(two.candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await tiebreaksOf(two.candidate.id)).toMatchObject([{ applied: "held_daily_cap", deepseekOutcome: { decision: "reject" } }]);
  expect(await splitTiebreakStatus()).toMatchObject({ rejectedToday: 1, held: { dailyCap: 1 } });
  // 어제 닫은 것은 오늘 상한에 세지 않는다
  await db.update(gateSplitTiebreaks).set({ deepseekCompletedAt: sql`${gateSplitTiebreaks.deepseekCompletedAt} - interval '2 days'` })
    .where(eq(gateSplitTiebreaks.candidateId, one.candidate.id));
  await confirm();
  expect(deepseekRequests).toHaveLength(3);
  expect((await candidateOf(three.candidate.id)).state).toBe("rejected");

  // 상한 0 — 닫지 않는다
  const four = await split(3);
  expect(await turn({ enabled: true, perTick: 10, dailyRejectCap: 0 })).toMatchObject({ ok: true });
  await tick();
  await confirm();
  expect(await tiebreaksOf(four.candidate.id)).toMatchObject([{ applied: "held_daily_cap" }]);
  expect((await candidateOf(four.candidate.id)).state).toBe("needs_review");
});

it("DeepSeek 이 탈 나면 사람에게 그대로 두고 항목의 실패로 세지 않는다 — 이 단계만 물러났다가 다시 묻는다", async () => {
  const one = await split(0), two = await split(1);
  await tick();
  deepseekReply = async () => ({ status: 503 });
  await confirm();
  // 첫 호출이 탈 나면 이 틱은 더 부르지 않는다
  expect(deepseekRequests).toHaveLength(1);
  for (const { candidate } of [one, two]) expect((await candidateOf(candidate.id)).state).toBe("needs_review");
  const [failed] = await tiebreaksOf(one.candidate.id);
  expect(failed).toMatchObject({ applied: "awaiting_deepseek", deepseekState: "failed", deepseekErrorCode: "http_503", deepseekFailureCount: 0 });
  expect(failed.deepseekRetryAfter!.getTime()).toBe(deepseekConfirmBackoff.retryAt);
  expect((await splitTiebreakStatus()).deepseekLastError).toMatchObject({ code: "http_503" });
  // 화면은 이 줄에 «Qwen 거부 · DeepSeek 확인 안 됨»을 단다 — 실패한 확인
  const { entries } = await listAdminReviewEntries(await getSettings(), { state: "needs_review" });
  expect(entries.find(entry => entry.candidate.id === one.candidate.id)?.tiebreak?.deepseek).toMatchObject({ errorCode: "http_503", decision: null });

  // 물러나 있는 동안은 부르지 않는다. 연결이 끊긴 것도 같다
  await confirm();
  expect(deepseekRequests).toHaveLength(1);
  resetDeepseekConfirmBackoff();
  await db.update(gateSplitTiebreaks).set({ deepseekRetryAfter: null });
  deepseekReply = async () => ({ down: true });
  await confirm();
  expect(deepseekRequests).toHaveLength(2);
  expect((await tiebreaksOf(one.candidate.id))[0]).toMatchObject({ deepseekErrorCode: "unreachable", deepseekFailureCount: 0 });

  // 물러남이 끝나면 다시 묻고 닫는다
  resetDeepseekConfirmBackoff();
  await db.update(gateSplitTiebreaks).set({ deepseekRetryAfter: null });
  deepseekReply = async () => deepseekReject();
  await confirm();
  expect((await candidateOf(one.candidate.id)).state).toBe("rejected");
  expect((await candidateOf(two.candidate.id)).state).toBe("rejected");

  // 형식 오류는 그 항목의 실패로 센다 — 세 번이면 사람에게
  const three = await split(2);
  await tick();
  deepseekReply = async () => ({ raw: "not json" });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await confirm();
    expect((await tiebreaksOf(three.candidate.id))[0]).toMatchObject({ deepseekErrorCode: "invalid_response", deepseekFailureCount: attempt });
    await db.update(gateSplitTiebreaks).set({ deepseekRetryAfter: null }).where(eq(gateSplitTiebreaks.candidateId, three.candidate.id));
  }
  expect((await tiebreaksOf(three.candidate.id))[0]).toMatchObject({ applied: "held_deepseek_error" });
  const asked = deepseekRequests.length;
  await confirm();
  expect(deepseekRequests).toHaveLength(asked);
  expect((await candidateOf(three.candidate.id)).state).toBe("needs_review");
});

it("두 단계 사이에 스위치를 끄거나 적용 모드를 벗어나면 DeepSeek 에 묻지도 쓰지도 않는다 — 답을 받는 사이 끄면 반영하지 않는다", async () => {
  const { candidate } = await split(0);
  await tick();
  const waiting = await tiebreaksOf(candidate.id);
  expect(waiting).toMatchObject([{ applied: "awaiting_deepseek", deepseekState: "waiting" }]);
  expect(await turn({ enabled: false, perTick: 10 })).toMatchObject({ ok: true });
  await confirm();
  expect(deepseekRequests).toHaveLength(0);
  expect(await tiebreaksOf(candidate.id)).toEqual(waiting);

  // 관찰 모드 — 켜져 있어도 묻지 않는다
  expect(await turn({ enabled: true, perTick: 10 })).toMatchObject({ ok: true });
  expect(await changeReviewMode({ mode: "observe", expectedMode: "enforce", actor: "test", reason: "observe fixture" })).toMatchObject({ ok: true });
  await confirm();
  expect(deepseekRequests).toHaveLength(0);
  expect(await tiebreaksOf(candidate.id)).toEqual(waiting);

  // 적용 모드로 돌아온 뒤 답을 받는 사이 끈다 — 기록 트랜잭션이 스위치를 다시 읽는다
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "observe", actor: "test", reason: "enforce fixture" })).toMatchObject({ ok: true });
  const floor = await auditFloor();
  deepseekReply = async () => {
    expect(await turn({ enabled: false, perTick: 10 })).toMatchObject({ ok: true });
    return deepseekReject();
  };
  await confirm();
  expect(deepseekRequests).toHaveLength(1);
  expect(await candidateOf(candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ applied: "switch_off", deepseekState: "succeeded" }]);
  expect(await auditRowsAfter(floor, "candidate-split-tiebreak-reject")).toHaveLength(0);
});

it("그 사이 사람이 정한 갈림은 DeepSeek 에 묻지 않는다", async () => {
  const { candidate } = await split(0);
  await tick();
  await db.update(crawlCandidates).set({ state: "approved", reason: "passed", decidedBy: "admin" }).where(eq(crawlCandidates.id, candidate.id));
  await confirm();
  expect(deepseekRequests).toHaveLength(0);
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ applied: "superseded" }]);
});

it("M3 에는 한 번에 한 호출 — DeepSeek 위임이 켜져 있어도 위임이 끝난 뒤에 확인을 묻는다", async () => {
  const { candidate } = await split(0);
  await tick();
  const settings = await getSettings();
  expect(await setHumanReviewEnabled({ enabled: true, expectedGeneration: settings.humanReview.generation, actor: "test" })).toMatchObject({ ok: true });
  // 위임도 같은 후보를 본다 — 0.80 거부는 위임의 0.90 문턱에 걸려 판단 보류가 되고, 확인은 원래 답으로 닫는다
  deepseekReply = async () => { await new Promise(resolve => setTimeout(resolve, 50)); return deepseekReject(0.8); };
  expect(await confirm()).toMatchObject({ status: "completed" });
  expect(deepseekRequests.length).toBeGreaterThanOrEqual(2);
  expect(m3.max).toBe(1);
  expect((await candidateOf(candidate.id)).state).toBe("rejected");
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ applied: "rejected" }]);
});

it("Qwen-v2 가 승인하면 발행하지 않고 사람 큐 맨 앞에 «Qwen-v2 승인 — 발행 후보»로 둔다", async () => {
  const unsureCandidate = (await split(0)).candidate;
  const approved = await split(1);
  reply = async body => forRepo(body) === "1" ? approve : unsure;
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(requests).toHaveLength(2);

  for (const id of [unsureCandidate.id, approved.candidate.id]) {
    expect(await candidateOf(id)).toMatchObject({ state: "needs_review", reason: "second_review_split", decidedBy: "auto", publishedSlug: null });
  }
  expect(await db.select().from(products).where(sql`${products.repoUrl} like 'https://github.com/gate-split/%'`)).toHaveLength(0);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, approved.gate.id)))[0]).toMatchObject({ status: "needs_human" });
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "delegated"))).toHaveLength(0);
  expect(await tiebreaksOf(approved.candidate.id)).toMatchObject([{ state: "succeeded", decision: "approve", applied: "kept_human",
    reason: "The homepage introduces a usable product." }]);
  expect(await tiebreaksOf(unsureCandidate.id)).toMatchObject([{ state: "succeeded", decision: "needs_review", applied: "kept_human" }]);

  // id 순이면 0 번이 먼저다 — Qwen-v2 승인이 어떤 정렬보다 앞에 선다
  for (const sort of ["", "wait"] as const) {
    const { entries } = await listAdminReviewEntries(await getSettings(), { state: "needs_review", sort });
    expect(entries.map(entry => entry.candidate.id)).toEqual([approved.candidate.id, unsureCandidate.id]);
    expect(entries[0].tiebreak).toMatchObject({ decision: "approve", current: true, model: QWEN_DIRECT_DEFAULT_MODEL, promptVersion: QWEN_V2_PROMPT_VERSION });
    expect(entries[1].tiebreak).toMatchObject({ decision: "needs_review", current: true });
  }
  expect(await splitTiebreakStatus()).toMatchObject({ processed: 2, rejected: 0, approvedWaiting: 1, remaining: 0, lastError: null });
});

it("같은 관문 세대는 한 번만 묻는다 — 새 1차 판단으로 관문 세대가 바뀌면 다시 묻는다", async () => {
  const { candidate, first, gate } = await split(0);
  reply = async () => unsure;
  await tick();
  await tick();
  expect(requests).toHaveLength(1);

  // 같은 입력의 새 1차 승인과 그 관문 표(새 세대) — 옛 관문 행은 새 세대가 대신한다
  const [next] = await db.insert(crawlReviewAttempts).values({ ...first, id: undefined, attemptNumber: 2 }).returning();
  await db.update(secondReviews).set({ status: "resolved", resolution: "superseded" }).where(eq(secondReviews.id, gate.id));
  await db.insert(secondReviews).values({ ...gate, id: undefined, firstAttemptId: next.id,
    generationKey: secondReviewGeneration(next.id, next, "ai_approved"), status: "needs_human", resolution: null });
  await tick();
  expect(requests).toHaveLength(2);
  expect((await tiebreaksOf(candidate.id)).map(row => [row.firstAttemptId, row.state])).toEqual([[first.id, "succeeded"], [next.id, "succeeded"]]);
  await tick();
  expect(requests).toHaveLength(2);
});

it("스위치를 끄면 묻지 않는다 — 깨진 값은 꺼진 것으로 읽고, 크롤 설정 폼은 이 값을 바꾸지 못한다", async () => {
  const { candidate } = await split(0);
  const floor = await auditFloor();
  expect((await getSettings()).qwenAuto.splitTiebreak).toEqual({ enabled: true, perTick: 10, dailyRejectCap: 50 });
  expect(await turn({ enabled: false, perTick: 10 }, { expected: { enabled: true, perTick: 10 } }))
    .toMatchObject({ ok: true, after: { enabled: false } });
  // 화면이 본 값이 지금 값과 다르면 바꾸지 않는다(compare-and-set). 켤 때는 사유가 있어야 한다
  expect(await turn({ enabled: true, perTick: 10 }, { expected: { enabled: true, perTick: 10 }, actor: "stale" })).toMatchObject({ ok: false });
  expect(await turn({ enabled: true, perTick: 10 }, { reason: " " })).toMatchObject({ ok: false });
  // 바꾼 것은 operations_audit 에 남는다 — 갈림 판가름 스위치도 같다
  expect((await auditRowsAfter(floor, "qwen-auto-settings")).sort((x, y) => x.id - y.id)).toMatchObject([
    { actor: "test", ok: true, detail: { step: "splitTiebreak", before: { enabled: true }, after: { enabled: false } } },
    { actor: "stale", ok: false, error: "stale_state" }, { ok: false, error: "reason_required" }]);
  await tick();
  expect(requests).toHaveLength(0);
  expect(await tiebreaksOf(candidate.id)).toHaveLength(0);

  // 일반 저장·기본값 되돌리기는 이 칸을 건드리지 않는다
  expect(await saveSettings({ qwenAuto: { splitTiebreak: { enabled: true, perTick: 10 } } } as never, "form")).toMatchObject({ ok: true });
  expect((await getSettings()).qwenAuto.splitTiebreak.enabled).toBe(false);

  // 저장된 값이 깨졌으면 켬으로 되살아나지 않는다
  const [row] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
  const values = row.values as { qwenAuto: Record<string, unknown> };
  await db.update(crawlSettings).set({ values: { ...values, qwenAuto: { ...values.qwenAuto, splitTiebreak: { enabled: "yes", perTick: 10 } } } })
    .where(eq(crawlSettings.id, 1));
  expect((await getSettings()).qwenAuto.splitTiebreak.enabled).toBe(false);
  await tick();
  expect(requests).toHaveLength(0);
  expect(await candidateOf(candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });

  // 깨진 값에서도 화면은 지금 값(꺼짐)을 보고 켤 수 있다
  expect(await turn({ enabled: true, perTick: 2 })).toMatchObject({ ok: true });
  await tick();
  expect(requests).toHaveLength(1);
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ applied: "awaiting_deepseek" }]);
});

it("답을 받는 사이 스위치를 끄면 거부로 닫지 않는다 — 기록 트랜잭션이 스위치를 다시 읽는다", async () => {
  const { candidate } = await split(0);
  const floor = await auditFloor();
  reply = async () => {
    expect(await turn({ enabled: false, perTick: 10 })).toMatchObject({ ok: true });
    return reject();
  };
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(requests).toHaveLength(1);
  expect(await candidateOf(candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ state: "succeeded", decision: "reject", applied: "switch_off" }]);
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "delegated"))).toHaveLength(0);
  expect(await auditRowsAfter(floor, "candidate-split-tiebreak-reject")).toHaveLength(0);
});

it("사람 없이 거부로 닫는 것은 적용 모드에서, 확신 0.90 이상일 때만이다 — 아니면 답만 남기고 사람에게 둔다", async () => {
  const low = await split(0);
  reply = async () => ({ status: 200, outcome: { decision: "reject", reason: "The page is only a placeholder.", confidence: 0.8 } });
  await tick();
  expect(await candidateOf(low.candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await tiebreaksOf(low.candidate.id)).toMatchObject([{ state: "succeeded", decision: "reject", confidence: 0.8, applied: "held_low_confidence" }]);

  // 관찰 모드 — 확신이 높아도 닫지 않는다
  const observed = await split(1);
  expect(await changeReviewMode({ mode: "observe", expectedMode: "enforce", actor: "test", reason: "observe fixture" })).toMatchObject({ ok: true });
  reply = async () => reject();
  await tick();
  expect(await candidateOf(observed.candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await tiebreaksOf(observed.candidate.id)).toMatchObject([{ state: "succeeded", decision: "reject", applied: "held_not_enforce" }]);
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "delegated"))).toHaveLength(0);
  expect(await splitTiebreakStatus()).toMatchObject({ rejected: 0, heldReject: 2 });
});

it("부르는 곳이 탈 나면 후보·관문을 그대로 두고 물러난다 — 항목의 실패로 세지 않는다", async () => {
  const one = await split(0), two = await split(1);
  reply = async () => ({ status: 503 });
  const floor = await auditFloor();
  expect(await tick()).toMatchObject({ status: "completed" });
  // 첫 호출이 탈 나면 이 틱은 더 부르지 않는다
  expect(requests).toHaveLength(1);
  for (const { candidate, gate } of [one, two]) {
    expect(await candidateOf(candidate.id)).toEqual(candidate);
    expect((await db.select().from(secondReviews).where(eq(secondReviews.id, gate.id)))[0]).toMatchObject({ status: "needs_human", resolution: null });
  }
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "delegated"))).toHaveLength(0);
  expect(await auditRowsAfter(floor, "candidate-split-tiebreak-reject")).toHaveLength(0);
  const [failed] = await tiebreaksOf(one.candidate.id);
  expect(failed).toMatchObject({ state: "failed", errorCode: "qwen_http_503", failureCount: 0, decision: null, applied: null });
  // gpu3090 을 부르는 모두가 함께 물러난다(qwen-endpoint-backoff.ts — 첫 탈은 1분). 이 항목은 물러남이 끝날 때 다시 묻는다
  expect(qwenEndpointBackingOff()).toBe(true);
  expect(qwenEndpointBackoff).toMatchObject({ failures: 1, lastError: "qwen_http_503" });
  expect(failed.retryAfter!.getTime()).toBe(qwenEndpointBackoff.retryAt);
  expect(failed.retryAfter!.getTime()).toBeGreaterThan(Date.now() + 50_000);
  expect((await splitTiebreakStatus()).lastError).toMatchObject({ code: "qwen_http_503" });

  // 물러나 있는 동안은 다른 후보도 부르지 않는다 — 감사 쪽이 탈을 만나 물러나는 중이어도 같다
  reply = async () => reject();
  await tick();
  expect(requests).toHaveLength(1);

  // 물러남이 끝나면 다시 묻는다
  resetQwenAuditBackoff();
  await db.update(gateSplitTiebreaks).set({ completedAt: sql`${gateSplitTiebreaks.completedAt} - interval '10 minutes'`,
    retryAfter: sql`${gateSplitTiebreaks.retryAfter} - interval '10 minutes'` });
  await tick();
  expect(requests).toHaveLength(3);
  expect(await tiebreaksOf(one.candidate.id)).toMatchObject([{ state: "succeeded", applied: "awaiting_deepseek", failureCount: 0 }]);
  expect(await tiebreaksOf(two.candidate.id)).toMatchObject([{ state: "succeeded", applied: "awaiting_deepseek" }]);
  await confirm();
  expect(await candidateOf(one.candidate.id)).toMatchObject({ state: "rejected" });
  expect(await candidateOf(two.candidate.id)).toMatchObject({ state: "rejected" });
});

it("거부가 다수가 아니거나 카탈로그 같은 거부면 거부로 닫지 않고 사람에게 남긴다", async () => {
  // 1차 확신이 낮아 2차가 승인했는데도 사람에게 넘어온 것 — 승인 2 : 거부 1
  const minority = await split(0, "approve", { firstConfidence: 0.4 });
  const catalog = await split(1, "reject", { reason: "A list of links to other tools." });
  reply = async body => forRepo(body) === "1" ? reject("This is a curated directory of AI tools.") : reject();
  await tick();
  expect(requests).toHaveLength(2);
  expect(await candidateOf(minority.candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await candidateOf(catalog.candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await tiebreaksOf(minority.candidate.id)).toMatchObject([{ decision: "reject", applied: "held_minority" }]);
  expect(await tiebreaksOf(catalog.candidate.id)).toMatchObject([{ decision: "reject", applied: "held_catalog" }]);
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "delegated"))).toHaveLength(0);
  expect(await splitTiebreakStatus()).toMatchObject({ processed: 2, rejected: 0, heldReject: 2, approvedWaiting: 0 });
});

it("원본이 관문 뒤에 바뀌었으면 묻지 않고 사람에게 남긴다", async () => {
  const { candidate } = await split(0);
  // 관문이 본 원본이 아니다 — 새 원본을 보지 않은 답으로 닫지 않는다
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.repo, candidate.repo));
  await tick();
  expect(requests).toHaveLength(0);
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ state: "ineligible", errorCode: "source_changed" }]);
  expect(await candidateOf(candidate.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  expect(await splitTiebreakStatus()).toMatchObject({ ineligible: 1, remaining: 0 });
});

it("답을 받는 사이 잡 lease 를 잃으면 후보도 기록도 쓰지 않는다", async () => {
  const { candidate } = await split(0);
  const floor = await auditFloor();
  reply = async () => {
    await db.update(jobs).set({ leaseToken: "replacement", lockedAt: new Date() }).where(eq(jobs.name, "second-review"));
    return reject();
  };
  expect(await tick()).toMatchObject({ status: "failed", error: "job_lease_lost" });
  expect(requests).toHaveLength(1);
  expect(await candidateOf(candidate.id)).toEqual(candidate);
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "delegated"))).toHaveLength(0);
  expect(await auditRowsAfter(floor, "candidate-split-tiebreak-reject")).toHaveLength(0);
  // 잡을 때 쓴 running 은 남는다 — 다음 주인이 끝내지 못한 시도로 센다
  expect(await tiebreaksOf(candidate.id)).toMatchObject([{ state: "running", decision: null }]);
});

it("같은 모델 규칙 — 관문 표가 Qwen-v2 와 같은 모델이면 세 번째 표가 독립이 아니라 묻지 않고 사람에게 남긴다", async () => {
  // 관문 표를 게이트웨이의 같은 Qwen(자리 표시만 다르다)으로 세웠다 — 다른 모델(Qwen 27B 등)의 관문은 위 시험들이 본다
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "[gpu3090] qwen3.8-flash-next" }], sampleRate: 0 } }, "test");
  const same = await split(0);
  expect(same.gate.model).toBe("[gpu3090] qwen3.8-flash-next");
  await tick();
  expect(requests).toHaveLength(0);
  expect(await candidateOf(same.candidate.id)).toEqual(same.candidate);
  expect(await tiebreaksOf(same.candidate.id)).toMatchObject([{ state: "ineligible", errorCode: "same_model", decision: null }]);
  // 다시 돌아도 묻지 않는다
  await tick();
  expect(requests).toHaveLength(0);
});
