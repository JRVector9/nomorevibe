import http from "node:http";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { nativeGuard } = vi.hoisted(() => ({ nativeGuard: { origin: "" } }));
vi.mock("@/lib/net/fetch", async original => ({ ...await original<typeof import("@/lib/net/fetch")>(),
  safeFetch: () => { throw new Error("fixture_news_unexpected_source_fetch"); },
  fetchCapped: () => { throw new Error("fixture_news_unexpected_source_fetch"); },
}));
vi.mock("@/lib/llm/gateway-local-end-fetch", async original => {
  const actual = await original<typeof import("@/lib/llm/gateway-local-end-fetch")>();
  return { ...actual, gatewayFetch: (...args: Parameters<typeof actual.gatewayFetch>) => {
    const target = args[1], url = typeof target === "string" ? target : "href" in target ? target.href : target.url;
    if (!nativeGuard.origin || new URL(url).origin !== nativeGuard.origin) throw new Error("fixture_external_model_request_refused");
    return actual.gatewayFetch(...args);
  } };
});
import { db } from "@/lib/db";
import { reviewLlmAssist } from "@/lib/jobs/products/llm-assist-review";
import { enqueueNewsLocalizationRuntimeDemand, newsLocalizationRuntimeSourceHash } from "@/lib/domain/llm-assist/news-runtime";
import { ASSIST_SCHEMA_VERSION, assistHash } from "@/lib/domain/llm-assist/contracts";
import { buildNewsLocalizationInput, type NewsLocalizationOutcome, type NewsLocalizationSource } from "@/lib/news/localization-contract";
import { lockNewsLocalizationSource } from "@/lib/news/localization-repository";
import { originalNewsLocalizationFallback } from "@/lib/news/localization-work";
import { localModelContractHash, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { JobContext } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = `news-native-${randomUUID().slice(0, 8)}`, backendId = "fixture-news-qwen", model = "qwen3.8-flash-next";
const jobName = "product-llm-assist-review", originJob = "news-refresh", jobNames = [jobName, originJob];
const owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const server = http.createServer();
const originalFetch = globalThis.fetch;
const ownedNews: number[] = [];
let contract: LocalModelServingContract, policy: ModelCapacityPolicy, jobToken = "", serial = 0;
let originalCapacity: Record<string, unknown>, originalControl: Record<string, unknown>, originalRole: Record<string, unknown> | null;
let originalJobs: Record<string, unknown>[], calls: { requestId: string; body: Record<string, unknown> }[] = [];
let source: NewsLocalizationSource, scenario: "price" | "research" | "weights" = "price";
let responseMode: "good" | "lost_denominator" | "invented_ga" | "lost_qualification" | "broadened_scope" | "invalid" = "good";
let onCall: (() => Promise<void>) | null = null;

const originalText = () => scenario === "research" ? {
  title: "Helio researchers report lower latency in a preliminary study.",
  summary: "Helio researchers report up to 18% lower p95 latency across 64 test tasks in a preprint. The result has not been independently reproduced. No product has launched.",
} : scenario === "weights" ? {
  title: "LumaFlow publishes model weights under Apache 2.0.",
  summary: "LumaFlow published model weights. It does not claim that training data or training code are available.",
} : {
  title: "Mira announces paid preview pricing for November.",
  summary: "Mira plans to begin its API paid preview on November 2, 2026. Pricing will be $3 per million input tokens and $9 per million output tokens. The service is not available yet.",
};
function outcome(): NewsLocalizationOutcome {
  const text = originalText();
  const state: NewsLocalizationOutcome["state"] = { names: [], prices: [], quantities: [], dates: [],
    release: { stage: "unknown", availability: "unknown", scope: [] }, qualifications: [], draft: { title: null, summary: null } };
  if (scenario === "price") {
    state.names = [{ original: "Mira", korean: null }];
    state.prices = [
      { amount: "3", currency: "USD", per_quantity: "1000000", per_unit: "tokens", direction: "input", effective_status: "planned" },
      { amount: "9", currency: "$", per_quantity: "million", per_unit: "토큰", direction: "output", effective_status: "planned" },
    ];
    state.dates = [{ original: "November 2, 2026", iso_date: "2026-11-02", event: "API preview" }];
    state.release = { stage: "preview", availability: "planned", scope: ["api"] };
    state.draft = { title: "Mira, 11월 API 유료 프리뷰 가격 발표",
      summary: "Mira는 2026년 11월 2일 API 유료 프리뷰를 시작할 예정이며, 입력 100만 토큰당 3달러, 출력 100만 토큰당 9달러다." };
    if (responseMode === "lost_denominator") state.draft.summary = "Mira는 2026년 11월 2일 API 유료 프리뷰를 시작할 예정이며 입력 토큰당 3달러, 출력 토큰당 9달러다.";
    if (responseMode === "invented_ga") state.draft = { title: "Mira, API 정식 출시", summary: "Mira는 2026년 11월 2일 API를 정식 출시했으며 입력 100만 토큰당 3달러, 출력 100만 토큰당 9달러로 현재 이용할 수 있다." };
  } else if (scenario === "research") {
    state.names = [{ original: "Helio", korean: null }];
    state.release = { stage: "research", availability: "unknown", scope: ["paper"] };
    state.draft = { title: "Helio 연구진, 지연 최대 18% 감소 보고",
      summary: "Helio 연구팀은 64개 테스트에서 최대 18% 낮은 지연을 보고했으나 독립적으로 재현되지 않았다." };
    if (responseMode === "lost_qualification") state.draft = { title: "Helio 연구진, 지연 18% 감소 검증",
      summary: "Helio 연구팀은 64개 테스트에서 지연이 18% 감소했음을 독립적으로 검증했다." };
  } else {
    state.names = [{ original: "LumaFlow", korean: null }];
    state.release = { stage: "unknown", availability: "available", scope: ["weights"] };
    state.draft = { title: "LumaFlow, 모델 가중치 공개",
      summary: "LumaFlow는 모델 가중치를 공개했으며 학습 데이터나 학습 코드 공개는 밝히지 않았다." };
    if (responseMode === "broadened_scope") state.draft = { title: "LumaFlow, 가중치와 학습 자료 공개",
      summary: "LumaFlow는 가중치와 학습 데이터 및 학습 코드를 공개했다." };
  }
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "news", state,
    evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: buildNewsLocalizationInput(source).sources[0].sourceId, quote: text.title, supports: ["/state/release/stage"] }],
    action: { proposal: "publish_translation_candidate", reason_ko: "공식 원문의 사실을 보존한 한국어 초안입니다.", missing_items: [] } };
}
function context(signal?: AbortSignal): JobContext<null> {
  return { cursor: null, lease: { name: jobName, token: jobToken, requestedVersion: 0 },
    signal, save: async () => {}, hasBudget: () => true, log: () => {} };
}
async function snapshot(id: number) { return (await admin`SELECT to_jsonb(n) AS row FROM news_items n WHERE id=${id}`)[0]?.row; }
async function fixtureNews(state: NewsLocalizationSource["state"] = "approved") {
  const text = originalText();
  const [row] = await admin`INSERT INTO news_items(source_key,url,title,summary,published_at,state,decided_by,decided_at,created_at)
    VALUES(${prefix},${`https://${prefix}.example/${++serial}`},${text.title},${text.summary},clock_timestamp(),${state},'auto',
      clock_timestamp()-interval '1 minute',clock_timestamp()-interval '2 minutes') RETURNING id`;
  const id = Number(row.id); ownedNews.push(id);
  source = (await db.transaction(tx => lockNewsLocalizationSource(tx, id)))!;
  return { id, original: await snapshot(id) };
}
async function enqueue(id: number) { return db.transaction(tx => enqueueNewsLocalizationRuntimeDemand(tx, id)); }
async function drafts(id: number) { return Array.from(await admin`SELECT * FROM news_localizations WHERE news_item_id=${id}`); }
async function works(id: number) { return Array.from(await admin`SELECT * FROM llm_assist_work WHERE task='news' AND news_item_id=${id}`); }
async function requests() { return Array.from(await admin`SELECT * FROM model_capacity_requests WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal`); }
async function recorded() { return Array.from(await admin`SELECT r.* FROM llm_assist_results r JOIN model_capacity_requests n ON n.request_id=r.capacity_request_id WHERE n.owner_instance_id=${prefix}`); }
async function cleanFixture() {
  for (const id of ownedNews.splice(0)) await admin`DELETE FROM news_items WHERE id=${id} AND source_key=${prefix}`;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = (await tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix} FOR UPDATE`).map(row => row.request_id);
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    expect(Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)).toEqual([
      { tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" },
    ]);
  });
}
async function restoreSingletons() {
  await admin`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
    policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalCapacity)}::text::jsonb) r WHERE c.id=r.id`;
  await admin`UPDATE llm_assist_controls c SET mode=r.mode,confirmation_required=r.confirmation_required,
    dispatch_enabled=r.dispatch_enabled,apply_enabled=r.apply_enabled,revision=r.revision,updated_at=r.updated_at
    FROM jsonb_populate_record(NULL::llm_assist_controls,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.task='news'`;
  await admin`DELETE FROM jobs WHERE name=ANY(${jobNames})`;
  if (originalJobs.length) await admin`INSERT INTO jobs SELECT * FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb)`;
  await admin`DELETE FROM role_leases WHERE role='reviewer' AND owner_instance_id=${prefix}`;
  if (originalRole) await admin`INSERT INTO role_leases SELECT * FROM jsonb_populate_record(NULL::role_leases,${JSON.stringify(originalRole)}::text::jsonb)`;
}

