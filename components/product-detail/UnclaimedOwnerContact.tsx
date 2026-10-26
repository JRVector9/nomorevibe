"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import Link from "next/link";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { TakedownForm } from "@/app/(public)/[locale]/(content)/p/[slug]/TakedownForm";
import { trackAttrs } from "@/lib/analytics/attrs";
import { GithubOwnershipClaim } from "./GithubOwnershipClaim";

/** 글 속 링크 — 색만으로 가려지지 않게 밑줄을 늘 긋는다(A11Y-03) */
const LINK = "text-accent-ink underline underline-offset-2";

/**
 * 운영자 상자 — 막다른 안내가 되지 않게 다음 걸음을 링크로 준다(2026-10-08 UX 감사 UX-18).
 *
 * 개인 저장소는 GitHub 숫자 ID·기존 저장소 ID 를 맞추는 공개 운영자 확인 API 를 쓴다.
 * 웹사이트의 도메인 확인도 남긴다. 조직 저장소는 GitHub 로그인만으로 확인하지 않는다.
 */
export function UnclaimedOwnerContact({ productId, repoUrl, slug, installable = false, authEnabled = true, githubEnabled = true }: {
  productId: number; repoUrl: string | null; slug: string; installable?: boolean; authEnabled?: boolean; githubEnabled?: boolean;
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  if (!githubOwnerFromRepositoryUrl(repoUrl)) return null;

  return (
    <section id="owner-claim" className="scroll-mt-24 rounded-[18px] border border-line p-5 [&_summary]:flex [&_summary]:min-h-11 [&_summary]:items-center">
      <h2 className="text-[14px] font-semibold text-fg">{t("owner.title")}</h2>
      {authEnabled && githubEnabled && <p className="mt-1 text-[13px] leading-5 text-fg-2">{t("owner.github")}</p>}
      <GithubOwnershipClaim key={productId} productId={productId} slug={slug} authEnabled={authEnabled} githubEnabled={githubEnabled} />
      {installable ? (
        authEnabled && <>
          <p className="mt-1 text-[13px] leading-5 text-fg-2">
            {t("owner.installable")}
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-[13px] leading-5 text-fg-2">
            {t("owner.verify", { command: "/nomorevibe verify" })}
          </p>
          <Link prefetch={false} href={localePath(locale, "/launch#verify")} {...trackAttrs("claim_start", { product_slug: slug, step: "verify" })}
            className="mt-3 inline-flex min-h-11 items-center rounded-full bg-bg-soft px-5 text-[14px] font-medium text-fg">
            {t("owner.verifyLink")}
          </Link>
        </>
      )}
      <p className="mt-2 text-[13px] leading-5 text-fg-2">
        <Link prefetch={false} href={localePath(locale, "/policy#contact")} className={LINK}>{t("owner.contact")}</Link>
      </p>
      <TakedownForm slug={slug} />
    </section>
  );
}
