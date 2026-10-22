import { describe, expect, it } from "vitest";
import { holdGate, holdGates } from "@/lib/crawl/product-audit-hold";
import { classifyAuditReason } from "@/lib/crawl/audit-reason-category";
import { DEFAULT_AUDIT_HOLD } from "@/lib/crawl/settings-schema";
import { THIN_PAGE_TEXT_CHARS, thinPageText } from "@/lib/crawl/second-opinion-rules";

/**
 * 감사 보류의 모델별 규칙(0112) — Qwen-v2 가 낸 감사 거절(남은 감사 모델 바꾸기 뒤)은 확신이 늘 0.95·1.00 이라 문턱으로 가를 수 없다.
 * 허용 갈래(빈 화면·회사 소개·남의 플랫폼·쇼핑몰)는 그대로 보류하되, 카탈로그·디렉터리 같은 거절은 갈래로 걸지 않는다(second-opinion-rules.ts).
 */
const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency';
const DIRECTORY = 'pageText: "Best AI tools" — a curated directory of other tools, not a product';
const LIST_OF = 'pageText: "Studio picks" — a marketing site that is a list of agencies';
const NPM = "This is the npm package page on someone else's platform";
const PLACEHOLDER = 'pageText is empty — the page shows only a loading spinner placeholder';
const none = { opinions: [] };
/** 다른 모델(grok)의 두 번째 의견 */
const grok = (decision: "approve" | "reject") => ({ opinions: [{ model: "grok-4.7", decision }] });

it("테스트 사유의 갈래 — 회사 소개·남의 플랫폼·(카탈로그 낱말이 든) 회사 소개·빈 화면", () => {
  expect([COMPANY, DIRECTORY, LIST_OF, NPM, PLACEHOLDER].map(classifyAuditReason)).toEqual(["company", "platform", "company", "platform", "placeholder"]);
});

describe("Qwen 이 감사한 거절", () => {
  const qwen = "qwen3.8-flash-next";
  // Qwen 이 감사한 거절은 확신이 0.90 이상일 때만 사람 없이 보류한다(QWEN_AUTO_MIN_CONFIDENCE) — 이 묶음의 거절은 0.97 이다
  const sure = { confidence: 0.97 };
  it("허용 갈래(회사 소개·빈 화면)는 보류한다", () => {
    expect(holdGate({ reason: COMPANY, ...none, model: qwen, ...sure }, DEFAULT_AUDIT_HOLD)).toBe(true);
    expect(holdGate({ reason: PLACEHOLDER, ...none, model: qwen, ...sure }, DEFAULT_AUDIT_HOLD)).toBe(true);
  });

  it("카탈로그·디렉터리 같은 거절(갈래 platform 이거나 directory·catalog·awesome·curated list·list of)은 갈래로 걸지 않는다", () => {
    expect(holdGate({ reason: DIRECTORY, ...none, model: qwen, ...sure }, DEFAULT_AUDIT_HOLD)).toBe(false);
    expect(holdGate({ reason: LIST_OF, ...none, model: qwen, ...sure }, DEFAULT_AUDIT_HOLD)).toBe(false);
    expect(holdGate({ reason: NPM, ...none, model: qwen, ...sure }, DEFAULT_AUDIT_HOLD)).toBe(false);
  });

  it("다른 모델이 따로 거절했으면 갈래와 상관없는 둘째 문으로 보류한다 — 감사 모델의 카탈로그 예외와 상관없다", () => {
    expect(holdGates({ reason: DIRECTORY, ...grok("reject"), model: qwen, ...sure }, DEFAULT_AUDIT_HOLD))
      .toEqual({ byCategory: false, bySecondOpinion: true });
    expect(holdGate({ reason: DIRECTORY, ...grok("reject"), model: qwen, ...sure },
      { ...DEFAULT_AUDIT_HOLD, secondOpinionReject: false })).toBe(false);
    // Qwen 의 두 번째 거절도 카탈로그 같은 항목에서는 세지 않는다(gpt-oss 가 감사한 항목 — 같은 모델의 의견은 묻지 않는다)
    expect(holdGates({ reason: LIST_OF, opinions: [{ model: qwen, decision: "reject" }], model: "[MLX] gpt-oss-120b" },
      { ...DEFAULT_AUDIT_HOLD, categories: [] })).toEqual({ byCategory: false, bySecondOpinion: false });
  });
});

