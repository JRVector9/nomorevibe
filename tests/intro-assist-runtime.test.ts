import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, type AssistOutcome, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { buildIntroAssistInput, introRecheckCandidate, introRecheckSourceHash, type IntroRecheckSnapshot } from "@/lib/domain/products/intro-assist";
import { buildIntroCorrectionModelPlan, collectIntroRecheckInput, introCorrectionCapacityInput, runIntroCorrectionStage } from "@/lib/domain/products/intro-assist-runtime";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import type { CappedFetchResult } from "@/lib/net/fetch";

const snapshot = (): IntroRecheckSnapshot => ({ product: { id: 1, slug: "margo", name: "Margonem item maker", url: "https://margo.example/",
  repoUrl: "https://github.com/acme/margo", repoLinkVersion: 1, updatedAt: "2026-10-23 01:02:03.123456", tagline: "Build items for World of Warcraft",
  taglineSource: "ai_page", description: "Build items for World of Warcraft", status: "seeded", source: "crawler", claimedAt: null,
  activeMaker: false, searchPageText: "Old incomplete page", searchReadme: "Old README excerpt" }, check: {
  updatedAt: "2026-10-23 01:02:03.234567", rowHash: "a".repeat(64), checkedTagline: "Build items for World of Warcraft",
  outcome: "needs_editor", errorCode: null, attempts: 2 } });
const source = (): AssistSource => ({ sourceId: "current-page", kind: "page", url: "https://margo.example/", observedAt: new Date().toISOString(),
  revision: "page-sha", text: "Create and edit items for the game Margonem.", completeness: "complete", httpStatus: 200 });
const factual = (): AssistOutcome => ({ schema_version: ASSIST_SCHEMA_VERSION, task: "intro", state: { factual_match: "explicit_mismatch",
  content_kind: "descriptive", author_protection: "server_operator", treatment: "rewrite_candidate" },
  evidence_quality: { status: "sufficient", limitations: ["none"] }, evidence: [{ source_id: "current-page", quote: "for the game Margonem",
    supports: ["/state/factual_match"] }], action: { proposal: "rewrite_candidate", reason_ko: "실제 대상 게임은 Margonem입니다.", missing_items: [] } });
const fixture = () => { const candidate = introRecheckCandidate(snapshot())!, input = buildIntroAssistInput(candidate, [source()]), outcome = factual();
  return { candidate, input, outcome, factualResultId: randomUUID(), correction: { schema_version: ASSIST_SCHEMA_VERSION, kind: "intro_correction",
    source_hash: introRecheckSourceHash(candidate), input_hash: assistInputHash(input), factual_outcome_hash: assistHash(outcome),
    corrected: "Create and edit items for Margonem", reason_ko: "대상 게임을 원문대로 보존했습니다.", evidence: [{ source_id: "current-page", quote: "for the game Margonem" }] } }; };
const contract: LocalModelServingContract = { version: 1, protocol: "local-openai-chat-v1", backendId: "fixture-m1-qwen", provider: "local-direct",
  physicalGroup: "m1", endpoint: "http://127.0.0.1:8080/v1/chat/completions", model: "qwen3.8-flash-next", responseModel: "qwen3.8-flash-next",
  modelFamily: "qwen3.8-flash-next", deploymentRevision: "fixture-q4", contextWindowTokens: 64000, totalTokenBound: 64000,
  maxOutputTokens: 2048, maxInputBytes: 100000, capabilities: { vision: true, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } };
const fetched = (url: string, body = "Create and edit items for the game Margonem."): Extract<CappedFetchResult, { ok: true }> =>
  ({ ok: true, status: 200, finalUrl: url, headers: new Headers(), body: Buffer.from(body) });
const response = (body: unknown, finish = "stop", model = contract.responseModel) => new Response(JSON.stringify({ model,
  choices: [{ finish_reason: finish, message: { content: JSON.stringify(body) } }] }));

