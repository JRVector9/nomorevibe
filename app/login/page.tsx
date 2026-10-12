import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { EmailLoginForm } from "@/components/auth/EmailLoginForm";
import { GithubConnection } from "@/components/auth/GithubConnection";
import { emailLoginConfigured } from "@/lib/domain/accounts/email-delivery";
import { githubStarEnabled, publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { getPublicSession, safeReturnUrl } from "@/lib/domain/accounts/request-auth";

export const metadata: Metadata = { title: "로그인 — NoMoreVibe", robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[]; connectGithub?: string | string[] }> }) {
  if (!publicUserAuthEnabled()) notFound();
  const params = await searchParams;
  const returnTo = safeReturnUrl(params.returnTo);
  const session = await getPublicSession();
  const starEnabled = githubStarEnabled();
  const emailEnabled = emailLoginConfigured();
  if (session && !(starEnabled && params.connectGithub === "1")) redirect(returnTo === "/login" || returnTo.startsWith("/login?") ? "/" : returnTo);
  return (
    <main className="mx-auto flex min-h-[65vh] max-w-[460px] flex-col justify-center px-6 py-12">
      <section className="rounded-xl border border-line bg-bg-card p-7">
        <h1 className="text-[23px] font-bold tracking-tight">{session ? "GitHub 연결" : "로그인"}</h1>
        {!session && <p className="mt-3 text-[15px] leading-7 text-fg-2">로그인하고 프로젝트에 스타를 남기거나 피드백을 작성하세요.</p>}
        {starEnabled && <GithubConnection returnTo={returnTo} signedIn={!!session} />}
        {!session && emailEnabled && <section className={starEnabled ? "mt-7 border-t border-line pt-6" : "mt-6"} aria-label="이메일 로그인">
          <h2 className="text-[17px] font-semibold">이메일로 로그인</h2>
          <p className="mt-2 text-[14px] leading-6 text-fg-2">GitHub 계정 없이도 이메일 인증으로 피드백을 남길 수 있습니다. 공개 글에는 이메일 대신 참여자 닉네임을 표시합니다.</p>
          <EmailLoginForm returnTo={returnTo} />
        </section>}
        {!starEnabled && !emailEnabled && <p className="mt-6 text-[14px] leading-6 text-fg-2" role="status">로그인을 준비하고 있습니다.</p>}
      </section>
    </main>
  );
}