describe("확신 문턱(0.90) — 사람 없이 정하는 Qwen 의 답", () => {
  const qwen = "qwen3.8-flash-next";
  it("Qwen 이 감사한 거절은 확신이 없거나 0.90 아래면 보류하지 않는다(목록에 두고 사람이 본다) — 다른 모델의 거절이 있어도", () => {
    for (const confidence of [undefined, null, 0.5, 0.89]) {
      expect(holdGates({ reason: COMPANY, ...grok("reject"), model: qwen, confidence }, DEFAULT_AUDIT_HOLD), String(confidence))
        .toEqual({ byCategory: false, bySecondOpinion: false });
    }
    expect(holdGate({ reason: COMPANY, ...none, model: qwen, confidence: 0.9 }, DEFAULT_AUDIT_HOLD)).toBe(true);
    // gpt-oss 감사는 이 문턱을 보지 않는다 — SQL 의 확신 문턱(auditHold.minConfidence)만 본다
    expect(holdGate({ reason: COMPANY, ...none, model: "[MLX] gpt-oss-120b", confidence: 0.5 }, DEFAULT_AUDIT_HOLD)).toBe(true);
  });

  const auto = (decision: "approve" | "reject", confidence: number | null) =>
    ({ opinions: [{ model: qwen, decision, source: "qwen-v2-auto", confidence }] });
  it("Qwen-v2 자동 의견의 거절은 그 단계가 켜져 있고 확신이 0.90 이상일 때만 보류의 까닭이다 — grok 의 거절은 늘 센다", () => {
    const gpt = { reason: COMPANY, model: "[MLX] gpt-oss-120b", confidence: 0.97 };
    const noCategory = { ...DEFAULT_AUDIT_HOLD, categories: [] };
    expect(holdGates({ ...gpt, ...auto("reject", 0.97) }, noCategory)).toEqual({ byCategory: false, bySecondOpinion: false });
    expect(holdGates({ ...gpt, ...auto("reject", 0.97) }, noCategory, { autoOpinions: true })).toEqual({ byCategory: false, bySecondOpinion: true });
    expect(holdGates({ ...gpt, ...auto("reject", 0.8) }, noCategory, { autoOpinions: true })).toEqual({ byCategory: false, bySecondOpinion: false });
    expect(holdGates({ ...gpt, ...auto("reject", null) }, noCategory, { autoOpinions: true })).toEqual({ byCategory: false, bySecondOpinion: false });
    expect(holdGates({ ...gpt, ...grok("reject") }, noCategory)).toEqual({ byCategory: false, bySecondOpinion: true });
  });

  it("Qwen-v2 자동 의견의 승인은 확신이 0.90 이상일 때만 갈래 보류를 푼다", () => {
    const gpt = { reason: COMPANY, model: "[MLX] gpt-oss-120b", confidence: 0.97 };
    expect(holdGate({ ...gpt, ...auto("approve", 0.95) }, DEFAULT_AUDIT_HOLD)).toBe(false);
    expect(holdGate({ ...gpt, ...auto("approve", 0.8) }, DEFAULT_AUDIT_HOLD)).toBe(true);
    expect(holdGate({ ...gpt, ...auto("approve", null) }, DEFAULT_AUDIT_HOLD)).toBe(true);
  });
});

describe("gpt-oss·옛 호출부는 그대로", () => {
  it("gpt-oss 가 감사한 카탈로그 거절은 지금처럼 남의 플랫폼 갈래로 보류한다", () => {
    expect(holdGate({ reason: DIRECTORY, ...none, model: "[MLX] gpt-oss-120b" }, DEFAULT_AUDIT_HOLD)).toBe(true);
    expect(holdGate({ reason: LIST_OF, ...none, model: "[MLX] gpt-oss-120b" }, DEFAULT_AUDIT_HOLD)).toBe(true);
  });

  it("모델을 넘기지 않는 호출부(두 번째 의견 옮겨 적기)는 모델별 규칙을 보지 않는다", () => {
    expect(holdGate({ reason: DIRECTORY, ...none }, DEFAULT_AUDIT_HOLD)).toBe(true);
    expect(holdGate({ reason: COMPANY, ...grok("approve") }, DEFAULT_AUDIT_HOLD)).toBe(false);
  });
});

