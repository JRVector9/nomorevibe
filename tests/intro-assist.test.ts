import { describe, expect, it } from "vitest";
import { ASSIST_POLICY_VERSION, ASSIST_SCHEMA_VERSION, assistHash, assistInputHash, validateAssistOutcome,
  type AssistInput, type AssistOutcome, type AssistSource } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION } from "@/lib/domain/llm-assist/prompts";
import { buildIntroAssistInput, buildIntroCorrectionMessages, introNamePlaceholder, introRecheckCandidate,
  introRecheckEligible, introRecheckSourceHash, validateIntroAssistInput, validateIntroCorrection,
  type IntroRecheckSnapshot } from "@/lib/domain/products/intro-assist";

const snapshot = (): IntroRecheckSnapshot => ({ product: { id: 1, slug: "margo", name: "Margonem item maker", url: "https://margo.example/",
  repoUrl: "https://github.com/acme/margo", repoLinkVersion: 1, updatedAt: "2026-10-23 01:02:03.123456", tagline: "Build items for World of Warcraft",
  taglineSource: "ai_page", description: "Build items for World of Warcraft", status: "seeded", source: "crawler", claimedAt: null,
  activeMaker: false, searchPageText: "Old incomplete page sample", searchReadme: "Old README excerpt" }, check: {
  updatedAt: "2026-10-23 01:02:03.234567", rowHash: "a".repeat(64), checkedTagline: "Build items for World of Warcraft",
  outcome: "needs_editor", errorCode: null, attempts: 2 } });
const source = (): AssistSource => ({ sourceId: "current-page", kind: "page", url: "https://margo.example/", observedAt: new Date().toISOString(),
  revision: "page-sha", text: "Create and edit items for the game Margonem.", completeness: "complete", httpStatus: 200 });
const factual = (): AssistOutcome => ({ schema_version: ASSIST_SCHEMA_VERSION, task: "intro", state: { factual_match: "explicit_mismatch",
  content_kind: "descriptive", author_protection: "server_operator", treatment: "rewrite_candidate" },
  evidence_quality: { status: "sufficient", limitations: ["none"] }, evidence: [{ source_id: "current-page",
    quote: "for the game Margonem", supports: ["/state/factual_match"] }],
  action: { proposal: "rewrite_candidate", reason_ko: "실제 대상 게임은 Margonem입니다.", missing_items: [] } });
const fixture = () => { const candidate = introRecheckCandidate(snapshot())!; const input = buildIntroAssistInput(candidate, [source()]);
  const outcome = factual(); return { candidate, input, outcome, correction: { schema_version: ASSIST_SCHEMA_VERSION, kind: "intro_correction",
    source_hash: introRecheckSourceHash(candidate), input_hash: assistInputHash(input), factual_outcome_hash: assistHash(outcome),
    corrected: "Create and edit items for Margonem", reason_ko: "근거에 나온 대상 게임을 보존했습니다.",
    evidence: [{ source_id: "current-page", quote: "Create and edit items for the game Margonem." }] } }; };

describe("needs_editor 명시 재진입", () => {
  it("성공 needs_editor를 기존 attempts·check revision 그대로 후보화하고 microsecond 변경을 구분한다", () => {
    const original = snapshot(), candidate = introRecheckCandidate(original)!;
    expect(candidate).toMatchObject({ policyVersion: ASSIST_POLICY_VERSION, promptVersion: ASSIST_PROMPT_VERSION, snapshot: { check: { attempts: 2 } } });
    const changed = { ...candidate, snapshot: { ...original, product: { ...original.product, updatedAt: "2026-10-23 01:02:03.123457" } } };
    expect(introRecheckSourceHash(changed)).not.toBe(introRecheckSourceHash(candidate));
    expect(original.check).toEqual(snapshot().check);
  });
  it("사람 편집·메이커 등장·성공 처리·소개 변경·실패 행은 재진입하지 않는다", () => {
    const current = snapshot();
    for (const changed of [
      { ...current, product: { ...current.product, taglineSource: "editor" as const } },
      { ...current, product: { ...current.product, activeMaker: true } },
      { ...current, product: { ...current.product, claimedAt: "2026-10-23 01:02:03.123456" } },
      { ...current, product: { ...current.product, tagline: "A changed introduction" } },
      { ...current, check: { ...current.check, outcome: "kept" } },
      { ...current, check: { ...current.check, errorCode: "timeout" } },
    ]) expect(introRecheckEligible(changed)).toBe(false);
  });
  it("저장 발췌문을 complete로 승격하지 않고 다른 제품 화면·오래된 화면을 받지 않는다", () => {
    const candidate = introRecheckCandidate(snapshot())!;
    expect(buildIntroAssistInput(candidate).sources.every(source => source.completeness === "truncated")).toBe(true);
    const input = buildIntroAssistInput(candidate, [{ ...source(), url: "https://other.example/" }]);
    expect(validateIntroAssistInput(candidate, input)).toBe(false);
    expect(validateIntroAssistInput(candidate, buildIntroAssistInput(candidate, [{ ...source(), observedAt: "2020-01-01T00:00:00Z" }]))).toBe(false);
    expect(validateIntroAssistInput(candidate, buildIntroAssistInput(candidate, [{ ...source(), kind: "readme", url: "https://github.com/acme/margo-copy" }]))).toBe(false);
  });
});

