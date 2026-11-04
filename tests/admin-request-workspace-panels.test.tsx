import React from "react";
import { createHmac } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";

const fake = vi.hoisted(() => ({ contacts: vi.fn(), feedback: vi.fn(), replies: vi.fn(), reactions: vi.fn(), contactForm: vi.fn(), replyForm: vi.fn(), feedbackForm: vi.fn(), reactionForm: vi.fn() }));
vi.mock("@/lib/operations/contact-requests", () => ({ contactRequestQueue: fake.contacts }));
vi.mock("@/lib/domain/feedback/repository", () => ({ feedbackAdminQueue: fake.feedback }));
vi.mock("@/lib/operations/maker-reply-review", () => ({ makerReplyQueue: fake.replies }));
vi.mock("@/lib/domain/reactions/review", () => ({ heldReactionComments: fake.reactions }));
vi.mock("@/lib/operations/admin-request-workspace", () => ({ readRequestSection: async (_key: string, load: () => Promise<unknown>) => {
  try { return { ok: true, data: await load() }; } catch { return { ok: false }; }
} }));
vi.mock("@/app/(operator)/admin/requests/WorkspaceParts", () => ({ ReadUnavailable: ({ title }: { title: string }) => <p>{title} 확인 불가 · 0건이 아닙니다</p> }));
vi.mock("@/components/product-detail/FeedbackList", () => ({ FeedbackItem: ({ feedback }: { feedback: { body: string } }) => <p>{feedback.body}</p> }));
vi.mock("@/app/(operator)/admin/requests/RequestForms", () => ({ ContactCreateForm: () => null, ContactUpdateForm: fake.contactForm, MakerReplyReviewForm: fake.replyForm }));
vi.mock("@/app/(operator)/admin/feedback/FeedbackReviewForm", () => ({ FeedbackReviewForm: fake.feedbackForm }));
vi.mock("@/app/(operator)/admin/reactions/ReactionReviewForm", () => ({ ReactionReviewForm: fake.reactionForm }));
const { ContactsPanel } = await import("@/app/(operator)/admin/requests/ContactsPanel");
const { PostsPanel } = await import("@/app/(operator)/admin/requests/PostsPanel");
const admin = { login: "operator", exp: 5000 }, secret = "test-session-secret", now = new Date("2026-11-04T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  for (const form of [fake.contactForm, fake.replyForm, fake.feedbackForm, fake.reactionForm]) form.mockImplementation(() => null);
  fake.contacts.mockResolvedValue({ count: 0, items: [], nextOffset: null });
  fake.feedback.mockResolvedValue({ count: 0, items: [], nextCursor: null });
  fake.replies.mockResolvedValue({ count: 0, items: [], nextOffset: null });
  fake.reactions.mockResolvedValue({ count: 0, items: [] });
});
it("문의 원본 판과 기존 세션 서명을 보존하며 다음 페이지에 탭 필터를 전달한다", async () => {
  fake.contacts.mockResolvedValue({ count: 30, nextOffset: 25, items: [{ id: "contact-id", version: 7, status: "waiting", subject: "원본 문의", senderEmail: "person@example.com", body: "실제 읽은 본문", receivedAt: now, updatedAt: now, createdBy: "op", updatedBy: "op", handlingNote: "기존 메모" }] });
  const html = renderToStaticMarkup(await ContactsPanel({ params: { state: "waiting", offset: "0" }, admin, secret }));
  expect(fake.contacts).toHaveBeenCalledWith({ state: "waiting", offset: 0 });
  expect(fake.contactForm.mock.calls[0][0]).toMatchObject({ id: "contact-id", version: 7, status: "waiting", handlingNote: "기존 메모", expiresAt: 5000, csrfToken: adminRequestToken("contact-requests", admin, secret) });
  expect(html).toContain('tab=contact&amp;state=waiting&amp;offset=25'); expect(html).toContain("person@example.com");
});
it("문의 읽기 실패가 열린 문의 0건이나 빈 목록으로 보이지 않는다", async () => {
  fake.contacts.mockRejectedValue(new Error("offline"));
  const html = renderToStaticMarkup(await ContactsPanel({ params: {}, admin, secret }));
  expect(html).toContain("확인 불가 · 0건이 아닙니다"); expect(html).not.toContain("조건에 맞는 문의가 없습니다"); expect(html).not.toContain("문의 0건");
});
it("피드백 필터와 원래 feedback-admin 서명을 유지하고 다른 검수 원본은 읽지 않는다", async () => {
  fake.feedback.mockResolvedValue({ count: 2, nextCursor: "cursor-next", items: [{ id: "feedback-id", slug: "product", productName: "원본 제품", reviewState: "accepted", body: "원본 글", createdAt: now.toISOString() }] });
  const html = renderToStaticMarkup(await PostsPanel({ params: { kind: "feedback", state: "accepted", q: " 찾기 ", cursor: "current" }, admin, secret }));
  expect(fake.feedback).toHaveBeenCalledWith({ state: "accepted", q: "찾기", cursor: "current" });
  expect(fake.feedbackForm.mock.calls[0][0]).toMatchObject({ id: "feedback-id", reviewState: "accepted", expiresAt: 5000, csrfToken: createHmac("sha256", secret).update("feedback-admin:operator:5000").digest("hex") });
  expect(fake.replies).not.toHaveBeenCalled(); expect(fake.reactions).not.toHaveBeenCalled();
  expect(html).toContain("cursor=cursor-next"); expect(html).toContain("공개 복원은 GitHub에 다시 보내지 않습니다");
});
it("메이커 답장 검수에 원문·원본 판·기존 maker-replies 서명을 전달한다", async () => {
  fake.replies.mockResolvedValue({ count: 1, nextOffset: null, items: [{ reply: { id: "reply-id", reviewVersion: 9, body: "원본 답장", reviewState: "held", updatedAt: now }, slug: "product", productName: "원본 제품", authorName: "메이커", targetBody: "대상 원문" }] });
  const html = renderToStaticMarkup(await PostsPanel({ params: { kind: "replies", state: "all", offset: "999999" }, admin, secret }));
  expect(fake.replies).toHaveBeenCalledWith({ state: "all", offset: 100000 });
  expect(html).toContain("대상 원문"); expect(html).toContain("원본 답장");
  expect(fake.replyForm.mock.calls[0][0]).toMatchObject({ id: "reply-id", version: 9, reviewState: "held", csrfToken: adminRequestToken("maker-replies", admin, secret) });
});
it("써봤어요 검수에 읽은 한 줄 자체를 전달하며 전체 공개 이력을 지어내지 않는다", async () => {
  fake.reactions.mockResolvedValue({ count: 1, items: [{ id: "reaction-id", slug: "product", productName: "원본 제품", comment: "읽은 원문", reason: "link", signedIn: false, updatedAt: now.toISOString() }] });
  const html = renderToStaticMarkup(await PostsPanel({ params: { kind: "reactions" }, admin, secret }));
  expect(fake.reactionForm.mock.calls[0][0]).toMatchObject({ id: "reaction-id", comment: "읽은 원문", expiresAt: 5000 });
  expect(html).toContain("자동 검사가 보류한 한 줄만 표시"); expect(html).not.toContain('name="state"');
  expect(fake.feedback).not.toHaveBeenCalled(); expect(fake.replies).not.toHaveBeenCalled();
});
