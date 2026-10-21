import Link from "next/link";
import { formatDate, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import { ME_SAVED_LINK, ME_TAB_PATHS } from "@/lib/me/contract";
import type { MeSummary } from "@/lib/me/summary";
import { MeAvatar } from "./MeAvatar";
import { MeSavedCount } from "./MeTabs";

const STATS = [["tried", "tried"], ["saved", "saved"], ["opinions", "opinions"], ["following", "following"]] as const;

/** 마이페이지 머리 — 아바타·닉네임·가입일·로그인 수단, 숫자 넷(누르면 그 탭). 휴대폰은 줄여 쌓는다 */
export function MeHead({ summary, locale, t, now, showTried = true }: { summary: MeSummary; locale: Locale; t: Translator<"me">; now: Date; showTried?: boolean }) {
  const { user, counts, providers, isMaker } = summary;
  return (
    <section className="me-head" aria-labelledby="me-name">
      <MeAvatar name={user.displayName} seed={user.id} size="l" />
      <div className="me-id">
        <div className="me-name-row">
          <h2 id="me-name" className="me-name">{user.displayName}</h2>
          <Link prefetch={false} className="me-link" href={localePath(locale, `${ME_TAB_PATHS.account}#profile`)}>{t("head.changeName")}</Link>
        </div>
        <p className="me-sub">
          <span>{t("head.joined", { date: formatDate(user.createdAt, now, locale) })}</span>
          {providers.map((provider, index) => (
            <span key={`${provider.provider}-${index}`} className="me-prov">
              <i aria-hidden="true">{provider.provider === "github" ? "gh" : "@"}</i>
              {provider.provider === "github" ? (provider.login ? t("head.github", { login: provider.login }) : t("head.githubPlain")) : t("head.email")}
            </span>
          ))}
          {isMaker && <span className="me-prov me-prov-maker">{t("head.maker")}</span>}
        </p>
      </div>
      <nav className="me-stats" aria-label={t("head.stats")}>
        {STATS.filter(([tab]) => showTried || tab !== "tried").map(([tab, key]) => (
          <Link key={tab} prefetch={false} className="me-stat" href={localePath(locale, tab === "saved" ? ME_SAVED_LINK : ME_TAB_PATHS[tab])}>
            <b>{key === "saved" ? <MeSavedCount initial={counts.saved} /> : formatNumber(counts[key], locale)}</b>
            <span>{t(`tabs.${tab}`)}</span>
          </Link>
        ))}
      </nav>
    </section>
  );
}
