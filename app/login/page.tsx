import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { EmailLoginForm } from "@/components/auth/EmailLoginForm";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { getPublicSession, safeReturnUrl } from "@/lib/domain/accounts/request-auth";

export const metadata: Metadata = { title: "로그인 — NoMoreVibe", robots: { index: false, follow: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[] }> }) {
  if (!publicUserAuthEnabled()) notFound();
  const returnTo = safeReturnUrl((await searchParams).returnTo);
  if (await getPublicSession()) redirect(returnTo === "/login" || returnTo.startsWith("/login?") ? "/" : returnTo);
  return (
    <main className="mx-auto flex min-h-[65vh] max-w-[460px] flex-col justify-center px-6 py-12">
      <section className="rounded-xl border border-line bg-bg-card p-7">
        <h1 className="text-[23px] font-bold tracking-tight">로그인</h1>
        <p className="mt-3 text-[15px] leading-7 text-fg-2">이메일 인증으로 NoMoreVibe에 참여하세요. GitHub 계정 없이도 프로젝트에 피드백을 남길 수 있습니다.</p>
        <p className="mt-2 text-[14px] leading-6 text-fg-2">공개 글에는 이메일 대신 참여자 닉네임을 표시합니다.</p>
        <EmailLoginForm returnTo={returnTo} />
      </section>
    </main>
  );
}
