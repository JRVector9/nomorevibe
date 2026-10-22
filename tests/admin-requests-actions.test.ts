import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ actor: vi.fn(), create: vi.fn(), update: vi.fn(), review: vi.fn(), fenced: false, revalidate: vi.fn() }));
vi.mock("@/lib/operations/admin-requests-action-auth", () => ({ authorizeAdminRequest: fake.actor }));
vi.mock("@/lib/operations/contact-requests", () => ({ createContactRequest: fake.create, updateContactRequest: fake.update }));
vi.mock("@/lib/operations/maker-reply-review", () => ({ reviewMakerReply: fake.review }));
vi.mock("next/cache", () => ({ revalidatePath: fake.revalidate }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: (...args: unknown[]) => Promise<unknown>) => (...args: unknown[]) => {
  if (fake.fenced) return Promise.reject(new Error("site_fenced"));
  return fn(...args);
} }));
const { createContactAction, updateContactAction } = await import("@/app/(operator)/admin/requests/actions");
const { reviewMakerReplyAction } = await import("@/app/(operator)/admin/maker-replies/actions");
beforeEach(() => { vi.clearAllMocks(); fake.fenced = false; fake.actor.mockResolvedValue("operator"); fake.review.mockResolvedValue({ targetType: "feedback", targetId: "id" }); });
it("세 액션 모두 DR 관문이 막으면 권한 검사와 DB 쓰기에 도달하지 않는다", async () => {
  fake.fenced = true;
  for (const action of [createContactAction, updateContactAction, reviewMakerReplyAction]) await expect(action(null, new FormData())).rejects.toThrow("site_fenced");
  expect(fake.actor).not.toHaveBeenCalled();
  expect(fake.create).not.toHaveBeenCalled(); expect(fake.update).not.toHaveBeenCalled(); expect(fake.review).not.toHaveBeenCalled();
});
it("권한·Origin·서명 검사를 통과하지 못하면 문의/답장을 변경하지 않는다", async () => {
  fake.actor.mockRejectedValue(new Error("forbidden"));
  for (const action of [createContactAction, updateContactAction, reviewMakerReplyAction]) expect(await action(null, new FormData())).toHaveProperty("error");
  expect(fake.create).not.toHaveBeenCalled(); expect(fake.update).not.toHaveBeenCalled(); expect(fake.review).not.toHaveBeenCalled();
});
it("수동 수신시각은 UTC로 받고 처리자 입력은 서버 세션 값으로만 넘긴다", async () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({ senderEmail: "person@example.com", subject: "질문", body: "본문", receivedAt: "2026-10-22T10:30", actor: "attacker" })) form.set(key, value);
  expect(await createContactAction(null, form)).toEqual({ ok: true });
  expect(fake.actor).toHaveBeenCalledWith("contact-requests", form);
  expect(fake.create).toHaveBeenCalledWith({ senderEmail: "person@example.com", subject: "질문", body: "본문", receivedAt: "2026-10-22T10:30:00.000Z" }, "operator");
});
