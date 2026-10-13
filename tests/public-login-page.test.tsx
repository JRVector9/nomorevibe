import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const account = vi.hoisted(() => ({ signedIn: false, starEnabled: true }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not-found"); }, redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock("@/lib/domain/accounts/request-auth", () => ({
  getPublicSession: async () => account.signedIn ? { user: { id: 1 } } : null,
  safeReturnUrl: (value: unknown) => typeof value === "string" ? value : "/",
}));
vi.mock("@/lib/domain/github-integration/flags", () => ({ publicUserAuthEnabled: () => true, githubStarEnabled: () => account.starEnabled }));
vi.mock("@/components/auth/EmailLoginForm", () => ({ EmailLoginForm: () => <div>email-form</div> }));
vi.mock("@/components/auth/GithubConnection", () => ({ GithubConnection: ({ returnTo, signedIn }: { returnTo: string; signedIn: boolean }) => <div>{signedIn ? "github-connection" : "github-login"}:{returnTo}</div> }));
import LoginPage from "@/app/(public)/[locale]/login/page";

beforeEach(() => {
  account.signedIn = false;
  account.starEnabled = true;
  vi.stubEnv("LOGIN_EMAIL_API_KEY", "");
  vi.stubEnv("LOGIN_EMAIL_FROM", "");
});
afterEach(() => vi.unstubAllEnvs());
it("이메일 로그인한 사용자는 명시적인 GitHub 연결 화면을 열 수 있다", async () => {
  account.signedIn = true;
  const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ connectGithub: "1", returnTo: "/p/example" }) }));
  expect(html).toContain("github-connection:/p/example");
  expect(html).not.toContain("email-form");
});
it("일반 로그인 주소는 로그인한 사용자를 원래 화면으로 보낸다", async () => {
  account.signedIn = true;
  await expect(LoginPage({ searchParams: Promise.resolve({ returnTo: "/p/example" }) })).rejects.toThrow("redirect:/p/example");
});
it("익명 사용자는 메일 설정 없이 GitHub로 로그인할 수 있다", async () => {
  const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ returnTo: "/" }) }));
  expect(html).not.toContain("email-form");
  expect(html).toContain("github-login:/");
});
it("스타 플래그를 끄면 GitHub 연결 진입점은 표시하지 않는다", async () => {
  account.starEnabled = false;
  vi.stubEnv("LOGIN_EMAIL_API_KEY", "login-page-mail-key");
  vi.stubEnv("LOGIN_EMAIL_FROM", "login@example.test");
  const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
  expect(html).not.toContain("github-login");
  expect(html).toContain("email-form");
});