beforeAll(async () => {
  ensureSchema();
  [{ row: originalCapacity }] = await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`;
  [{ row: originalControl }] = await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='news'`;
  expect(originalControl).toBeDefined();
  originalRole = (await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null;
  originalJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  server.on("request", async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer fixture-key") throw new Error("fixture_invalid_model_request");
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push({ requestId: String(req.headers["x-nmv-relay-request-id"] ?? ""), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const content = responseMode === "invalid" ? "not JSON" : JSON.stringify(outcome());
      await onCall?.();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_server_missing");
  nativeGuard.origin = `http://127.0.0.1:${address.port}`;
  contract = { version: 1, protocol: "local-openai-chat-v1", backendId, provider: "local-direct", physicalGroup: "fixture-news-gpu",
    endpoint: `${nativeGuard.origin}/v1/chat/completions`, model, responseModel: model, modelFamily: "qwen3.8-flash-next", deploymentRevision: "news-native-fixture-1",
    contextWindowTokens: 50000, totalTokenBound: 50000, maxOutputTokens: 2048, maxInputBytes: 100000,
    capabilities: { vision: false, jsonSchema: true }, thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
  policy = { version: 1, globalLimit: 1, providerLimits: { [backendId]: 1 }, groupLimits: { "fixture-news-gpu": 1 }, poolLimits: { reviewer: 1, text: 1 },
    weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60000, reservationTtlMs: 60000,
    routes: [{ routeId: `local-assist-news-${backendId}`, provider: "local-direct", model, providerBudgetId: backendId, groupId: "fixture-news-gpu" }] };
});
beforeEach(async () => {
  calls = []; scenario = "price"; responseMode = "good"; onCall = null; jobToken = randomUUID();
  vi.stubGlobal("fetch", ((target, init) => {
    const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
    if (!nativeGuard.origin || new URL(url).origin !== nativeGuard.origin) throw new Error("fixture_external_fetch_refused");
    return originalFetch(target, init);
  }) satisfies typeof fetch);
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: "reviewer", ROLE_LEASE_INSTANCE_ID: prefix, ROLE_LEASE_BOOT_ID: owner.bootId,
    ROLE_LEASE_RELEASE: prefix, ROLE_LEASE_EPOCH: "1", LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([contract]),
    LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify({ [backendId]: localModelContractHash(contract) }),
    LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "fixture-news-gpu": 1 }), LLM_ASSIST_API_KEYS: JSON.stringify({ [backendId]: "fixture-key" }),
    LLM_ASSIST_BACKENDS: JSON.stringify([{ backendId, tasks: ["news"], maxClaims: 1 }]), NEWS_LOCALIZATION_BACKEND_ENABLED: "true" })) vi.stubEnv(key, value);
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 WHERE id=1`;
  await admin`UPDATE llm_assist_controls SET mode='shadow',dispatch_enabled=true,apply_enabled=false,revision=2 WHERE task='news'`;
  await admin`INSERT INTO role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    VALUES('reviewer',${prefix},${owner.bootId},${prefix},'primary',1,clock_timestamp()+interval '1 hour')
    ON CONFLICT(role) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,
      owner_release=excluded.owner_release,owner_kind=excluded.owner_kind,epoch=1,lease_until=excluded.lease_until`;
  for (const name of jobNames) await admin`INSERT INTO jobs(name,lease_token,locked_at) VALUES(${name},${name === jobName ? jobToken : null},${name === jobName ? new Date() : null})
    ON CONFLICT(name) DO UPDATE SET lease_token=excluded.lease_token,locked_at=excluded.locked_at,not_before=NULL`;
});
afterEach(async () => {
  server.closeAllConnections();
  try { await cleanFixture(); await restoreSingletons(); } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});
afterAll(async () => {
  try {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); nativeGuard.origin = "";
    expect((await admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`)[0]?.row).toEqual(originalCapacity);
    expect((await admin`SELECT to_jsonb(c) AS row FROM llm_assist_controls c WHERE task='news'`)[0]?.row).toEqual(originalControl);
    expect((await admin`SELECT to_jsonb(c) AS row FROM role_leases c WHERE role='reviewer'`)[0]?.row ?? null).toEqual(originalRole);
    const restoredJobs = (await admin`SELECT to_jsonb(c) AS row FROM jobs c WHERE name=ANY(${jobNames})`).map(row => row.row);
    expect(restoredJobs).toHaveLength(originalJobs.length); expect(restoredJobs).toEqual(expect.arrayContaining(originalJobs));
    expect(await requests()).toHaveLength(0);
  } finally { await admin.end(); }
});

