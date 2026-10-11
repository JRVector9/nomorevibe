import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { englishLang } from "@/components/ProductTagline";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { getReadmeContent } from "@/lib/domain/products/readme-content";
import { SafeMarkdownLink } from "./IntroSection";
import { safeExternalUrl } from "./format";

type Props = { product: ProductDetailView["product"]; readmeExcerpt: string | null };

const scrollClass = "max-h-[min(60vh,480px)] min-w-0 max-w-[720px] overflow-y-auto border-l-2 border-line pl-[18px] pr-3 text-[15px] leading-[1.6] text-fg [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function OriginalLink({ url }: { url: string }) {
  return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center self-start text-[13px] text-accent-ink hover:underline">README 전문 보기 ↗</a>;
}

/** The fallback is explicitly an excerpt; it never claims to be the full source. */
export function ReadmeFallback({ product, readmeExcerpt, pending = false, tooLarge = false, sourceUrl }: Props & {
  pending?: boolean; tooLarge?: boolean; sourceUrl?: string;
}) {
  const repo = product.repoUrl ? safeExternalUrl(product.repoUrl) : null;
  if (!repo || product.repoGone) return null;
  return (
    <section aria-labelledby="readme-title" className="flex flex-col gap-3">
      <h2 id="readme-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2">README</h2>
      <p role={pending ? "status" : undefined} className="m-0 text-[13px] leading-6 text-fg-2">
        {pending ? "README 전체를 불러오는 중입니다." : tooLarge
          ? "README가 표시 한도를 넘었습니다. 원문 링크에서 전문을 볼 수 있습니다."
          : "지금 README 전체를 불러올 수 없습니다. 원문 링크에서 읽을 수 있습니다."}
        {readmeExcerpt && " 아래는 저장된 발췌입니다."}
      </p>
      {readmeExcerpt && <blockquote role="region" aria-label="저장된 README 발췌" tabIndex={0} lang={englishLang(readmeExcerpt)} className={`m-0 whitespace-pre-wrap ${scrollClass}`}>{readmeExcerpt}</blockquote>}
      <OriginalLink url={safeExternalUrl(sourceUrl ?? null) ?? `${repo}#readme`} />
    </section>
  );
}

/** Async server section: only the README waits for GitHub, while the rest of the detail page streams. */
export async function ReadmeSection({ product, readmeExcerpt }: Props) {
  if (!product.repoUrl || product.repoGone) return null;
  const readme = await getReadmeContent(product.repoUrl);
  if (!readme || readme.state !== "available") return <ReadmeFallback product={product} readmeExcerpt={readmeExcerpt}
    tooLarge={readme?.state === "too_large"} sourceUrl={readme?.sourceUrl} />;
  const link = (props: ComponentPropsWithoutRef<"a">) => {
    let href: string | undefined;
    try {
      const rootRelative = props.href?.startsWith("/") && !props.href.startsWith("//");
      href = props.href ? rootRelative
        ? new URL(`.${props.href}`, readme.repositoryRootUrl).href
        : new URL(props.href, readme.sourceUrl).href : undefined;
    } catch { /* Render unsafe links as text. */ }
    return <SafeMarkdownLink {...props} href={href} />;
  };
  return (
    <section aria-labelledby="readme-title" className="flex flex-col gap-3">
      <h2 id="readme-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2">README</h2>
      <div role="region" aria-label="README 본문" tabIndex={0} lang={englishLang(readme.markdown)}
        className={`${scrollClass} space-y-3 [&_h1]:mt-5 [&_h1]:text-[20px] [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-[18px] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-[16px] [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-3 [&_pre]:whitespace-pre-wrap [&_pre]:rounded-lg [&_pre]:bg-bg-soft [&_pre]:p-3 [&_pre]:text-[13px] [&_table]:w-full [&_table]:table-fixed [&_td]:border [&_td]:border-line [&_td]:p-2 [&_th]:border [&_th]:border-line [&_th]:p-2`}>
        {readme.markdown.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={{ a: link, img: () => null }}>
          {readme.markdown}
        </ReactMarkdown> : <p className="m-0 text-fg-2">README에 표시할 내용이 없습니다.</p>}
      </div>
      <OriginalLink url={readme.sourceUrl} />
    </section>
  );
}
