import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { TakedownForm } from "@/app/p/[slug]/TakedownForm";

export function UnclaimedOwnerContact({ repoUrl, slug, installable = false }: { repoUrl: string | null; slug: string; installable?: boolean }) {
  if (!githubOwnerFromRepositoryUrl(repoUrl)) return null;

  return (
    <section className="rounded-[18px] border border-line p-5 [&_summary]:flex [&_summary]:min-h-11 [&_summary]:items-center">
      <h2 className="text-[14px] font-semibold text-fg">이 프로젝트의 운영자인가요?</h2>
      <p className="mt-1 text-[13px] leading-5 text-fg-3">
        {installable ? "저장소 소유권 확인이 필요한 설치형 프로젝트입니다. 소개 수정은 관리자에게 요청해주세요." : <>
          프로젝트 폴더에서 <code className="font-mono font-semibold text-accent">/nomorevibe verify</code>를 실행하면
          소유권을 확인하고 소개를 직접 관리할 수 있습니다.
        </>}
      </p>
      <TakedownForm slug={slug} />
    </section>
  );
}
