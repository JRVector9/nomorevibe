"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { ReadmeResponse } from "@/lib/domain/products/readme-response";
import { englishLang } from "@/lib/i18n/content-language";
import { useTranslations } from "@/lib/i18n/context";
import { safeExternalUrl } from "./format";
import { README_BODY, README_LINK } from "./readme-style";

type Renderer = ComponentType<{ markdown: string; sourceUrl: string; repositoryRootUrl: string }>;
type Loaded = { data: ReadmeResponse | null; Markdown: Renderer | null };

function OriginalLink({ url, label }: { url: string; label: string }) {
  return <a href={url} target="_blank" rel="noopener noreferrer" className={README_LINK}>{label} ↗</a>;
}

/**
 * README 전문 — 서버가 그린 발췌(children)를 먼저 보이고, 같은 출처 API(/api/products/[slug]/readme)로 앞부분을 받아 바꿔 그린다
 * (2026-11-15 사람 결정). 전문은 서버 HTML·RSC 데이터에 없다. 받는 동안은 발췌 그대로 aria-busy, 못 받으면 발췌와 원문 링크를 남긴다.
 */
export function ReadmeLoader({ slug, fallbackUrl, children }: { slug: string; fallbackUrl: string; children?: ReactNode }) {
  const t = useTranslations("detail");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await fetch(`/api/products/${encodeURIComponent(slug)}/readme`, { headers: { accept: "application/json" } })
        .then((response) => response.ok ? response.json() as Promise<ReadmeResponse> : null).catch(() => null);
      const Markdown = data?.state === "available" && !data.empty
        ? await import("./ReadmeMarkdown").then((module) => module.ReadmeMarkdown).catch(() => null) : null;
      if (alive) setLoaded({ data, Markdown });
    })();
    return () => { alive = false; };
  }, [slug]);

  if (!loaded) {
    return <div aria-busy="true" className="flex flex-col gap-3">
      {children ?? <div aria-hidden="true" className="flex max-w-[720px] flex-col gap-2 motion-safe:animate-pulse">
        {[0, 1, 2].map((index) => <div key={index} className={`h-4 rounded bg-bg-soft ${index === 2 ? "w-2/3" : "w-full"}`} />)}
      </div>}
      <OriginalLink url={fallbackUrl} label={t("readme.full")} />
    </div>;
  }
  const { data, Markdown } = loaded;
  if (data?.state === "available" && (data.empty || Markdown)) {
    return <>
      <div role="region" aria-label={t("readme.body")} tabIndex={0} lang={englishLang(data.markdown)} className={README_BODY}>
        {Markdown ? <Markdown markdown={data.markdown} sourceUrl={data.sourceUrl} repositoryRootUrl={data.repositoryRootUrl} />
          : <p className="m-0 text-fg-2">{t("readme.empty")}</p>}
        {data.truncated && <p className="m-0 border-t border-line pt-3 text-[13px] text-fg-2">
          {t("readme.truncated")} <a href={data.sourceUrl} target="_blank" rel="noopener noreferrer">{t("readme.full")} ↗</a>
        </p>}
      </div>
      <OriginalLink url={data.sourceUrl} label={t("readme.full")} />
    </>;
  }
  const sourceUrl = data && data.state !== "none" && data.state !== "available" ? safeExternalUrl(data.sourceUrl) : null;
  return <>
    <p className="m-0 text-[13px] leading-6 text-fg-2">
      {data?.state === "too_large" ? t("readme.tooLarge") : t("readme.unavailable")}
      {children ? ` ${t("readme.excerptNote")}` : ""}
    </p>
    {children}
    <OriginalLink url={sourceUrl ?? fallbackUrl} label={t("readme.full")} />
  </>;
}
