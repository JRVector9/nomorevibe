import { describe, expect, it } from "vitest";
import { adminRequestToken, assertAdminRequestCsrf } from "@/lib/operations/admin-requests-csrf";
import { contactInput, contactUpdateInput, parseAdminRequest, replyReviewInput } from "@/lib/operations/admin-requests-contract";

const admin = { login: "operator", exp: 20000, method: "github" as const };
const secret = "a-test-secret-with-more-than-32-characters";
const base = { scope: "contact-requests" as const, admin, secret, origin: "https://admin.example", configuredOrigin: "https://admin.example",
  token: adminRequestToken("contact-requests", admin, secret), expiresAt: admin.exp, local: false, now: 10000 };
it("서명은 로그인·만료·용도에 묶는다", () => {
  expect(() => assertAdminRequestCsrf(base)).not.toThrow();
  for (const change of [{ scope: "maker-replies" as const }, { admin: { ...admin, login: "other" } }, { origin: null }, { origin: "https://evil.example" },
    { token: "a".repeat(64) }, { secret: null }, { configuredOrigin: null }, { token: "x" }, { expiresAt: 21000 }, { now: admin.exp }]) {
    expect(() => assertAdminRequestCsrf({ ...base, ...change })).toThrow("forbidden");
  }
});
it("로컬 세션도 12시간 이내의 유효한 토큰만 받는다", () => {
  const localAdmin = { ...admin, exp: 12000 };
  expect(() => assertAdminRequestCsrf({ ...base, local: true, expiresAt: 12000, token: adminRequestToken("contact-requests", localAdmin, secret) })).not.toThrow();
  expect(() => assertAdminRequestCsrf({ ...base, local: true, expiresAt: 10000 + 12 * 3600 + 1 })).toThrow();
});
describe("관리자 입력을 서버에서 다시 검사", () => {
  const contact = { senderEmail: "person@example.com", subject: "  질문  ", body: "  문의 본문  ", receivedAt: "2026-10-22T10:00:00.000Z" };
  it("문의는 이메일·본문·수신시각만 받으며 사용자 임의 상태/처리자 필드를 거절한다", () => {
    expect(parseAdminRequest(contactInput, contact)).toMatchObject({ subject: "질문", body: "문의 본문", receivedAt: new Date(contact.receivedAt) });
    for (const value of [{ ...contact, senderEmail: "bad" }, { ...contact, status: "resolved" }, { ...contact, subject: " " },
      { ...contact, body: "x".repeat(10001) }, { ...contact, receivedAt: "yesterday" }]) expect(() => parseAdminRequest(contactInput, value)).toThrow("invalid");
  });
  it("수정과 검수에는 양수 버전과 지정한 상태만 받는다", () => {
    const id = "5dd0850a-d980-4d0c-aa5b-851a45f2ddc0";
    expect(() => parseAdminRequest(contactUpdateInput, { id, version: 1, status: "resolved", handlingNote: "외부 메일함에서 답장 완료" })).not.toThrow();
    expect(() => parseAdminRequest(contactUpdateInput, { id, version: 0, status: "resolved", handlingNote: "기록" })).toThrow();
    expect(() => parseAdminRequest(replyReviewInput, { id, version: 1, expectedState: "held", decision: "accepted" })).not.toThrow();
    expect(() => parseAdminRequest(replyReviewInput, { id, version: 1, expectedState: "accepted", decision: "accepted" })).toThrow();
  });
});
