"use client";

import Link from "next/link";
import { metricHref, type BrowseState } from "@/components/home/browse-state";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";

import type { HomePulse } from "@/lib/domain/products/home-pulse";

/**
 * 히어로 대신 한 줄 — 타이틀과 숫자. 숫자를 누르면 집계 기준이 열린다.
 *
 * '공개'는 아래 목록의 '공개 n개'와 같은 값(지금 세는 공개 수)을 받는다 — 같은 화면에 공개 수가 둘이면 안 된다(UX-27).
 * 이번 주 두 수는 어제 자정에 닫힌 7일로 센다 — 그 기준을 줄 끝에 밝힌다(날짜와 KST 는 집계 기준 창에서).
 *
 * 타이틀 아래 부제 한 줄 — 무엇을 어디서 모았고 표시가 무엇을 뜻하는지(UX-06). 약속은 실제와 맞춘다: 목록은 공개 저장소에서
 * 찾아 모은 것이고, 'AI'는 저장소에 남은 AI 코딩 도구 흔적에서, ✓는 메이커가 도메인 소유권을 확인한 곳에만 붙는다.
 * 자세한 수집·근거·내려달라는 요청은 게재 기준(/policy)이 맡는다.
 */
export function IntroLine({ pulse, total, state }: { pulse: HomePulse; total: number; state: BrowseState }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  return (
    <section className="intro-line" aria-label={t("intro.label")}>
      <div className="intro-head">
        <h1 className="intro-title">{t("intro.titleLead")}<em>{t("intro.titleFocus")}</em>{t("intro.titleTail")}</h1>
        <p className="intro-sub">
          {t("intro.note")}{" "}
          <Link prefetch={false} href={localePath(locale, "/policy#listing")}>{t("intro.selection")}</Link>
        </p>
      </div>
      <p className="intro-stats">
        {t("intro.public")} <b>{count(total)}</b>
        {" · "}<Link prefetch={false} href={metricHref(state, "born", locale)}>{t("intro.new")} <b>{count(pulse.born.current)}</b></Link>
        {" · "}<Link prefetch={false} href={metricHref(state, "updates", locale)}>{t("intro.updates")} <b>{count(pulse.updates.projects)}</b></Link>
        {" · "}{t("intro.week")}
      </p>
    </section>
  );
}