describe("사실 판정과 교정 후보 분리", () => {
  it("Qwen 사실 판정만으로는 교정문을 만들거나 제품 변경하지 않고 별도 입력에 묶는다", () => {
    const { candidate, input, outcome, correction } = fixture();
    expect(validateAssistOutcome(input, outcome).ok).toBe(true);
    const messages = buildIntroCorrectionMessages(candidate, input, outcome);
    expect(messages[1].content).toContain("intro_correction");
    expect(messages[1].content).toContain(assistHash(outcome));
    expect(messages[1].content).not.toContain("Old incomplete page sample");
    expect(validateIntroCorrection(candidate, input, outcome, correction)).toMatchObject({ ok: true, line: "Create and edit items for Margonem" });
    expect(validateIntroCorrection(candidate, input, outcome, outcome).ok).toBe(false);
  });
  it("source·input·사실결과 hash 및 인용이 바뀌면 교정 후보를 거절한다", () => {
    const { candidate, input, outcome, correction } = fixture();
    for (const changed of [{ ...correction, source_hash: "b".repeat(64) }, { ...correction, input_hash: "b".repeat(64) },
      { ...correction, factual_outcome_hash: "b".repeat(64) }, { ...correction, evidence: [{ source_id: "current-page", quote: "invented feature" }] },
      { ...correction, evidence: [{ source_id: "stored-page-excerpt", quote: "Old incomplete page sample" }] },
    ]) expect(validateIntroCorrection(candidate, input, outcome, changed).ok).toBe(false);
  });
  it("메이커 성능 주장 wrong을 중립화하지 않고 이름 placeholder만 별도 예외로 허용한다", () => {
    const current = snapshot(); current.product.taglineSource = "maker";
    current.product.tagline = "The fastest editor for every game"; current.check.checkedTagline = current.product.tagline;
    const candidate = introRecheckCandidate(current)!, input = buildIntroAssistInput(candidate, [source()]);
    const outcome = factual();
    if (outcome.task !== "intro") throw new Error();
    const protectedOutcome = { ...outcome, state: { ...outcome.state, author_protection: "server_maker_protected" as const,
      content_kind: "performance_or_value_claim" as const, factual_match: "unsupported_claim" as const } };
    expect(validateAssistOutcome(input, protectedOutcome).ok).toBe(false);
    expect(introNamePlaceholder(current)).toBe(false);
    current.product.tagline = current.product.name; current.check.checkedTagline = current.product.tagline;
    expect(introNamePlaceholder(current)).toBe(true);
    current.product.tagline = "Loading";
    expect(introNamePlaceholder(current)).toBe(false);
  });
  it("기존 decideIntro의 이름·짧은 후보 보류와 strict 추가필드 거부를 보존한다", () => {
    const { candidate, input, outcome, correction } = fixture();
    for (const changed of [{ ...correction, corrected: candidate.snapshot.product.name }, { ...correction, corrected: "Tool" },
      { ...correction, confidence: 1 }]) expect(validateIntroCorrection(candidate, input, outcome, changed).ok).toBe(false);
    const malformed = { ...input, context: { ...(input as Extract<AssistInput, { task: "intro" }>).context, author: "unknown" } } as AssistInput;
    expect(validateIntroAssistInput(candidate, malformed)).toBe(false);
  });
  it("증거가 막혔거나 부족하면 교정 stage를 열지 않는다", () => {
    const { candidate, outcome } = fixture(), partial = buildIntroAssistInput(candidate);
    expect(() => buildIntroCorrectionMessages(candidate, partial, outcome)).toThrow("intro_correction_not_permitted");
    const blocked = buildIntroAssistInput(candidate, [{ ...source(), completeness: "blocked" }]);
    expect(() => buildIntroCorrectionMessages(candidate, blocked, outcome)).toThrow("intro_correction_not_permitted");
  });
});
