import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { CONTACT_EMAIL, pageTitle } from "@/lib/copy/brand";
import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator } from "@/lib/i18n/dictionary";
import { localePath } from "@/lib/i18n/routing";
import { localizedAlternates, localizedOpenGraph } from "@/lib/i18n/metadata";
import { DEFAULT_SHARE_IMAGE, shareMetadata } from "@/lib/copy/share";
import { AnalyticsOptOut } from "@/components/analytics/AnalyticsOptOut";
import { analyticsEnabled } from "@/lib/analytics/config";

/**
 * 게재 기준(2026-10-08 UX 감사 UX-21, 2026-10-09 운영자 결정 D1·D2·D5).
 *
 * 푸터 '게재 기준'과 상세의 요청 폼·운영자 상자가 아래 앵커로 보낸다 — #listing #ai-evidence #excluded #unclaimed #takedown #contact.
 * 앵커 이름을 바꾸면 그 링크들이 맨 위로 떨어진다.
 *
 * 문구는 지금 돌고 있는 규칙을 옮긴 것이다. 규칙을 바꾸면 여기도 고친다.
 * - 올리는 것·빼는 것: AI 심사 지침(lib/crawl/agent-review.ts REVIEW_SYSTEM_PROMPT)과 설치형 기준(lib/domain/products/access.ts),
 *   스팸 재검사(jobs/products/spam-rescan.ts), 닿지 않는 제품 가리기(repository.ts notDown)
 * - 개인 프로필: 기본 목록에서 가림(visibility.ts), 색인은 본인 확인 뒤(indexing.ts)
 * - AI 근거와 색인: indexing.ts 4번 — 흔적은 사용 주장이지 실행 증명이 아니다(상세 '무엇으로 만들었나'와 같은 말)
 * - 내려달라는 요청: 접수 즉시 noindex(indexing.ts 2번), 24시간 안 확인(takedown-view.ts TAKEDOWN_OVERDUE_HOURS)
 * 공개 연락처는 CONTACT_EMAIL 하나다(2026-10-22 사용자 결정으로 D5 의 "공개 이메일 없음"을 바꿈 — Bluesky 개발자 지침 5).
 * SNS 화제·자료 출처·삭제 요청·신고를 받고, 프로젝트에 관한 요청은 그대로 사이트 안의 요청 폼으로 받는다.
 * - 방문 분석(#analytics, 2026-10-22): 모으는 것·목적·처리자·보관·끄는 법. 실제 규칙은 lib/analytics(events·sanitize·consent)와
 *   docs/operations/2026-10-22-google-analytics.md — 보내는 이벤트나 보관 기간을 바꾸면 여기도 고친다.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "policy");
  const title = pageTitle(t("metadata.title")), description = t("metadata.description");
  const share = shareMetadata({ title, description, image: { ...DEFAULT_SHARE_IMAGE, alt: title } });
  return { ...share, title, description,
    robots: { index: true, follow: true }, alternates: localizedAlternates(locale, "/policy"),
    openGraph: { ...share.openGraph, ...localizedOpenGraph(locale) } };
}

export default async function PolicyPage() {
  // 요청 때 그린다 — 정적으로 굳히면 헤더(검색어를 읽는다)가 서버 HTML 에서 빠졌다가 브라우저에서 끼어든다
  await connection();
  const locale = await getRequestLocale();
  const [t, labels] = await Promise.all([getTranslator(locale, "policy"), getTranslator(locale, "labels")]);
  const unclaimedLabel = labels("status.unclaimed");
  const sections = [
    { id: "listing", title: t("listing.title") },
    { id: "ai-evidence", title: t("evidence.title") },
    { id: "excluded", title: t("excluded.title") },
    { id: "unclaimed", title: unclaimedLabel },
    { id: "takedown", title: t("takedown.title") },
    { id: "analytics", title: t("analytics.title") },
    { id: "contact", title: t("contact.title") },
  ];

  return (
    <main className="mx-auto max-w-[760px] px-6 pb-20 pt-10 text-[15px] leading-[1.75] text-fg">
      <h1 className="text-[28px] font-semibold tracking-tight">{t("heading")}</h1>
      <p className="mt-2 text-fg-2">
        {t("intro")}
      </p>
      <nav aria-label={t("toc")} className="mt-5 flex flex-wrap gap-x-4 text-[14px]">
        {sections.map((section) => (
          <a key={section.id} href={`#${section.id}`} className="inline-flex min-h-11 items-center text-accent-ink underline-offset-4 hover:underline">
            {section.title}
          </a>
        ))}
      </nav>

      <Section id="listing" title={t("listing.title")}>
        <p>{t("listing.intro")}</p>
        <ul>
          <li>
            {t("listing.makerBefore")}<code>/nomorevibe</code>{t("listing.makerAfter")}
            <Link href={localePath(locale, "/launch")} className="text-accent-ink underline underline-offset-4">{t("listing.launchLink")}</Link>
          </li>
          <li>{t("listing.discovered")}</li>
        </ul>
        <p>{t("listing.examples")}</p>
        <ul>
          <li>{t("listing.web")}</li>
          <li>{t("listing.apps")}</li>
          <li>{t("listing.extensions")}</li>
          <li>{t("listing.libraries")}</li>
          <li>{t("listing.games")}</li>
        </ul>
        <p>
          {t("listing.repoOnly")}
        </p>
      </Section>

      <Section id="ai-evidence" title={t("evidence.title")}>
        {/* 공개 화면은 단계 없이 'AI' 표시 하나, 근거 링크는 내지 않는다(2026-10-10 D3·10-11 운영자 결정) — 규칙: lib/domain/evidence/ai-level.ts */}
        <p>
          {t("evidence.found")}
        </p>
        <p>
          {t("evidence.limit", { label: unclaimedLabel })}
        </p>
      </Section>

      <Section id="excluded" title={t("excluded.title")}>
        <ul>
          <li>{t("excluded.spam")}</li>
          <li>
            {t("excluded.notSoftware")}
          </li>
          <li>
            {t("excluded.profile")}
          </li>
        </ul>
        <p>{t("excluded.unreachable")}</p>
      </Section>

      <Section id="unclaimed" title={t("unclaimed.title", { label: unclaimedLabel })}>
        <p>
          {labels("status.unclaimedHint")}{" "}{t("unclaimed.details")}
        </p>
        <p>
          {t("unclaimed.confirmBefore")}<code>/nomorevibe verify</code>{t("unclaimed.confirmAfter")}
          <Link href={localePath(locale, "/launch#verify")} className="text-accent-ink underline underline-offset-4">{t("unclaimed.verifyLink")}</Link>
        </p>
      </Section>

      <Section id="takedown" title={t("takedown.title")}>
        <p>{t("takedown.intro")}</p>
        <ul>
          <li>{t("takedown.immediate")}</li>
          <li>{t("takedown.withinDay")}</li>
          <li>{t("takedown.misuse")}</li>
        </ul>
      </Section>

      <Section id="analytics" title={t("analytics.title")}>
        <p>{t("analytics.intro")}</p>
        <p>{t("analytics.collected")}</p>
        <ul>
          <li>{t("analytics.pages")}</li>
          <li>{t("analytics.clicks")}</li>
          <li>{t("analytics.search")}</li>
          <li>{t("analytics.launch")}</li>
          <li>{t("analytics.device")}</li>
        </ul>
        <p>{t("analytics.notCollected")}</p>
        <p>{t("analytics.purpose")}</p>
        <p>{t("analytics.cookies")}</p>
        <p>{t("analytics.retention")}</p>
        <p>{t("analytics.optOut")}</p>
        {/* 이 브라우저의 상태와 끄기·다시 켜기 — 브라우저에서만 그린다 */}
        <AnalyticsOptOut variant="policy" enabled={analyticsEnabled()} />
        <p>{t("analytics.contact")}</p>
      </Section>

      <Section id="contact" title={t("contact.title")}>
        <p>
          {t("contact.before")}<code>/nomorevibe verify</code>{t("contact.after")}
        </p>
        <p>
          {t("contact.correction")}
        </p>
        <p>
          {t("contact.emailBefore")}<a href={`mailto:${CONTACT_EMAIL}`} className="text-accent-ink underline underline-offset-4">{CONTACT_EMAIL}</a>{t("contact.emailAfter")}
        </p>
      </Section>
    </main>
  );
}

/** 앵커 구획 — 고정 헤더에 제목이 가리지 않게 위를 띄운다 */
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-10 scroll-mt-20 [&_code]:font-mono [&_code]:text-[14px] [&_code]:font-semibold [&_li]:mt-1.5 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
      <h2 id={`${id}-title`} className="text-[19px] font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
