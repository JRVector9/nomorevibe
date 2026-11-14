import type { ComponentPropsWithoutRef } from "react";
import { PublicSkeleton } from "@/components/PublicSkeleton";
import { getTranslator } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { englishLang } from "@/lib/i18n/content-language";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { getReadmeContent } from "@/lib/domain/products/readme-content";
import { readmePreview } from "@/lib/domain/products/readme-preview";
import { safeExternalUrl } from "./format";

type Props = { product: ProductDetailView["product"]; readmeExcerpt: string | null };

const scrollClass = "max-h-[min(60vh,480px)] min-w-0 max-w-[720px] overflow-y-auto border-l-2 border-line pl-[18px] pr-3 text-[15px] leading-[1.6] text-fg [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function OriginalLink({ url, label }: { url: string; label: string }) {
  return <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center self-start text-[13px] text-accent-ink hover:underline">{label} ↗</a>;
}

/** The fallback is explicitly an excerpt; it never claims to be the full source. */
export async function ReadmeFallback({ product, readmeExcerpt, pending = false, tooLarge = false, sourceUrl }: Props & {
  pending?: boolean; tooLarge?: boolean; sourceUrl?: string;
}) {
  const t = await getTranslator(await getRequestLocale(), "detail");
  const repo = product.repoUrl ? safeExternalUrl(product.repoUrl) : null;
  if (!repo || product.repoGone) return null;
  return (
    <section aria-labelledby="readme-title" aria-busy={pending || undefined} className="flex flex-col gap-3">
      <h2 id="readme-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2">README</h2>
      {pending && <PublicSkeleton />}
      {(!pending || readmeExcerpt) && <p className="m-0 text-[13px] leading-6 text-fg-2">
        {!pending && (tooLarge ? t("readme.tooLarge") : t("readme.unavailable"))}
        {readmeExcerpt && ` ${t("readme.excerptNote")}`}
      </p>}
      {readmeExcerpt && <blockquote role="region" aria-label={t("readme.excerpt")} tabIndex={0} lang={englishLang(readmeExcerpt)} className={`m-0 whitespace-pre-wrap ${scrollClass}`}>{readmeExcerpt}</blockquote>}
      <OriginalLink url={safeExternalUrl(sourceUrl ?? null) ?? `${repo}#readme`} label={t("readme.full")} />
    </section>
  );
}

/**
 * README 속 링크 — 모양은 상자의 [&_a] 규칙이 준다. 링크마다 class 를 달면 HTML·RSC 데이터에 링크 수만큼 두 번씩 실렸다.
 * 바깥으로 나가는 http(s)·루트 상대 주소만 링크로 남긴다(IntroSection SafeMarkdownLink 와 같은 규칙).
 */
function ReadmeLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const safe = href?.startsWith("/") ? href : safeExternalUrl(href ?? null);
  if (!safe) return <span>{children}</span>;
  return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/**
 * Async server section: only the README waits for GitHub, while the rest of the detail page streams.
 * 앞부분만 싣는다(readme-preview.ts) — 잘렸으면 상자 끝에서 원문으로 잇는다.
 */
export async function ReadmeSection({ product, readmeExcerpt }: Props) {
  if (!product.repoUrl || product.repoGone) return null;
  const t = await getTranslator(await getRequestLocale(), "detail");
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
    return <ReadmeLink href={href}>{props.children}</ReadmeLink>;
  };
  const preview = readmePreview(readme.markdown);
  return (
    <section aria-labelledby="readme-title" className="flex flex-col gap-3">
      <h2 id="readme-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2">README</h2>
      <div role="region" aria-label={t("readme.body")} tabIndex={0} lang={englishLang(readme.markdown)}
        className={`${scrollClass} space-y-3 [&_a]:font-medium [&_a]:text-accent-ink [&_a:hover]:underline [&_h1]:mt-5 [&_h1]:text-[20px] [&_h1]:font-semibold [&_h2]:mt-5 [&_h2]:text-[18px] [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:text-[16px] [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ol>li]:list-decimal [&_p]:my-3 [&_pre]:whitespace-pre-wrap [&_pre]:rounded-lg [&_pre]:bg-bg-soft [&_pre]:p-3 [&_pre]:text-[13px] [&_table]:w-full [&_table]:table-fixed [&_td]:border [&_td]:border-line [&_td]:p-2 [&_th]:border [&_th]:border-line [&_th]:p-2`}>
        {readme.markdown.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={{ a: link, img: () => null }}>
          {preview.markdown}
        </ReactMarkdown> : <p className="m-0 text-fg-2">{t("readme.empty")}</p>}
        {preview.truncated && <p className="m-0 border-t border-line pt-3 text-[13px] text-fg-2">
          {t("readme.truncated")} <a href={readme.sourceUrl} target="_blank" rel="noopener noreferrer">{t("readme.full")} ↗</a>
        </p>}
      </div>
      <OriginalLink url={readme.sourceUrl} label={t("readme.full")} />
    </section>
  );
}
