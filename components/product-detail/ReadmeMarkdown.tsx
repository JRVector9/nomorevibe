"use client";

import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { safeExternalUrl } from "./format";

/**
 * README 앞부분 그리기 — 상세 README 상자가 전문을 받은 뒤에만 불러오는 조각(첫 로드 JS 에 넣지 않는다).
 * 예전 서버 구획(ReadmeSection)과 같은 규칙: HTML 은 그리지 않고(skipHtml)·소독하고, 그림은 빼고,
 * 상대 주소는 저장소 기본 가지 기준으로 풀고, 바깥 http(s)·루트 상대 주소만 링크로 남긴다.
 */
function ReadmeLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const safe = href?.startsWith("/") ? href : safeExternalUrl(href ?? null);
  if (!safe) return <span>{children}</span>;
  return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export function ReadmeMarkdown({ markdown, sourceUrl, repositoryRootUrl }: { markdown: string; sourceUrl: string; repositoryRootUrl: string }) {
  const link = (props: ComponentPropsWithoutRef<"a">) => {
    let href: string | undefined;
    try {
      const rootRelative = props.href?.startsWith("/") && !props.href.startsWith("//");
      href = props.href ? rootRelative
        ? new URL(`.${props.href}`, repositoryRootUrl).href
        : new URL(props.href, sourceUrl).href : undefined;
    } catch { /* Render unsafe links as text. */ }
    return <ReadmeLink href={href}>{props.children}</ReadmeLink>;
  };
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={{ a: link, img: () => null }}>{markdown}</ReactMarkdown>;
}
