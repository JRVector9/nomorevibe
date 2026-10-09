import Link from "next/link";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { TakedownForm } from "@/app/p/[slug]/TakedownForm";

const LINK = "text-accent-ink hover:underline";

/**
 * 운영자 상자 — 막다른 안내가 되지 않게 다음 걸음을 링크로 준다(2026-10-08 UX 감사 UX-18).
 *
 * 웹사이트는 '1분 만에 확인하기'가 설치 → verify 순서를 적은 /launch#verify 로 보낸다. 설치형은 배포 도메인이 없어
 * 명령으로 확인할 수 없으므로(verify.ts) 사이트 안 요청 폼(/policy#contact)으로 보낸다 — 공개 이메일은 두지 않는다(D5).
 * CLI 를 쓰지 않는 운영자의 GitHub 로그인 확인은 아직 없다(D6) — 준비 중이라고 한 줄로만 말하고 누를 것을 만들지 않는다.
 */
export function UnclaimedOwnerContact({ repoUrl, slug, installable = false }: { repoUrl: string | null; slug: string; installable?: boolean }) {
  if (!githubOwnerFromRepositoryUrl(repoUrl)) return null;

  return (
    <section className="rounded-[18px] border border-line p-5 [&_summary]:flex [&_summary]:min-h-11 [&_summary]:items-center">
      <h2 className="text-[14px] font-semibold text-fg">이 프로젝트의 운영자인가요?</h2>
      {installable ? (
        <>
          <p className="mt-1 text-[13px] leading-5 text-fg-2">
            설치형 프로젝트는 배포 도메인이 없어 명령으로 소유를 확인할 수 없습니다. 소개를 고치거나 저장소 소유를 확인하려면 관리자에게 요청해 주세요.
          </p>
          <Link prefetch={false} href="/policy#contact"
            className="mt-3 inline-flex min-h-11 items-center rounded-full bg-bg-soft px-5 text-[14px] font-medium text-fg">
            관리자에게 요청
          </Link>
          <p className="mt-2 text-[13px] leading-5 text-fg-2">GitHub 로그인으로 저장소 주인을 확인하는 방법은 준비 중입니다.</p>
        </>
      ) : (
        <>
          <p className="mt-1 text-[13px] leading-5 text-fg-2">
            프로젝트 폴더에서 <code className="font-mono font-semibold text-accent-ink">/nomorevibe verify</code>를 실행하면
            소유권을 확인하고 소개를 직접 관리할 수 있습니다.
          </p>
          <Link prefetch={false} href="/launch#verify"
            className="mt-3 inline-flex min-h-11 items-center rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white hover:opacity-90">
            1분 만에 확인하기
          </Link>
          <p className="mt-2 text-[13px] leading-5 text-fg-2">
            CLI를 쓰지 않나요? GitHub 로그인으로 확인하는 방법은 준비 중입니다. 그동안은{" "}
            <Link prefetch={false} href="/policy#contact" className={LINK}>관리자에게 요청</Link>해 주세요.
          </p>
        </>
      )}
      <TakedownForm slug={slug} />
    </section>
  );
}
