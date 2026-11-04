import { createHmac } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { adminRequestToken } from "@/lib/operations/admin-requests-csrf";
import type { WorkspaceRequest } from "@/lib/operations/admin-request-workspace";
const fake = vi.hoisted(() => ({ read: vi.fn(), contact: vi.fn(), feedback: vi.fn(), reply: vi.fn(), reaction: vi.fn(), takedown: vi.fn(), intro: vi.fn() }));
vi.mock("@/lib/operations/admin-request-workspace", () => ({ readRequestWorkspaceQueues: fake.read }));
vi.mock("@/app/(operator)/admin/requests/RequestForms", () => ({ ContactUpdateForm: fake.contact, MakerReplyReviewForm: fake.reply }));
vi.mock("@/app/(operator)/admin/feedback/FeedbackReviewForm", () => ({ FeedbackReviewForm: fake.feedback }));
vi.mock("@/app/(operator)/admin/reactions/ReactionReviewForm", () => ({ ReactionReviewForm: fake.reaction }));
vi.mock("@/app/(operator)/admin/requests/PrototypeRequestActions", () => ({ PrototypeTakedownAction: fake.takedown, PrototypeIntroAction: fake.intro }));
vi.mock("@/components/product-detail/FeedbackList", () => ({ FeedbackItem: () => null }));
const { PrototypeRequestWorkspace } = await import("@/app/(operator)/admin/requests/PrototypeRequestWorkspace");
const admin = { login: "operator", exp: 5000 }, secret = "test-secret", now = new Date("2026-11-04T12:00:00Z");
const row = (kind: WorkspaceRequest["kind"], patch: object = {}) => ({ key: `${kind}:id`, kind, name: "프로젝트 원본", type: kind, status: "보류", waitHours: 27, at: now.toISOString(), next: "원본 확인", body: "읽은 원문", slug: "product", record: {}, ...patch }) as WorkspaceRequest;
function queue(items: WorkspaceRequest[]) { return { count: items.length, items, failed: [], results: [{ kind: items[0]?.kind ?? "contact", result: { ok: true, data: { count: items.length, items, nextOffset: null } } }] }; }
beforeEach(() => { vi.clearAllMocks(); for (const form of [fake.contact, fake.feedback, fake.reply, fake.reaction, fake.takedown, fake.intro]) form.mockImplementation(() => null); fake.read.mockResolvedValue(queue([])); });
it("선택된 문의 한 건에 기존 CSRF·원본 판만 전달하고 원본 ID로 목록을 이동한다", async () => {
  fake.read.mockResolvedValue(queue([row("contact", { record: { id: "contact-id", version: 7, status: "waiting", handlingNote: "기존 메모", senderEmail: "person@example.com", updatedBy: "op", updatedAt: now } })]));
  const html = renderToStaticMarkup(await PrototypeRequestWorkspace({ tab: "contact", params: { state: "waiting", offset: "50" }, admin, secret }));
  expect(fake.read).toHaveBeenCalledWith(["contact"], "waiting", 50, undefined); expect(fake.contact.mock.calls[0][0]).toMatchObject({ id: "contact-id", version: 7, status: "waiting", handlingNote: "기존 메모", csrfToken: adminRequestToken("contact-requests", admin, secret) });
  expect(html).toContain('class="grid detail"'); expect(html).toContain("person@example.com"); expect(html).toContain("id=contact%3Aid");
});
it("선택한 원본이 빠지면 다른 요청의 처리 폼으로 자동 전환하지 않는다", async () => {
  fake.read.mockResolvedValue(queue([row("contact")])); const html = renderToStaticMarkup(await PrototypeRequestWorkspace({ tab: "contact", params: { id: "contact:removed" }, admin, secret }));
  expect(html).toContain("선택한 요청이 현재 목록에 없습니다"); expect(fake.contact).not.toHaveBeenCalled();
});
it("조회 실패를 0건으로 표시하지 않는다", async () => {
  fake.read.mockResolvedValue({ count: 0, items: [], failed: ["contact"], results: [{ kind: "contact", result: { ok: false } }] });
  const html = renderToStaticMarkup(await PrototypeRequestWorkspace({ tab: "contact", params: {}, admin, secret })); expect(html).toContain("전체 수 —"); expect(html).toContain("조회 실패"); expect(html).not.toContain("0건 이상");
});
it("피드백 검수는 기존 세션 서명과 공개 상태를 유지한다", async () => {
  fake.read.mockResolvedValue(queue([row("feedback", { record: { id: "feedback-id", reviewState: "accepted" } })]));
  const html = renderToStaticMarkup(await PrototypeRequestWorkspace({ tab: "posts", params: { kind: "feedback", state: "accepted" }, admin, secret }));
  expect(fake.feedback.mock.calls[0][0]).toMatchObject({ id: "feedback-id", reviewState: "accepted", csrfToken: createHmac("sha256", secret).update("feedback-admin:operator:5000").digest("hex") }); expect(html).toContain("공개 복원은 GitHub에 다시 보내지 않습니다");
});
it("메이커 답장의 대상 원문과 원본 판을 보존한다", async () => {
  fake.read.mockResolvedValue(queue([row("replies", { record: { reply: { id: "reply-id", reviewVersion: 9, reviewState: "held" }, targetBody: "대상 원문" } })]));
  const html = renderToStaticMarkup(await PrototypeRequestWorkspace({ tab: "posts", params: { kind: "replies" }, admin, secret }));
  expect(html).toContain("대상 원문"); expect(fake.reply.mock.calls[0][0]).toMatchObject({ id: "reply-id", version: 9, reviewState: "held", csrfToken: adminRequestToken("maker-replies", admin, secret) });
});
it("써봤어요 처리 폼에는 검토한 글 자체를 전달한다", async () => {
  fake.read.mockResolvedValue(queue([row("reactions", { record: { id: "reaction-id", comment: "읽은 한 줄" } })]));
  renderToStaticMarkup(await PrototypeRequestWorkspace({ tab: "posts", params: { kind: "reactions", state: "accepted" }, admin, secret })); expect(fake.reaction.mock.calls[0][0]).toMatchObject({ id: "reaction-id", comment: "읽은 한 줄", expiresAt: 5000 }); expect(fake.read).toHaveBeenCalledWith(["reactions"], "held", 0, undefined);
});
it("내림 요청의 24시간 기한을 일반 요청과 구분한다", async () => {
  const item = row("takedown", { record: { slug: "product", product: { name: "프로젝트 원본", status: "verified" }, previousOutcome: null, owner: null } }); fake.read.mockResolvedValue({ ...queue([item]), results: [{ kind: "takedown", result: { ok: true, data: { count: 1, items: [item], overdue: 1 } } }] });
  const html = renderToStaticMarkup(await PrototypeRequestWorkspace({ tab: "correction", params: {}, admin, secret })); expect(html).toContain("기한 초과 1건"); expect(html).toContain("24시간 초과"); expect(fake.takedown.mock.calls[0][0]).toMatchObject({ entry: { slug: "product", product: { name: "프로젝트 원본" } } }); expect(fake.takedown.mock.calls[0][0].entry).not.toHaveProperty("owner");
  expect(html).toContain('href="/admin/audit?tab=requests"'); expect(html).toContain("계정·보낸이·접수시각으로 묶어서 내림/유지");
});
