"use client";
/* eslint-disable @next/next/no-img-element -- 배지 SVG·공유 카드 PNG 는 우리 주소가 그때그때 그리는 그림이라 next/image 최적화 대상이 아니다 */

import "./share-kit.css";
import { useRef, useState } from "react";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";

type Variant = "listed" | "tried";
type BadgeLang = "en" | "ko";
type StatusKey = "share.copied" | "share.linkCopied" | "share.copyFailed";
const VARIANTS: Variant[] = ["listed", "tried"];
const LANGS: BadgeLang[] = ["en", "ko"];

/**
 * 배지·공유 카드 복사(MY8) — 내 프로젝트 탭(MY5)이 프로젝트마다 그린다(SNS 설계 T12·T13, 시안 M5).
 * 배지 주소는 그대로(/badge/<slug>.svg) 두고 종류·글자만 뒤에 붙인다. 복사가 안 되는 브라우저에서는 글자를 골라 두어 직접 복사하게 한다.
 * 배지 링크에는 ?via=badge, 공유 링크에는 ?via=share 를 붙인다(유입 분류는 순위 설계에서). 두 링크 모두 지금 화면의 언어 주소다 —
 * 앞붙이기 없는 주소는 한국어로 열린다(proxy.ts). 카드 그림 주소에는 version(소개를 고친 시각)을 붙여, 고치면 브라우저·CDN 이 새 그림을 받는다.
 * 써봤어요를 끄면(tried=false) «써본 사람 수» 배지는 고르지 않는다.
 * README 에 붙일 절대 주소(origin)는 서버가 넘긴다 — NEXT_PUBLIC_SITE_URL 은 운영 이미지 빌드 때 비어 있어, 브라우저에서 읽으면
 * 서버가 그린 주소와 달라 하이드레이션이 깨진다(React #418).
 */
export function ShareKit({ slug, name, origin, version, tried = true }: { slug: string; name: string; origin: string; version?: string; tried?: boolean }) {
  const t = useTranslations("me");
  const locale = useLocale();
  const [picked, setVariant] = useState<Variant>("listed");
  const variant: Variant = tried ? picked : "listed";
  const [lang, setLang] = useState<BadgeLang>("en");
  const [status, setStatus] = useState<StatusKey | "">("");
  const markdownRef = useRef<HTMLPreElement>(null);
  const htmlRef = useRef<HTMLPreElement>(null);
  const linkRef = useRef<HTMLElement>(null);

  const query = new URLSearchParams({ ...(variant === "tried" ? { style: "tried" } : {}), ...(lang === "ko" ? { lang: "ko" } : {}) }).toString();
  const badgePath = `/badge/${encodeURIComponent(slug)}.svg${query ? `?${query}` : ""}`;
  const badgeLink = `${origin}${localePath(locale, `/p/${encodeURIComponent(slug)}`)}?via=badge`;
  const markdown = `[![nomorevibe](${origin}${badgePath})](${badgeLink})`;
  const html = `<a href="${badgeLink}"><img src="${origin}${badgePath}" alt="nomorevibe" height="20"></a>`;
  const cardPath = localePath(locale, `/p/${encodeURIComponent(slug)}/share-card.png${version ? `?v=${encodeURIComponent(version)}` : ""}`);
  const shareLink = `${origin}${localePath(locale, `/p/${encodeURIComponent(slug)}`)}?via=share`;

  async function copy(text: string, target: HTMLElement | null, done: StatusKey) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(done);
    } catch {
      // 복사 권한이 없거나 http 주소다 — 글자를 골라 두고 직접 복사하라고 말한다
      if (target) window.getSelection()?.selectAllChildren(target);
      setStatus("share.copyFailed");
    }
  }

  return (
    <section className="me-share" aria-label={t("share.title")}>
      <h3 className="me-share-h">{t("share.badge")}</h3>
      <div className="me-share-opts">
        {tried && (
          <span className="me-share-seg" role="group" aria-label={t("share.variantLabel")}>
            {VARIANTS.map((value) => <button key={value} type="button" aria-pressed={variant === value} onClick={() => setVariant(value)}>{t(`share.variant.${value}`)}</button>)}
          </span>
        )}
        <span className="me-share-seg" role="group" aria-label={t("share.langLabel")}>
          {LANGS.map((value) => <button key={value} type="button" aria-pressed={lang === value} onClick={() => setLang(value)}>{t(`share.lang.${value}`)}</button>)}
        </span>
      </div>
      <div className="me-share-badge"><img src={badgePath} alt={t("share.badgeAlt", { name })} height={20} /></div>
      <p className="me-share-note">{t(`share.variantNote.${variant}`)}</p>
      {([["markdown", markdown, markdownRef], ["html", html, htmlRef]] as const).map(([format, code, ref]) => (
        <div className="me-share-code" key={format}>
          <div className="me-share-code-h">
            <span>{t(`share.${format}`)}</span>
            <button type="button" className="me-share-btn" aria-label={t("share.copyCode", { format: t(`share.${format}`) })}
              onClick={() => void copy(code, ref.current, "share.copied")}>{t("share.copy")}</button>
          </div>
          <pre ref={ref} tabIndex={0}>{code}</pre>
        </div>
      ))}
      <h3 className="me-share-h">{t("share.card")}</h3>
      <a className="me-share-card" href={cardPath} target="_blank" rel="noopener">
        <img src={cardPath} alt={t("share.cardAlt", { name })} width={1200} height={630} loading="lazy" />
      </a>
      <p className="me-share-note">{t("share.cardNote")}</p>
      <code className="me-share-link" ref={linkRef}>{shareLink}</code>
      <div className="me-share-acts">
        <button type="button" className="me-share-btn pri" onClick={() => void copy(shareLink, linkRef.current, "share.linkCopied")}>{t("share.copyLink")}</button>
        <a className="me-share-btn" href={cardPath} target="_blank" rel="noopener">{t("share.openImage")}</a>
      </div>
      <p className="me-share-status" role="status">{status ? t(status) : ""}</p>
    </section>
  );
}