describe("글만 본 m1 — 글이 적은 페이지·엇갈림(2026-10-22 사용자 결정)", () => {
  const qwen = "qwen3.8-flash-next";
  const gpt = { reason: COMPANY, model: "[MLX] gpt-oss-120b", confidence: 0.97 };
  const noCategory = { ...DEFAULT_AUDIT_HOLD, categories: [] };
  const m1 = (decision: "approve" | "reject", confidence = 0.97) => ({ model: qwen, decision, source: "qwen-v2-auto", confidence });
  const on = { autoOpinions: true };

  it("글이 적은 항목에서는 m1 의 거절이 보류의 까닭이 아니다(쓸기가 숨기지 않는다) — grok·화면 재판정의 거절은 그대로 센다", () => {
    expect(holdGates({ ...gpt, opinions: [m1("reject")], thinText: true }, noCategory, on)).toEqual({ byCategory: false, bySecondOpinion: false });
    expect(holdGates({ ...gpt, opinions: [m1("reject")], thinText: false }, noCategory, on)).toEqual({ byCategory: false, bySecondOpinion: true });
    expect(holdGates({ ...gpt, opinions: [m1("reject"), { model: "grok-4.7", decision: "reject" }], thinText: true }, noCategory, on))
      .toEqual({ byCategory: false, bySecondOpinion: true });
    const vision = { model: "qwen3.8-flash-next+vision", decision: "reject", source: "qwen-vision-m1", confidence: 0.95 };
    expect(holdGates({ ...gpt, opinions: [vision], thinText: true }, noCategory, on)).toEqual({ byCategory: false, bySecondOpinion: true });
  });

  it("글이 적은 항목에서는 m1 의 승인도 세지 않는다 — 갈래 보류를 풀지 않고 화면 판정을 기다린다", () => {
    expect(holdGate({ ...gpt, opinions: [m1("approve")], thinText: true }, DEFAULT_AUDIT_HOLD, on)).toBe(true);
    expect(holdGate({ ...gpt, opinions: [m1("approve")], thinText: false }, DEFAULT_AUDIT_HOLD, on)).toBe(false);
    // 화면을 본 승인(확신 하한 이상)은 그대로 갈래 보류를 막는다
    const vision = { model: "qwen3.8-flash-next+vision", decision: "approve", source: "qwen-vision-auto", confidence: 0.95 };
    expect(holdGate({ ...gpt, opinions: [m1("reject"), vision], thinText: true }, DEFAULT_AUDIT_HOLD, on)).toBe(false);
  });

  it("다른 모델이 승인한 항목에서는 m1 의 거절을 세지 않는다(엇갈림 — 사람이 본다). grok 의 거절은 그대로 센다", () => {
    const grokApprove = { model: "grok-4.7", decision: "approve" };
    expect(holdGates({ ...gpt, opinions: [m1("reject"), grokApprove] }, noCategory, on)).toEqual({ byCategory: false, bySecondOpinion: false });
    // 확신이 낮은 승인이라도 다른 모델의 승인이면 엇갈림이다
    const weakVision = { model: "qwen3.8-flash-next+vision", decision: "approve", source: "qwen-vision-m1", confidence: 0.5 };
    expect(holdGates({ ...gpt, opinions: [m1("reject"), weakVision] }, noCategory, on)).toEqual({ byCategory: false, bySecondOpinion: false });
    // 같은 모델(게이트웨이 자리 표시만 다름)의 승인은 다른 모델이 아니다
    expect(holdGates({ ...gpt, opinions: [m1("reject"), { model: `[gpu3090] ${qwen}`, decision: "approve" }] }, noCategory, on))
      .toEqual({ byCategory: false, bySecondOpinion: true });
    expect(holdGates({ ...gpt, opinions: [{ model: "grok-4.7", decision: "reject" }, { model: "gemini", decision: "approve" }] }, noCategory, on))
      .toEqual({ byCategory: false, bySecondOpinion: true });
  });
});

describe("thinPageText — 수집 본문이 적은가(감사 입력과 같은 자르기)", () => {
  it("300자 아래·없음은 적다, 앞뒤 공백은 세지 않고 글자(코드 포인트)로 센다", () => {
    expect(THIN_PAGE_TEXT_CHARS).toBe(300);
    expect(thinPageText(null)).toBe(true);
    expect(thinPageText("")).toBe(true);
    expect(thinPageText("a".repeat(299))).toBe(true);
    expect(thinPageText("a".repeat(300))).toBe(false);
    expect(thinPageText(`   ${"a".repeat(299)}   `)).toBe(true);
    expect(thinPageText("가".repeat(300))).toBe(false);
    expect(thinPageText("😀".repeat(299))).toBe(true);
  });
});