describe("뉴스 한국어 초안의 실제 native 소비자", () => {
  it("가격·분모·입출력·예정 프리뷰를 보존한 초안만 저장하고 공식 원문은 그대로 둔다", async () => {
    const news = await fixtureNews(); const queued = await enqueue(news.id);
    expect(queued).toMatchObject({ state: "queued", created: true });
    const [work] = await works(news.id);
    expect(work.product_id).toBeNull(); expect(work.news_item_id).toBe(news.id);
    expect(work.source_hash).toBe(newsLocalizationRuntimeSourceHash({ kind: "news", locale: "ko", news: source }));
    expect(work.source_hash).not.toBe(assistHash(work.source));
    await reviewLlmAssist(context());
    expect(calls).toHaveLength(1);
    const [request] = await requests(), [draft] = await drafts(news.id), [result] = await recorded();
    expect(request).toMatchObject({ state: "settled", logical_work_key: `direct:assist:${news.id}:news` });
    expect(calls[0].requestId).toBe(request.request_id);
    expect(request.dispatch_binding).toMatchObject({ sourceRevisionHash: work.source_hash, totalTokenBound: 50000, chargedTokens: 50000 });
    expect(draft).toMatchObject({ status: "draft", model_family: "qwen3.8-flash-next", backend_id: backendId,
      validation: { ok: true, authority: "translation_candidate_only", semanticCoverage: "bounded_patterns" } });
    expect(draft.summary).toContain("100만 토큰당"); expect(draft.summary).toContain("예정");
    expect(result).toMatchObject({ applied: false, capacity_request_id: request.request_id });
    expect(await snapshot(news.id)).toEqual(news.original);
    expect(originalNewsLocalizationFallback(source)).toEqual({ title: source.title, summary: source.summary, language: "original" });
    await reviewLlmAssist(context()); expect(calls).toHaveLength(1);
  });
  it.each(["research", "weights"] as const)("%s의 한정·공개 범위를 보존해도 초안 권한만 가진다", async selected => {
    scenario = selected; const news = await fixtureNews(); await enqueue(news.id); await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await drafts(news.id))[0]).toMatchObject({ status: "draft", validation: { authority: "translation_candidate_only" } });
    expect(await snapshot(news.id)).toEqual(news.original);
  });
  it.each([
    ["price", "lost_denominator"], ["price", "invented_ga"], ["research", "lost_qualification"], ["weights", "broadened_scope"],
  ] as const)("%s / %s 의미 변형은 settled 이후에도 needs_review로 남긴다", async (selected, selectedMode) => {
    scenario = selected; responseMode = selectedMode; const news = await fixtureNews(); await enqueue(news.id); await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0].state).toBe("settled");
    expect((await drafts(news.id))[0]).toMatchObject({ status: "needs_review", validation: { ok: false, disposition: "needs_review" } });
    expect(await snapshot(news.id)).toEqual(news.original); expect((await recorded())[0].applied).toBe(false);
  });
  it("동시·반복 명시 수요는 원문당 한 작업과 한 모델 호출로 합친다", async () => {
    const news = await fixtureNews(); const enqueued = await Promise.all([0, 1].map(() => enqueue(news.id)));
    expect(enqueued.filter(value => value.state === "queued" && value.created)).toHaveLength(1);
    expect(await works(news.id)).toHaveLength(1); await reviewLlmAssist(context());
    expect(await enqueue(news.id)).toMatchObject({ state: "queued", created: false }); await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect(await drafts(news.id)).toHaveLength(1); expect(await snapshot(news.id)).toEqual(news.original);
  });
  it("pending 원문의 초안을 저장해도 승인 상태로 바꾸지 않는다", async () => {
    const news = await fixtureNews("pending"); await enqueue(news.id); await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await drafts(news.id))[0].status).toBe("draft"); expect(await snapshot(news.id)).toEqual(news.original);
  });
  it("오래된 공식 기사도 현재 DB 원문 세대가 같으면 원래 게시 시각을 보존한 초안을 만든다", async () => {
    const news = await fixtureNews();
    await admin`UPDATE news_items SET created_at=created_at-interval '7 days',published_at=published_at-interval '7 days',
      decided_at=decided_at-interval '7 days' WHERE id=${news.id}`;
    source = (await db.transaction(tx => lockNewsLocalizationSource(tx, news.id)))!;
    const original = await snapshot(news.id); await enqueue(news.id); await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await drafts(news.id))[0]).toMatchObject({ status: "draft", source_snapshot: { observedAt: source.observedAt } });
    expect(await snapshot(news.id)).toEqual(original);
  });
  it("hidden과 기본 feature off는 명시 수요도 닫는다", async () => {
    const news = await fixtureNews("hidden"); expect(await enqueue(news.id)).toEqual({ state: "hidden" });
    vi.stubEnv("NEWS_LOCALIZATION_BACKEND_ENABLED", "false"); expect(await enqueue(news.id)).toEqual({ state: "disabled" });
    await reviewLlmAssist(context()); expect(calls).toHaveLength(0); expect(await drafts(news.id)).toHaveLength(0); expect(await snapshot(news.id)).toEqual(news.original);
  });
  it("원시 revision 1µs가 바뀌면 과거 원문으로 호출하지 않는다", async () => {
    const news = await fixtureNews(); await enqueue(news.id);
    await admin`UPDATE news_items SET decided_at=decided_at+interval '1 microsecond' WHERE id=${news.id}`;
    const changed = await snapshot(news.id); await reviewLlmAssist(context());
    expect(calls).toHaveLength(0); expect(await drafts(news.id)).toHaveLength(0); expect(await snapshot(news.id)).toEqual(changed);
  });
  it("응답 중 관리자가 숨긴 원문은 초안 저장이나 자동 복구로 되살리지 않는다", async () => {
    const news = await fixtureNews(); await enqueue(news.id); let changed: unknown;
    onCall = async () => { await admin`UPDATE news_items SET state='hidden',decided_by='fixture-operator',decided_at=clock_timestamp() WHERE id=${news.id}`; changed = await snapshot(news.id); };
    await reviewLlmAssist(context()); expect(calls).toHaveLength(1); expect((await requests())[0].state).toBe("settled");
    expect(await drafts(news.id)).toHaveLength(0); expect(await snapshot(news.id)).toEqual(changed);
  });
  it("응답 중 dispatch 중단은 원문과 공개 상태를 바꾸지 않는다", async () => {
    const news = await fixtureNews(); await enqueue(news.id);
    onCall = async () => { await admin`UPDATE llm_assist_controls SET dispatch_enabled=false,revision=revision+1 WHERE task='news'`; };
    await reviewLlmAssist(context()); expect(calls).toHaveLength(1); expect((await requests())[0].state).toBe("settled");
    expect(await drafts(news.id)).toHaveLength(0); expect(await snapshot(news.id)).toEqual(news.original);
  });
  it.each(["feature", "origin", "consumer"] as const)("큐가 있어도 %s 중단은 새 모델 호출을 열지 않는다", async stopped => {
    const news = await fixtureNews(); await enqueue(news.id);
    if (stopped === "feature") vi.stubEnv("NEWS_LOCALIZATION_BACKEND_ENABLED", "false");
    else await admin`UPDATE jobs SET not_before=clock_timestamp()+interval '1 hour' WHERE name=${stopped === "origin" ? originJob : jobName}`;
    await reviewLlmAssist(context()); expect(calls).toHaveLength(0);
    expect((await requests()).every(request => request.dispatched_at === null)).toBe(true);
    expect(await drafts(news.id)).toHaveLength(0); expect(await snapshot(news.id)).toEqual(news.original);
  });
  it("잘못된 업무 JSON은 물리 종료만 정산하고 초안을 만들지 않는다", async () => {
    const news = await fixtureNews(); await enqueue(news.id); responseMode = "invalid"; await reviewLlmAssist(context());
    expect(calls).toHaveLength(1); expect((await requests())[0].state).toBe("settled"); expect((await works(news.id))[0]).toMatchObject({ state: "human", attempts: 1 });
    expect(await drafts(news.id)).toHaveLength(0); expect(await snapshot(news.id)).toEqual(news.original);
  });
  it("전역 capacity disabled는 legacy 무계량 우회나 시도 소모를 만들지 않는다", async () => {
    const news = await fixtureNews(); await enqueue(news.id); await admin`UPDATE model_capacity_control SET mode='disabled' WHERE id=1`;
    await reviewLlmAssist(context()); expect(calls).toHaveLength(0); expect(await requests()).toHaveLength(0);
    expect((await works(news.id))[0]).toMatchObject({ state: "waiting_capacity", attempts: 0 });
    expect(await drafts(news.id)).toHaveLength(0); expect(await snapshot(news.id)).toEqual(news.original);
  });
  it("종료 불명인 같은 기사에 새 source revision을 넣어도 원격 점유를 우회하지 않는다", async () => {
    const news = await fixtureNews(); await enqueue(news.id); const abort = new AbortController();
    onCall = async () => { abort.abort(); await new Promise(resolve => setTimeout(resolve, 50)); };
    await reviewLlmAssist(context(abort.signal));
    expect(calls).toHaveLength(1); expect((await requests())[0].state).toBe("indeterminate");
    expect((await works(news.id))[0].state).toBe("indeterminate");
    onCall = null;
    await admin`UPDATE news_items SET decided_at=decided_at+interval '1 microsecond' WHERE id=${news.id}`;
    source = (await db.transaction(tx => lockNewsLocalizationSource(tx, news.id)))!;
    expect(await enqueue(news.id)).toMatchObject({ state: "queued", created: true });
    await expect(reviewLlmAssist(context())).resolves.toBeDefined();
    expect(calls).toHaveLength(1); expect((await requests()).filter(request => request.dispatched_at !== null)).toHaveLength(1);
    expect((await requests())[0].state).toBe("indeterminate"); expect(await drafts(news.id)).toHaveLength(0);
  });
});
