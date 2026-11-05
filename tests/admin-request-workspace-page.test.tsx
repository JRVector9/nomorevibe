import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ admin: vi.fn(), secret: vi.fn(), redirect: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: fake.admin, authSecret: fake.secret }));
vi.mock("next/navigation", () => ({ redirect: fake.redirect }));
vi.mock("@/app/(operator)/admin/components/PageStamp", () => ({ PageStamp: () => null }));
vi.mock("@/app/(operator)/admin/requests/RequestForms", () => ({ ContactCreateForm: () => null }));
vi.mock("@/app/(operator)/admin/requests/PrototypeRequestWorkspace", () => ({ PrototypeRequestWorkspace: ({ tab }: { tab: string }) => <div data-panel={tab} /> }));
vi.mock("@/app/(operator)/admin/requests/WorkspaceParts", () => ({ RegistrationPanel: () => <div data-panel="registration" />, RequestHistoryPanel: () => <div data-panel="history" /> }));
const { default: RequestsPage } = await import("@/app/(operator)/admin/requests/page");
beforeEach(() => { vi.clearAllMocks(); fake.admin.mockResolvedValue({ login: "operator", exp: 5000 }); fake.secret.mockReturnValue("test-secret"); fake.redirect.mockImplementation(() => { throw new Error("redirect"); }); });
it("관리자 확인을 마치기 전에 접수 데이터와 폼을 노출하지 않는다", async () => {
  fake.admin.mockResolvedValue(null); await expect(RequestsPage({ searchParams: Promise.resolve({ tab: "contact" }) })).rejects.toThrow("redirect");
  expect(fake.redirect).toHaveBeenCalledWith("/admin/login"); expect(fake.secret).not.toHaveBeenCalled();
});
it("큰 제목 없이 접근성 제목과 실제 접수 진입을 제공한다", async () => {
  const html = renderToStaticMarkup(await RequestsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('<h1 class="sr-only">요청함</h1>'); expect(html).toContain('data-panel="open"'); expect(html).toContain("받은 문의 수동 접수");
});
it.each(["correction", "contact", "posts", "registration", "history"])("%s 선택은 해당 영역만 읽게 한다", async tab => {
  const html = renderToStaticMarkup(await RequestsPage({ searchParams: Promise.resolve({ tab }) })); expect(html).toContain(`data-panel="${tab}"`); expect(html).not.toContain('data-panel="open"');
});
it("이전 문의 필터 주소를 보존한다", async () => {
  const html = renderToStaticMarkup(await RequestsPage({ searchParams: Promise.resolve({ state: "resolved", offset: "50" }) })); expect(html).toContain('data-panel="contact"');
});