describe("소개 보강 근거의 실제 완전성", () => {
  it("현재 페이지와 같은 공개 저장소 README를 보존하며 저장 발췌를 승격하지 않는다", async () => {
    const { candidate } = fixture(), fetch = vi.fn(async (url: string) => fetched(url));
    const input = await collectIntroRecheckInput(candidate, undefined, { fetch, env: {} });
    expect(input.subject.revision).toBe("2026-10-23 01:02:03.123456");
    expect(input.sources.filter(s => s.sourceId.startsWith("stored-")).every(s => s.completeness === "truncated")).toBe(true);
    expect(input.sources.find(s => s.sourceId === "current-readme")).toMatchObject({ completeness: "complete", url: "https://raw.githubusercontent.com/acme/margo/HEAD/README.md" });
    expect(fetch.mock.calls.map(call => call[0])).toEqual([candidate.snapshot.product.url, "https://raw.githubusercontent.com/acme/margo/HEAD/README.md"]);
  });
  it("다른 제품 redirect·본문 상한·readme redirect를 complete로 처리하지 않는다", async () => {
    const { candidate } = fixture(), fetch = vi.fn(async (): Promise<CappedFetchResult> => ({ ...fetched("https://elsewhere.example/", "a".repeat(33_000)), truncated: true }));
    const input = await collectIntroRecheckInput(candidate, undefined, { fetch, env: {} });
    expect(input.sources.filter(s => s.sourceId.startsWith("current-")).every(s => s.completeness === "truncated")).toBe(true);
    expect(input.sources.find(s => s.sourceId === "current-page")?.url).toBe("https://elsewhere.example/");
  });
  it("얇은 페이지는 설정된 화면 서버로 보강하고 렌더러의 잘림·다른URL도 보류한다", async () => {
    const { candidate } = fixture(), fetch = vi.fn(async (url: string): Promise<CappedFetchResult> => url.includes("raw.githubusercontent")
      ? { ok: false, reason: "http", status: 404 } : fetched(url, "<p>Loading</p>"));
    const render = vi.fn(async () => ({ ok: true as const, finalUrl: candidate.snapshot.product.url, status: 200, text: source().text,
      textLength: source().text.length, jpeg: Buffer.from([0xff, 0xd8, 0xff]), renderMs: 1, egress: { requests: 1, bytes: 100, blocked: 0 } }));
    const options = { fetch, render, env: { SCREEN_RENDER_URL: "http://100.64.0.2:8791", SCREEN_RENDER_TOKEN: "s".repeat(32) } };
    expect((await collectIntroRecheckInput(candidate, undefined, options)).sources.find(s => s.kind === "rendered_page")?.completeness).toBe("complete");
    render.mockResolvedValueOnce({ ...(await render()), finalUrl: "https://elsewhere.example/", textLength: 6001 });
    expect((await collectIntroRecheckInput(candidate, undefined, options)).sources.find(s => s.kind === "rendered_page")?.completeness).toBe("truncated");
  });
  it("이미 취소된 수집은 외부 요청을 열지 않는다", async () => {
    const { candidate } = fixture(), fetch = vi.fn(async (url: string) => fetched(url));
    const input = await collectIntroRecheckInput(candidate, AbortSignal.abort(), { fetch, env: {} });
    expect(fetch).not.toHaveBeenCalled();
    expect(input.sources.filter(s => s.sourceId.startsWith("current-")).every(s => s.completeness === "missing")).toBe(true);
  });
});

describe("별도 계량 교정 호출", () => {
  it("사실 입력을 유지하고 별도 source/input/factual/prompt 지문의 요청을 만든다", () => {
    const { candidate, input, outcome, factualResultId } = fixture(), plan = buildIntroCorrectionModelPlan(candidate, input, factualResultId, outcome, contract);
    expect(plan.capacityInput.inputHash).not.toBe(assistInputHash(input));
    expect(plan.capacityInput.input).toEqual(input);
    expect(plan.capacityInput.sourceRevisionHash).toBe(introRecheckSourceHash(candidate));
    expect(JSON.parse(plan.wire)).toMatchObject({ stream: false, max_tokens: 2048, chat_template_kwargs: { enable_thinking: false },
      response_format: { json_schema: { name: "intro_correction", strict: true } } });
    const changed = { ...candidate, snapshot: { ...candidate.snapshot, product: { ...candidate.snapshot.product, updatedAt: "2026-10-23 01:02:03.123457" } } };
    const changedInput = buildIntroAssistInput(changed, [source()]);
    expect(introCorrectionCapacityInput(changed, changedInput, factualResultId, outcome).inputHash).not.toBe(plan.capacityInput.inputHash);
  });
  it("정상 인용 교정만 별도 request/response/contract 기록 후보로 반환한다", async () => {
    const { candidate, input, outcome, factualResultId, correction } = fixture(), workId = randomUUID(), capacityRequestId = randomUUID();
    const body = response(correction), raw = await body.clone().text(), execute = vi.fn(async () => ({ capacityRequestId, response: body }));
    const result = await runIntroCorrectionStage({ candidate, input, factual: outcome, factualResultId, workId, contract }, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, record: { workId, capacityRequestId, factualResultId,
      responseHash: createHash("sha256").update(raw).digest("hex"), backendId: contract.backendId } });
    if (result.ok) expect(result.record.correction.corrected).toBe(correction.corrected);
  });
  it("잘린 생성·모델 불일치·가짜 인용·지문변경은 교정 후보를 반환하지 않는다", async () => {
    const { candidate, input, outcome, factualResultId, correction } = fixture();
    const args = { candidate, input, factual: outcome, factualResultId, workId: randomUUID(), contract };
    for (const body of [response(correction, "length"), response(correction, "stop", "other-model"),
      response({ ...correction, evidence: [{ source_id: "current-page", quote: "invented" }] }), response({ ...correction, input_hash: "a".repeat(64) })]) {
      expect((await runIntroCorrectionStage(args, async () => ({ capacityRequestId: randomUUID(), response: body }))).ok).toBe(false);
    }
  });
  it("근거 부족·GPT-OSS 계약은 실행 전에 닫고 용량 대기는 원래 의미로 전파한다", async () => {
    const { candidate, input, outcome, factualResultId } = fixture(), execute = vi.fn(async () => ({ capacityRequestId: randomUUID(), response: response({}) }));
    const args = { candidate, input, factual: outcome, factualResultId, workId: randomUUID(), contract };
    await expect(runIntroCorrectionStage({ ...args, input: buildIntroAssistInput(candidate) }, execute)).rejects.toThrow("intro_correction_not_permitted");
    await expect(runIntroCorrectionStage({ ...args, contract: { ...contract, modelFamily: "gpt-oss-120b" } }, execute)).rejects.toThrow("intro_correction_qwen_contract_required");
    expect(execute).not.toHaveBeenCalled();
    const capacity = new ModelCapacityDeferredError("capacity");
    await expect(runIntroCorrectionStage(args, async () => { throw capacity; })).rejects.toBe(capacity);
  });
});
