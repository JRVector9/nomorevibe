import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ admin: vi.fn(), secret: vi.fn(), cookie: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: fake.admin, authSecret: fake.secret }));
vi.mock("next/navigation", () => ({ redirect: fake.redirect }));
vi.mock("next/headers", () => ({ cookies: async () => ({ has: fake.cookie }) }));
vi.mock("@/app/(operator)/admin/components/PageStamp", () => ({ PageStamp: () => null }));
vi.mock("@/app/(operator)/admin/requests/ContactsPanel", () => ({ ContactsPanel: () => <div data-panel="contact" /> }));
vi.mock("@/app/(operator)/admin/requests/PostsPanel", () => ({ PostsPanel: () => <div data-panel="posts" /> }));
vi.mock("@/app/(operator)/admin/requests/WorkspaceParts", () => ({
  CorrectionRequestsPanel: () => <div data-panel="correction" />,
  OpenRequestsPanel: ({ fresh }: { fresh: boolean }) => <div data-panel="open" data-fresh={fresh} />,
  RegistrationPanel: () => <div data-panel="registration" />,
  RequestHistoryPanel: () => <div data-panel="history" />,
}));
const { default: RequestsPage } = await import("@/app/(operator)/admin/requests/page");
beforeEach(() => {
  vi.clearAllMocks(); fake.admin.mockResolvedValue({ login: "operator", exp: 5000 });
  fake.secret.mockReturnValue("test-session-secret"); fake.cookie.mockReturnValue(false);
  fake.redirect.mockImplementation(() => { throw new Error("redirect"); });
});

it("조회 영역을 선택하기 전에 관리자 세션을 검사한다", async () => {
  fake.admin.mockResolvedValue(null);
  await expect(RequestsPage({ searchParams: Promise.resolve({ tab: "contact" }) })).rejects.toThrow("redirect");
  expect(fake.redirect).toHaveBeenCalledWith("/admin/login"); expect(fake.secret).not.toHaveBeenCalled();
});
it("새 요청함에는 숨겨진 제목만 두고 기본 탭에 수동 갱신 의도를 전달한다", async () => {
  fake.cookie.mockReturnValue(true);
  const html = renderToStaticMarkup(await RequestsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('<h1 class="sr-only">요청함</h1>');
  expect(html).toContain('data-panel="open" data-fresh="true"');
});
it.each(["correction", "contact", "posts", "registration", "history"])("%s 탭은 선택된 영역만 표시한다", async tab => {
  const html = renderToStaticMarkup(await RequestsPage({ searchParams: Promise.resolve({ tab }) }));
  expect(html).toContain(`data-panel="${tab}"`); expect(html).not.toContain('data-panel="open"');
  expect(fake.cookie).not.toHaveBeenCalled();
});
it("이전 문의 필터 주소도 문의 영역으로 열린다", async () => {
  const html = renderToStaticMarkup(await RequestsPage({ searchParams: Promise.resolve({ state: "resolved", offset: "50" }) }));
  expect(html).toContain('data-panel="contact"');
});
