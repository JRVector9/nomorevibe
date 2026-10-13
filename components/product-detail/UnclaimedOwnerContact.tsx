"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import Link from "next/link";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { TakedownForm } from "@/app/(public)/[locale]/(content)/p/[slug]/TakedownForm";

/** 글 속 링크 — 색만으로 가려지지 않게 밑줄을 늘 긋는다(A11Y-03) */
const LINK = "text-accent-ink underline underline-offset-2";

/**
 * 운영자 상자 — 막다른 안내가 되지 않게 다음 걸음을 링크로 준다(2026-10-08 UX 감사 UX-18).
 *
 * 웹사이트는 '1분 만에 확인하기'가 설치 → verify 순서를 적은 /launch#verify 로 보낸다. 설치형은 배포 도메인이 없어
 * 명령으로 확인할 수 없으므로(verify.ts) 사이트 안 요청 폼(/policy#contact)으로 보낸다 — 공개 이메일은 두지 않는다(D5).
 * CLI 를 쓰지 않는 운영자의 GitHub 로그인 확인은 아직 없다(D6) — 준비 중이라고 한 줄로만 말하고 누를 것을 만들지 않는다.
 */
export function UnclaimedOwnerContact({ repoUrl, slug, installable = false }: { repoUrl: string | null; slug: string; installable?: boolean }) {
  const t = useTranslations("detail");
  const locale = useLocale();
  if (!githubOwnerFromRepositoryUrl(repoUrl)) return null;

  return (
    <section className="rounded-[18px] border border-line p-5 [&_summary]:flex [&_summary]:min-h-11 [&_summary]:items-center">
      <h2 className="text-[14px] font-semibold text-fg">{t("owner.title")}</h2>
      {installable ? (
        <>
          <p className="mt-1 text-[13px] leading-5 text-fg-2">
            {t("owner.installable")}
          </p>
          <Link prefetch={false} href={localePath(locale, "/policy#contact")}
            className="mt-3 inline-flex min-h-11 items-center rounded-full bg-bg-soft px-5 text-[14px] font-medium text-fg">
            {t("owner.contact")}
          </Link>
          <p className="mt-2 text-[13px] leading-5 text-fg-2">{t("owner.githubSoon")}</p>
        </>
      ) : (
        <>
          <p className="mt-1 text-[13px] leading-5 text-fg-2">
            {t("owner.verify", { command: "/nomorevibe verify" })}
          </p>
          <Link prefetch={false} href={localePath(locale, "/launch#verify")}
            className="mt-3 inline-flex min-h-11 items-center rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white hover:opacity-90">
            {t("owner.verifyLink")}
          </Link>
          <p className="mt-2 text-[13px] leading-5 text-fg-2">
            {t("owner.noCli")} {" "}
            <Link prefetch={false} href={localePath(locale, "/policy#contact")} className={LINK}>{t("owner.contact")}</Link>
          </p>
        </>
      )}
      <TakedownForm slug={slug} />
    </section>
  );
}
