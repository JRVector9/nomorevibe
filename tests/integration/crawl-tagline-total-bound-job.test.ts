import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { crawlCandidates, crawlDocuments } from "@/lib/db/schema";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { crawlTaglineGatewayWire, taglineEvidence } from "@/lib/crawl/tagline";
import { pendingTaglines } from "@/lib/crawl/taglines";
import { requestJob } from "@/lib/jobs/control";
import { tryAcquireRole, type RoleLease } from "@/lib/jobs/role-leader";
import { runJob } from "@/lib/jobs/runner";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { resetProviderRateLimitsForTest } from "@/lib/llm/provider-rate-limit";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { textRankRow } from "../text-task-ranks-fixture";
import { contractRow, totalBoundContract } from "../total-bound-direct-fixture";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 2026-11-21 abcllm 이름표 정리 1단계: 실제 잡 한 틱(crawl-tagline)이 엔진 직접 총량 상한 계약(openai-chat-total-bound-v1, provider local-direct)으로
 * 끝까지 돈다 — 순위 묶기(계약의 provider) → 장부 매핑 확인 → 예약·dispatch → 전송 → 정산 → 결과 저장(lib/crawl/taglines.ts 가 장부 행의 provider 를
 * binding 의 provider 와 견준다. 예전에는 abcllm 글자와 견줘 local-direct 행의 결과를 적지 못했다).
 * 보낸 바이트는 abcllm 계약 때와 같은 그 경로의 wire 다. mock 없이 실제 resolver·계약 스냅숏·순위 스냅숏으로 본다. 자기 DB 를 새로 만든다.
 */
const name = `nomorevibe_test_tagline_total_bound_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
const JOB = "crawl-tagline", MODEL = "fixture-tagline-model", prefix = `tagline-total-bound-${randomUUID().slice(0, 12)}`;
const policy: ModelCapacityPolicy = { version: 1, maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 60_000, groupLimits: { "device-direct": 2 },
  routes: [{ routeId: JOB, provider: "local-direct", model: MODEL, providerBudgetId: "account-direct", groupId: "device-direct" }] };
let created = false, role: RoleLease, origin = "", serial = 0;
const engine = { status: 200, requests: [] as { headers: IncomingHttpHeaders; body: string }[] };
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", chunk => chunks.push(chunk as Buffer));
  request.on("end", () => {
    engine.requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (engine.status !== 200) { response.statusCode = engine.status; response.setHeader("retry-after", "30"); response.end('{"error":"rate limit"}'); return; }
    response.end(JSON.stringify({ id: "tagline-total-bound", object: "chat.completion", created: 1, model: "served-tagline",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ tagline: "Document manager", source: "page" }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90 } }));
  });
});
async function seed() {
  const repo = `${prefix}/doc-${++serial}`;
  await db.insert(crawlDocuments).values({ repo, repoMeta: {}, productUrl: "https://doc.test", pageStatus: 200, pageMeta: { title: "Doc", textSample: "Document management tools" } });
  await db.insert(crawlCandidates).values({ repo, productUrl: "https://doc.test", state: "needs_review", reason: "no_description", decidedBy: "auto" });
  const selected = (await pendingTaglines(32)).find(task => task.candidate.repo === repo);
  if (!selected) throw new Error("fixture_pending_required");
  return selected;
}
async function tick() { await requestJob(JOB); return runJob(JOB, writeTaglines, { requestedOnly: true, roleLease: role }); }
const ledger = (repo: string) => client`SELECT r.state, r.provider, r.dispatch_binding->>'provider' AS bound, r.terminal_evidence->>'kind' AS kind
  FROM model_capacity_requests r JOIN crawl_candidates c ON r.logical_member_keys && ARRAY['crawl-tagline:' || c.id]::text[] WHERE c.repo=${repo} ORDER BY r.queue_ordinal`;

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(path.resolve("."), "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await client`UPDATE model_capacity_control SET mode='open', policy=${JSON.stringify(policy)}::jsonb, policy_hash=${modelCapacityPolicyHash(policy)},
    revision=revision+1, cursor=0, updated_at=clock_timestamp() WHERE id=1`;
  await client`INSERT INTO crawl_settings(id,values) VALUES(1,'{"enabled":true}') ON CONFLICT(id) DO UPDATE SET values=crawl_settings.values||'{"enabled":true}'::jsonb`;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("local_address");
  origin = `http://127.0.0.1:${address.port}`;
  const acquired = await tryAcquireRole({ role: "text", instanceId: prefix, bootId: randomUUID(), release: "total-bound-fixture", kind: "primary" });
  if (!acquired) throw new Error("fixture_text_role_required");
  role = acquired;
}, 240_000);
function open() {
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: role.role, ROLE_LEASE_INSTANCE_ID: role.instanceId, ROLE_LEASE_BOOT_ID: role.bootId,
    ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: String(role.epoch) })) vi.stubEnv(key, value);
  // 순위 1줄: 이 엔진 주소의 연결 + 모델. 그 연결을 가리키는 계약은 새 모양(local-direct) 하나뿐이다
  setAiTaskModelsForTest([textRankRow(JOB, MODEL, { baseUrl: `${origin}/v1` })]);
  setServingContractSnapshotForTest([contractRow(totalBoundContract(JOB, { model: MODEL, endpoint: `${origin}/v1/chat/completions`, responseModel: "served-tagline" }), "gateway")]);
}
afterEach(() => { engine.status = 200; engine.requests.length = 0; vi.unstubAllEnvs(); setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null);
  resetProviderRateLimitsForTest(); });
afterAll(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

it("a real crawl-tagline tick writes the tagline through a local-direct total-bound contract with the abcllm-era wire bytes", async () => {
  open();
  const task = await seed();
  expect(await tick()).toMatchObject({ status: "completed", done: true });
  expect(engine.requests).toHaveLength(1);
  // abcllm 계약 때와 같은 바이트(같은 시험이 abcllm 계약으로 보는 식과 같다 — crawl-tagline-capacity-dispatch.test.ts), 엄격 terminal 헤더 없음
  expect(engine.requests[0].body).toBe(crawlTaglineGatewayWire(taglineEvidence(task.candidate.repo, task.document), MODEL));
  expect(engine.requests[0].headers["x-abcllm-strict-terminal"]).toBeUndefined();
  expect(Array.from(await ledger(task.candidate.repo))).toEqual([{ state: "settled", provider: "local-direct", bound: "local-direct", kind: "crawl_tagline_gateway_terminal" }]);
  expect((await client`SELECT tagline, attempts, error_code FROM crawl_taglines WHERE repo=${task.candidate.repo}`)[0]).toEqual({ tagline: "Document manager", attempts: 1, error_code: null });
  expect((await client`SELECT state FROM crawl_candidates WHERE id=${task.candidate.id}`)[0].state).toBe("approved");
  expect((await client`SELECT requested_version=processed_version AS ack, last_error FROM jobs WHERE name=${JOB}`)[0]).toEqual({ ack: true, last_error: null });
}, 30_000);

it("records a provider 429 of the same contract in the same tick as a settled rejection", async () => {
  open(); engine.status = 429;
  const task = await seed();
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(engine.requests).toHaveLength(1);
  expect(Array.from(await ledger(task.candidate.repo))).toEqual([{ state: "settled", provider: "local-direct", bound: "local-direct", kind: "gateway_http_rejected" }]);
  expect((await client`SELECT attempts, error_code FROM crawl_taglines WHERE repo=${task.candidate.repo}`)[0]).toEqual({ attempts: 1, error_code: "rate_limit" });
}, 30_000);
