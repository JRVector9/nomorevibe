import type { Metadata } from "next";

export const metadata: Metadata = { title: "어드민 로그인 — NoMoreVibe", robots: { index: false } };

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-[420px] flex-col justify-center px-6">
      <div className="rounded-[14px] border border-line bg-bg-card p-8">
        <h1 className="text-[19px] font-extrabold tracking-tight">어드민</h1>
        <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">
          크롤 파이프라인을 관리합니다. 허용된 GitHub 계정만 들어올 수 있습니다.
        </p>

        {error && (
          <p className="mt-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[12.5px] text-down">
            로그인하지 못했습니다. 허용된 계정인지 확인해주세요.
          </p>
        )}

        <a
          href="/api/auth/github"
          className="mt-6 flex items-center justify-center gap-2 rounded-[10px] bg-accent-solid px-4 py-2.5 text-[13.5px] font-semibold text-white hover:brightness-110"
        >
          GitHub으로 로그인
        </a>
      </div>
    </main>
  );
}
