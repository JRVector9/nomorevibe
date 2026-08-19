import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { safeExternalUrl } from "./format";
import { SourceBadge } from "./SourceBadge";

function SafeMarkdownLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const safe = href?.startsWith("/") ? href : safeExternalUrl(href ?? null);
  if (!safe) return <span>{children}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-[14px] font-bold text-fg">{title}</h3>
      <ul className="mt-2 space-y-1.5 text-[14px] leading-6 text-fg-2">
        {items.map((item) => <li key={item}>• {item}</li>)}
      </ul>
    </div>
  );
}

export function ProductIntroduction({ product, profile, unclaimed }: {
  product: ProductDetailView["product"];
  profile: ProductDetailView["profile"];
  unclaimed: boolean;
}) {
  return (
    <section className="rounded-[12px] border border-line bg-bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[17px] font-extrabold text-fg">상세 소개</h2>
        <SourceBadge label={unclaimed ? "자동 감지" : "메이커 제공·미검증"} />
      </div>
      <p className="mt-4 whitespace-pre-line text-[15px] leading-7 text-fg-2">{product.description}</p>
      {profile ? (
        <>
          {(profile.problem || profile.targetUsers || profile.privacySummary) && (
            <dl className="mt-6 grid gap-4 rounded-[10px] bg-bg-soft p-4 sm:grid-cols-2">
              {profile.problem && <div><dt className="text-[13px] font-bold text-fg">해결하는 문제</dt><dd className="mt-1 leading-6 text-[14px] text-fg-2">{profile.problem}</dd></div>}
              {profile.targetUsers && <div><dt className="text-[13px] font-bold text-fg">주요 사용자</dt><dd className="mt-1 leading-6 text-[14px] text-fg-2">{profile.targetUsers}</dd></div>}
              {profile.privacySummary && <div className="sm:col-span-2"><dt className="text-[13px] font-bold text-fg">개인정보·처리 방식</dt><dd className="mt-1 leading-6 text-[14px] text-fg-2">{profile.privacySummary}</dd></div>}
            </dl>
          )}
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <ListBlock title="주요 기능" items={profile.keyFeatures} />
            <ListBlock title="활용 예시" items={profile.useCases} />
          </div>
          {profile.longDescriptionMarkdown && (
            <div className="mt-6 space-y-3 border-t border-line pt-5 text-[15px] leading-7 text-fg-2 [&_h2]:mt-5 [&_h2]:text-[16px] [&_h2]:font-extrabold [&_h2]:text-fg [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                skipHtml
                components={{ a: SafeMarkdownLink, img: () => null }}
              >
                {profile.longDescriptionMarkdown}
              </ReactMarkdown>
            </div>
          )}
        </>
      ) : (
        <p className="mt-5 rounded-[10px] bg-bg-soft px-4 py-3 text-[13px] leading-6 text-fg-3">
          메이커가 아직 상세 소개를 제공하지 않았습니다.
        </p>
      )}
    </section>
  );
}
