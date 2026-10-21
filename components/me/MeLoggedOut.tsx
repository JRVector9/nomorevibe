import Link from "next/link";
import { Suspense } from "react";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import { MeIcon } from "./MeIcon";
import { MeLoginLink } from "./MeLoginLink";

const BENEFITS = [["sync", "sync"], ["check", "tried"], ["bell", "follow"], ["user", "maker"]] as const;

/**
 * 로그아웃 상태의 머리 — 막는 벽이 아니다. 아래 탭과 이 브라우저의 저장·평가 목록(저장·써봤어요 탭)은 그대로 보이고,
 * 여기서는 로그인하면 무엇이 더 되는지만 적는다(시안 3.7). 로그인 기능이 꺼져 있으면 로그인 단추를 감춘다.
 */
export function MeLoggedOut({ locale, t, loginEnabled }: { locale: Locale; t: Translator<"me">; loginEnabled: boolean }) {
  const fallback = localePath(locale, `/login?returnTo=${encodeURIComponent(localePath(locale, "/me"))}`);
  return (
    <section className="me-out" aria-labelledby="me-out-title">
      <div className="me-out-l">
        <p className="me-kicker">{t("page.title")}</p>
        <h2 id="me-out-title" className="me-out-h">{t("out.title")}</h2>
        <p className="me-out-p">{t("out.body")}</p>
        {loginEnabled ? (
          <div className="me-out-acts">
            <Suspense fallback={<a className="me-btn me-btn-pri me-btn-lg" href={fallback}>{t("out.cta")}</a>}>
              <MeLoginLink className="me-btn me-btn-pri me-btn-lg">{t("out.cta")}</MeLoginLink>
            </Suspense>
            <Link prefetch={false} className="me-link" href={localePath(locale, "/")}>{t("out.continue")}</Link>
          </div>
        ) : <p className="me-aside" role="status">{t("out.unavailable")}</p>}
      </div>
      <ul className="me-ben">
        {BENEFITS.map(([icon, key]) => (
          <li key={key}>
            <span className="me-ben-ic"><MeIcon name={icon} /></span>
            <span><b>{t(`out.benefit.${key}.title`)}</b><small>{t(`out.benefit.${key}.body`)}</small></span>
          </li>
        ))}
      </ul>
    </section>
  );
}
