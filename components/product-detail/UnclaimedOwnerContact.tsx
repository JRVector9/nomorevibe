/* eslint-disable @next/next/no-img-element -- GitHub serves the public owner avatar for this attributed profile. */
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { SourceBadge } from "./SourceBadge";
import { TakedownForm } from "@/app/p/[slug]/TakedownForm";

export function UnclaimedOwnerContact({ repoUrl, slug }: { repoUrl: string | null; slug: string }) {
  const owner = githubOwnerFromRepositoryUrl(repoUrl);
  if (!owner) return null;

  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[16px] font-extrabold text-fg">운영 주체와 연락</h2>
          <p className="mt-1 text-[13px] leading-5 text-fg-3">현재 공개된 GitHub 정보입니다.</p>
        </div>
        <SourceBadge label="GitHub에서 확인" />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <img
          src={owner.avatarUrl}
          width={44}
          height={44}
          alt=""
          loading="lazy"
          className="h-11 w-11 shrink-0 rounded-[10px] border border-line bg-bg-soft object-cover"
        />
        <div className="min-w-0">
          <a
            href={owner.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-[14px] font-extrabold text-fg hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            @{owner.login} ↗
          </a>
          <p className="mt-0.5 text-[13px] text-fg-3">GitHub 저장소 소유자</p>
        </div>
      </div>

      <p className="mt-4 text-[13px] leading-6 text-fg-2">
        이 저장소를 소유한 공개 계정입니다. 저장소 소유자와 실제 제작자가 다를 수 있습니다.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <a
          href={owner.profileUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center rounded-[9px] border border-line px-3 text-[13px] font-bold text-fg hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          GitHub 프로필 ↗
        </a>
        <a
          href={owner.repositoryUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center rounded-[9px] border border-line px-3 text-[13px] font-bold text-fg hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          저장소 보기 ↗
        </a>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <p className="text-[13px] font-extrabold text-fg">이 프로젝트의 운영자인가요?</p>
        <p className="mt-1 text-[13px] leading-5 text-fg-3">
          프로젝트 폴더에서 <code className="font-mono font-semibold text-accent">/nomorevibe</code>를 실행하면
          소유권을 확인하고 소개를 직접 관리할 수 있습니다.
        </p>
        <TakedownForm slug={slug} />
      </div>
    </section>
  );
}
