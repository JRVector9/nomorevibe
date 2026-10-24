import { describe, expect, it } from "vitest";
import { ASSIST_SCHEMA_VERSION, validateAssistOutcome, type AssistInput } from "@/lib/domain/llm-assist/contracts";
import { ASSIST_PROMPT_VERSION, buildAssistMessages } from "@/lib/domain/llm-assist/prompts";

function input(text: string, httpStatus: number): AssistInput {
  return { schemaVersion: ASSIST_SCHEMA_VERSION, task: "uptime", subject: { type: "product", id: 1, revision: "product-v1" },
    policyVersion: "policy-v1", promptVersion: ASSIST_PROMPT_VERSION,
    sources: [{ sourceId: "current-page", kind: "page", url: "https://example.com", observedAt: "2026-10-24T14:00:00Z",
      revision: "page-v1", text, httpStatus, completeness: "complete" }],
    context: { requestedUrl: "https://example.com", finalUrl: "https://example.com", failureCount: 10,
      requiredFailures: 10, administratorReleased: false } };
}
function delist(quote: string, soft404 = false) {
  return { schema_version: ASSIST_SCHEMA_VERSION, task: "uptime", evidence_quality: { status: "sufficient", limitations: ["none"] },
    evidence: [{ source_id: "current-page", quote, supports: ["/state/page_state"] }],
    state: { page_state: soft404 ? "soft_404" : "closed", finding: soft404 ? "missing_requested_resource" : "explicit_shutdown" },
    action: { proposal: "delist_candidate", reason_ko: "요청 제품을 더 이상 이용할 수 없습니다.", missing_items: [] } };
}
const notices = [
  { status: 402, body: "Payment required DEPLOYMENT_DISABLED", trace: "icn1::example-request-1" },
  { status: 503, body: "The deployment is currently unavailable DEPLOYMENT_PAUSED", trace: "icn1::example-request-2" },
] as const;

describe("uptime 호스팅 중단 안내의 자동 내림 기권", () => {
  it.each(notices)("HTTP $status 호스팅 안내만으로 영구 종료를 제안하면 거절한다", ({ status, body, trace }) => {
    for (const text of [body, `${body} ${trace}`]) {
      expect(validateAssistOutcome(input(text, status), delist(body))).toEqual({ ok: false, error: "uptime_hosting_notice_requires_review" });
    }
  });
  it.each(notices)("HTTP $status 호스팅 안내의 추가 근거·사람 확인은 유지한다", ({ status, body, trace }) => {
    for (const proposal of ["collect_evidence", "human_review"]) {
      const outcome = { ...delist(body), evidence_quality: { status: "partial", limitations: ["other"] },
        state: { page_state: "unclear", finding: "temporary_maintenance" },
        action: { proposal, reason_ko: "호스팅 중단 안내만 있어 현재 제품 상태를 확인해야 합니다.", missing_items: ["제품의 현재 상태"] } };
      expect(validateAssistOutcome(input(`${body} ${trace}`, status), outcome).ok).toBe(true);
    }
  });
  it.each([200, 402, 503])("HTTP %s라도 명시적 영구 종료·요청 경로 없음은 기존대로 판단한다", status => {
    const closed = "We permanently closed the entire service.";
    expect(validateAssistOutcome(input(closed, status), delist(closed)).ok).toBe(true);
    const missing = "404 - This requested project does not exist.";
    expect(validateAssistOutcome(input(missing, status), delist(missing, true)).ok).toBe(true);
  });
  it.each(notices)("HTTP $status 본문 안의 호스팅 오류 설명을 안내 화면 전체로 오해하지 않는다", ({ status, body }) => {
    const closed = "We permanently closed the entire service.";
    expect(validateAssistOutcome(input(`${body}. ${closed}`, status), delist(closed)).ok).toBe(true);
    expect(validateAssistOutcome(input(`${closed} Our old host showed ${body}.`, status), delist(closed)).ok).toBe(true);
  });
  it("기존의 원문 인용 일치 검증은 그대로 유지한다", () => {
    expect(validateAssistOutcome(input("We permanently closed the entire service.", 200), delist("we permanently closed")))
      .toEqual({ ok: false, error: "invalid_evidence_quote" });
  });
  it("uptime 지침이 결제·배포 중단 안내를 영구 종료와 구분한다", () => {
    const message = buildAssistMessages(input(notices[0].body, notices[0].status))[1].content;
    expect(message).toContain("DEPLOYMENT_DISABLED");
    expect(message).toContain("DEPLOYMENT_PAUSED");
    expect(message).toContain("호스팅 결제·배포 중단");
  });
});
