import { englishLang } from "@/lib/i18n/content-language";
import type { Translator } from "@/lib/i18n/messages";
import { safeExternalUrl } from "./format";
import { ReadmeLoader } from "./ReadmeLoader";
import { README_HEADING, README_SCROLL } from "./readme-style";

/**
 * 상세 README 구획(2026-11-15 사람 결정) — 서버 HTML 에는 README 앞부분 발췌(몇 문장, readme-excerpt.ts shortReadmeExcerpt)만
 * 화면 글자로 남긴다. JS 를 실행하지 않는 검색·AI 답변 봇도 README 핵심 글자로 상세를 찾는다.
 * 전문은 브라우저가 같은 출처 API 로 불러와 바꿔 그린다(ReadmeLoader) — 서버 HTML·RSC 데이터에 전문은 없다.
 * 발췌는 서버 부품이 글자로만 그린다 — 브라우저 부품 속성(JSON)으로 한 번 더 싣지 않는다.
 */
export function ReadmeExcerptSection({ slug, repoUrl, repoGone, excerpt, t }: {
  slug: string;
  repoUrl: string | null;
  repoGone?: boolean;
  excerpt: string | null;
  t: Translator<"detail">;
}) {
  const repo = repoUrl ? safeExternalUrl(repoUrl) : null;
  if (!repo || repoGone) return null;
  return (
    <section aria-labelledby="readme-title" className="flex flex-col gap-3">
      <h2 id="readme-title" className={README_HEADING}>README</h2>
      <ReadmeLoader slug={slug} fallbackUrl={`${repo}#readme`}>
        {excerpt && <blockquote data-readme-excerpt="" role="region" aria-label={t("readme.excerpt")} tabIndex={0} lang={englishLang(excerpt)}
          className={`m-0 whitespace-pre-wrap ${README_SCROLL}`}>{excerpt}</blockquote>}
      </ReadmeLoader>
    </section>
  );
}
