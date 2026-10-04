import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { safeExternalUrl } from "./format";

function SafeMarkdownLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const safe = href?.startsWith("/") ? href : safeExternalUrl(href ?? null);
  if (!safe) return <span>{children}</span>;
  return <a href={safe} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink hover:underline">{children}</a>;
}

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return <h2 className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-3"><span id={id}>{children}</span></h2>;
}

/**
 * 소개 — 설명이 한 줄 소개와 다를 때만 설명을, 그다음 README 발췌를. 둘 다 없으면 README 로 가라는 한 줄.
 * 메이커 프로필(문제·사용자·기능·활용)은 있을 때만 그 아래.
 */
export function IntroSection({ product, profile, readmeExcerpt, unclaimed }: {
  product: ProductDetailView["product"];
  profile: ProductDetailView["profile"];
  readmeExcerpt: string | null;
  unclaimed: boolean;
}) {
  // 수집 발행분은 설명이 없으면 소개를 그대로 쓴다 — 히어로의 한 줄을 여기서 되풀이하지 않는다
  const description = product.description.trim() !== product.tagline.trim() ? product.description : null;
  const repo = product.repoUrl ? safeExternalUrl(product.repoUrl) : null;
  const hasProfile = profile && (profile.problem || profile.targetUsers || profile.privacySummary
    || profile.keyFeatures.length > 0 || profile.useCases.length > 0 || profile.longDescriptionMarkdown);
  return (
    <div className="flex flex-col gap-9">
      <section aria-labelledby="intro-title" className="flex flex-col gap-3">
        <Heading id="intro-title">소개</Heading>
        {description
          ? <p className="m-0 max-w-[720px] whitespace-pre-line text-[17px] leading-[1.6] text-fg">{description}</p>
          : !readmeExcerpt && (
            <p className="m-0 max-w-[720px] text-[14px] leading-[1.5] text-fg-2">
              메이커가 쓴 소개는 위의 한 줄이 전부입니다.
              {repo && <> 더 자세한 내용은 <a href={repo} target="_blank" rel="noopener noreferrer" className="text-accent-ink hover:underline">저장소 README ↗</a>에서 읽을 수 있습니다.</>}
            </p>
          )}
        {description && <p className="m-0 text-[13px] text-fg-3">{unclaimed ? "자동 감지 · 저장소 README 기준" : "메이커 제공·미검증"}</p>}
      </section>
      {readmeExcerpt && (
        <section aria-labelledby="readme-title" className="flex flex-col gap-3">
          <Heading id="readme-title">README에서</Heading>
          <blockquote className="m-0 max-w-[720px] whitespace-pre-line border-l-2 border-line pl-[18px] text-[15px] leading-[1.6] text-fg">{readmeExcerpt}</blockquote>
          {repo && <a href={repo} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center self-start text-[13px] text-accent-ink hover:underline">README 전문 보기 ↗</a>}
        </section>
      )}
      {profile && hasProfile && (
        <section aria-labelledby="profile-title" className="flex flex-col gap-4">
          <Heading id="profile-title">메이커가 밝힌 것</Heading>
          {(profile.problem || profile.targetUsers || profile.privacySummary) && (
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              {profile.problem && <div><dt className="text-[13px] font-semibold text-fg">해결하는 문제</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.problem}</dd></div>}
              {profile.targetUsers && <div><dt className="text-[13px] font-semibold text-fg">주요 사용자</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.targetUsers}</dd></div>}
              {profile.privacySummary && <div className="sm:col-span-2"><dt className="text-[13px] font-semibold text-fg">개인정보·처리 방식</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.privacySummary}</dd></div>}
            </dl>
          )}
          {(profile.keyFeatures.length > 0 || profile.useCases.length > 0) && (
            <div className="grid gap-6 sm:grid-cols-2">
              {profile.keyFeatures.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">주요 기능</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.keyFeatures.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {profile.useCases.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">활용 예시</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.useCases.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            </div>
          )}
          {profile.longDescriptionMarkdown && (
            <div className="space-y-3 text-[15px] leading-7 text-fg-2 [&_h2]:mt-5 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-fg [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={{ a: SafeMarkdownLink, img: () => null }}>
                {profile.longDescriptionMarkdown}
              </ReactMarkdown>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
