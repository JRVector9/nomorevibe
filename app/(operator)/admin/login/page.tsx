import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { adminLocalLoginEnabled, authSecret, currentAdmin } from "@/lib/auth/admin";
import { ADMIN_LOGIN_COOKIE, adminLoginCsrf, adminPasswordConfig } from "@/lib/auth/admin-password";

export const metadata: Metadata = { title: "어드민 로그인 — NoMoreVibe", robots: { index: false } };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (adminLocalLoginEnabled()) redirect("/admin");
  const { error } = await searchParams;
  if (await currentAdmin()) redirect("/admin/inbox");
  const passwordConfigured = !!adminPasswordConfig() && !!authSecret();
  const csrfToken = adminLoginCsrf((await cookies()).get(ADMIN_LOGIN_COOKIE)?.value);
  if (passwordConfigured && !csrfToken) redirect(`/api/auth/password${error === "1" || error === "rate" ? `?error=${error}` : ""}`);
  const oauthConfigured = !!process.env.GITHUB_OAUTH_CLIENT_ID && !!process.env.GITHUB_OAUTH_CLIENT_SECRET;

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-[420px] flex-col justify-center px-6">
      <div className="rounded-[12px] border border-line bg-bg-card p-8">
        <h1 className="text-[19px] font-extrabold tracking-tight">어드민</h1>
        <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">
          내부 접속에서 관리자 아이디와 비밀번호로 로그인합니다.
        </p>

        {error && (
          <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] text-down">
            {error === "rate" ? "로그인 시도가 많습니다. 15분 뒤 다시 시도해주세요." : "로그인하지 못했습니다. 아이디와 비밀번호를 확인해주세요."}
          </p>
        )}

        {passwordConfigured && <form action="/api/auth/password" method="post" className="mt-6 space-y-4">
          <input type="hidden" name="csrfToken" value={csrfToken!} />
          <label className="block text-[13px] font-medium">아이디<input required name="username" autoComplete="username" maxLength={120} className="mt-1 block w-full rounded-lg border border-line bg-bg p-3" /></label>
          <label className="block text-[13px] font-medium">비밀번호<input required type="password" name="password" autoComplete="current-password" maxLength={1024} className="mt-1 block w-full rounded-lg border border-line bg-bg p-3" /></label>
          <button type="submit" className="min-h-11 w-full rounded-lg bg-accent-solid px-4 text-[13.5px] font-semibold text-white">로그인</button>
        </form>}
        {!passwordConfigured && <p className="mt-5 text-[13px] text-fg-2">관리자 아이디·비밀번호 설정이 필요합니다.</p>}
        {/* OAuth 시작은 API 라우트라 페이지 링크가 아니다. <Link>로 바꾸면 hover prefetch가
            로그인 요청을 미리 쏜다. (슬롯 catch-all 이 있던 때는 lint 규칙이 이것을 페이지로 오탐해 예외를 뒀다) */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- OAuth starts with a full document request, never prefetch. */}
        {oauthConfigured && <a
          href="/api/auth/github"
          className="mt-6 flex items-center justify-center gap-2 rounded-[10px] bg-accent-solid px-4 py-2.5 text-[13.5px] font-semibold text-white hover:brightness-110"
        >
          GitHub으로 로그인
        </a>}
      </div>
    </main>
  );
}
