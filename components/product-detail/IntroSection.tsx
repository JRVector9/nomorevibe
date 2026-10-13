import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { englishLang } from "@/lib/i18n/content-language";
import { getTranslator } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { safeExternalUrl } from "./format";

export function SafeMarkdownLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const safe = href?.startsWith("/") ? href : safeExternalUrl(href ?? null);
  if (!safe) return <span>{children}</span>;
  return <a href={safe} target="_blank" rel="noopener noreferrer" className="font-medium text-accent-ink hover:underline">{children}</a>;
}

function Heading({ id, children }: { id: string; children: ReactNode }) {
  return <h2 className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-2"><span id={id}>{children}</span></h2>;
}

/**
 * 소개 — 설명이 한 줄 소개와 다를 때만 설명을, 그다음 README 서버 구획(없으면 저장된 발췌)을.
 * 메이커 프로필(문제·사용자·기능·활용)은 있을 때만 그 아래.
 * 설명·README 발췌가 영어 원문이면 lang="en" 을 단다(A11Y-06) — 스크린리더가 한국어 규칙으로 읽지 않게.
 */
export async function IntroSection({ product, profile, readmeExcerpt, unclaimed, children }: {
  product: ProductDetailView["product"];
  profile: ProductDetailView["profile"];
  readmeExcerpt: string | null;
  unclaimed: boolean;
  children?: ReactNode;
}) {
  const locale = await getRequestLocale();
  const [t, labels] = await Promise.all([getTranslator(locale, "detail"), getTranslator(locale, "labels")]);
  // 수집 발행분은 설명이 없으면 소개를 그대로 쓴다 — 히어로의 한 줄을 여기서 되풀이하지 않는다
  const originalDescription = product.description.trim() !== product.tagline.trim() ? product.description : null;
  const selected = product.descriptionTranslation;
  const description = originalDescription && (selected?.ready ? selected.text : originalDescription);
  const repo = product.repoUrl ? safeExternalUrl(product.repoUrl) : null;
  const hasProfile = profile && (profile.problem || profile.targetUsers || profile.privacySummary
    || profile.keyFeatures.length > 0 || profile.useCases.length > 0 || profile.longDescriptionMarkdown);
  return (
    <div className="flex flex-col gap-9">
      <section aria-labelledby="intro-title" className="flex flex-col gap-3">
        <Heading id="intro-title">{t("intro.title")}</Heading>
        {description
          ? <p lang={selected?.lang ?? englishLang(description)} className="m-0 max-w-[720px] whitespace-pre-line text-[17px] leading-[1.6] text-fg">{description}</p>
          : !readmeExcerpt && (
            <p className="m-0 max-w-[720px] text-[14px] leading-[1.5] text-fg-2">
              {t("intro.onlyTagline")}
              {repo && <> {t("intro.moreReadme")} <a href={repo} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline underline-offset-2">{t("intro.readmeLink")} ↗</a></>}
            </p>
          )}
        {description && selected?.translated && selected.provenance === "machine" && <p className="m-0 text-[13px] text-fg-2">{labels("content.machineTranslation")}</p>}
        {description && selected?.pending && <p role="status" className="m-0 text-[13px] text-fg-2">{labels("content.pending")}</p>}
        {description && selected?.translated && originalDescription && <details className="text-[13px] text-fg-2"><summary className="min-h-11 cursor-pointer">{labels("content.original")}</summary><p lang={selected.sourceLocale ?? englishLang(originalDescription)} className="whitespace-pre-line">{originalDescription}</p></details>}
        {description && <p className="m-0 text-[13px] text-fg-2">{unclaimed ? t("source.readme") : t("source.maker")}</p>}
      </section>
      {children ?? (readmeExcerpt && (
        <section aria-labelledby="readme-title" className="flex flex-col gap-3">
          <Heading id="readme-title">{t("intro.readmeFrom")}</Heading>
          <blockquote lang={englishLang(readmeExcerpt)} className="m-0 max-w-[720px] whitespace-pre-line border-l-2 border-line pl-[18px] text-[15px] leading-[1.6] text-fg">{readmeExcerpt}</blockquote>
          {repo && <a href={repo} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center self-start text-[13px] text-accent-ink hover:underline">{t("readme.full")} ↗</a>}
        </section>
      ))}
      {profile && hasProfile && (
        <section aria-labelledby="profile-title" className="flex flex-col gap-4">
          <Heading id="profile-title">{t("intro.profile")}</Heading>
          {(profile.problem || profile.targetUsers || profile.privacySummary) && (
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              {profile.problem && <div><dt className="text-[13px] font-semibold text-fg">{t("intro.problem")}</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.problem}</dd></div>}
              {profile.targetUsers && <div><dt className="text-[13px] font-semibold text-fg">{t("intro.users")}</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.targetUsers}</dd></div>}
              {profile.privacySummary && <div className="sm:col-span-2"><dt className="text-[13px] font-semibold text-fg">{t("intro.privacy")}</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.privacySummary}</dd></div>}
            </dl>
          )}
          {(profile.keyFeatures.length > 0 || profile.useCases.length > 0) && (
            <div className="grid gap-6 sm:grid-cols-2">
              {profile.keyFeatures.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">{t("intro.features")}</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.keyFeatures.map((item) => <li key={item}>{item}</li>)}</ul></div>}
              {profile.useCases.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">{t("intro.useCases")}</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.useCases.map((item) => <li key={item}>{item}</li>)}</ul></div>}
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
