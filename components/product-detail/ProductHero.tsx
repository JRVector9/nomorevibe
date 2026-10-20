"use client";

import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { translatedCategory } from "@/components/home/i18n";
import { IntroductionSource } from "@/components/home/IntroductionSource";
import { localePath } from "@/lib/i18n/routing";
import { formatNumber } from "@/lib/i18n/format";
import Link from "next/link";
import type { ReactNode } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { ProductTagline } from "@/components/ProductTagline";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { repositoryOperator } from "@/lib/domain/products/github-owner";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { InstallPrompt } from "./InstallPrompt";
import { SaveButton } from "./SaveButton";
import { ShareButton } from "./ShareButton";

/** 홈 '지금 뜨는'과 같은 순위 — 20위 안일 때만 배지 */
const RISING_BADGE_MAX = 20;

/** 단추 — 모바일(390px)에서 네 개가 한 줄에 들도록 좁은 화면은 글자·여백을 조금 줄인다 */
const BUTTON = "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-[14px] font-medium sm:px-5 sm:text-[15px]";

/** 오래된 확인은 온라인이라 하지 않고, 한 번 실패는 연속 실패 기준(down) 전까지 '불안정'이라 하지 않는다 */
function HealthStatus({ health }: { health: ProductDetailView["health"] }) {
  const t = useTranslations("detail");
  const now = useServerNow();
  const locale = useLocale();
  if (!health.checkedAt) return <span>{t("health.before")}</span>;
  if (!isHealthCurrent(health.checkedAt, now)) return <span>{t("health.recheck")}</span>;
  if (health.down) return <span className="text-down">{t("health.down")}</span>;
  if (health.lastCheckSucceeded === false) return <span className="text-down">{t("health.failed")}</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={health.latencyMs === null ? undefined : t("hero.latency", { ms: formatNumber(health.latencyMs, locale) })}>
      <i aria-hidden className="inline-block h-2 w-2 rounded-full bg-up" />
      {t("health.online")}
    </span>
  );
}

/**
 * 상세 머리 — 아이콘 80 · 이름 40 · 한 줄 소개 20 · 메타 한 줄 · 버튼.
 *
 * 큰 이미지는 두지 않는다: 공개 제품의 54%는 256px 아이콘뿐이고 스크린샷은 0이다(2026-10-02).
 * 넓은 이미지가 있으면 오른쪽 열의 PreviewFigure 가 작게 보여 준다.
 *
 * 단추는 [제품 방문하기][GitHub][공유][저장] 넷이다(UX-31). 같은 사이트로 가는 도메인 글자 링크는 뺐다 —
 * 사이트 주소는 정보 카드의 '웹사이트' 줄이 보여 준다.
 */
export function ProductHero({ product, unclaimed, risingRank, talkRank = null, health, languages, repositoryUrl = null, personalGithubStar, follow }: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  risingRank: number | null;
  /** SNS 화제 '지금' 순위(lib/social/talk.ts productTalk) — 화제 화면이 보일 때만 넘긴다 */
  talkRank?: number | null;
  health: ProductDetailView["health"];
  /** 저장소 언어 상위 둘 — RepositoryFacts.languages 에서 */
  languages: string[];
  /** GitHub 이 알려 준 저장소의 정식 주소(RepositoryFacts.repositoryUrl) — 운영 주체를 지금 주인으로 정한다(UX-15) */
  repositoryUrl?: string | null;
  personalGithubStar?: ReactNode;
  /** 팔로 단추 자리(마이페이지 MY4) — 단추 줄의 프로젝트, GitHub 주인 옆의 메이커 */
  follow?: { project: ReactNode; maker: ReactNode };
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const labels = useTranslations("labels");
  const owner = repositoryOperator(product.repoUrl, repositoryUrl)?.owner ?? null;
  const installable = product.accessMode === "installable";
  const safeIcon = product.ogImage?.startsWith("/") ? product.ogImage : null;

  return (
    <section className="border-b border-line pb-7 pt-6">
      <div className="flex flex-wrap items-start gap-[22px]">
        <div className="shrink-0 overflow-hidden rounded-[18px] border border-line bg-bg-soft [&_img]:rounded-none [&_img]:border-0">
          <ProductIcon name={product.name} ogImage={safeIcon} size={80} category={product.category} />
        </div>
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">{product.name}</h1>
            {risingRank !== null && risingRank <= RISING_BADGE_MAX && (
              <Link prefetch={false} href={localePath(locale, "/#rising")} className="inline-flex h-7 items-center rounded-full bg-accent-soft px-[11px] text-[13px] font-semibold text-accent-ink">
                {t("hero.rising", { rank: formatNumber(risingRank, locale) })}
              </Link>
            )}
            {talkRank !== null && (
              <Link prefetch={false} href={localePath(locale, "/talk")} className="inline-flex h-7 items-center rounded-full bg-[var(--source-hn-soft)] px-[11px] text-[13px] font-semibold text-[var(--source-hn)]">
                {t("talk.pill", { rank: formatNumber(talkRank, locale) })}
              </Link>
            )}
          </div>
          {/* 한 줄 소개는 공용 부품으로만 그린다(C2). 출처 줄은 아래 — 편집자가 쓴 줄('직접 요약')까지 밝히는 상세의 목록을 쓴다 */}
          <ProductTagline tagline={product.tagline} taglineKo={product.taglineKo} translation={product.translation} original="toggle" source={product.taglineSource} showSource={false}
            className="max-w-[720px] text-[20px] leading-[1.35] tracking-[-0.01em] text-fg" />
          {/* 지은 줄은 무엇을 보고 지었는지까지 밝힌다 — 메이커가 소개를 쓰면 이 표시는 사라진다 */}
          {product.taglineSource !== "maker" && (
            <IntroductionSource source={product.taglineSource} />
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-fg-2 tabular-nums">
            <span className="text-fg">{translatedCategory(product.category, labels)}</span>
            {personalGithubStar ? <><span aria-hidden>·</span>{personalGithubStar}</>
              : product.stars !== null && product.stars !== undefined && <><span aria-hidden>·</span><span className="font-medium text-fg">★ {formatNumber(product.stars, locale)}</span></>}
            {languages.length > 0 && <><span aria-hidden>·</span><span>{languages.join(" · ")}</span></>}
            {owner && <><span aria-hidden>·</span><span>GitHub @{owner.login}</span>{follow?.maker}</>}
            <span aria-hidden>·</span>
            {installable ? <span>{t("hero.installable")}</span> : <HealthStatus health={health} />}
            {unclaimed && <><span aria-hidden>·</span><span title={t("hero.unclaimedHint")}>{t("hero.unclaimed")}</span></>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* 저장소가 사라졌다고 확정되면(repoGone) 열리지 않는 저장소로 보내거나 설치하라고 하지 않는다 */}
            {installable && product.repoGone ? (
              <span className={`${BUTTON} bg-bg-soft text-down`}>{t("hero.repoGone")}</span>
            ) : installable ? (
              <>
                <a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className={`${BUTTON} bg-accent-solid text-white hover:opacity-90`}>{t("hero.openRepo")}</a>
                <InstallPrompt repoUrl={product.repoUrl ?? product.url} />
              </>
            ) : (
              <>
                <a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className={`${BUTTON} bg-accent-solid text-white hover:opacity-90`}>{t("hero.visit")}</a>
                {product.repoUrl && !product.repoGone && <a href={product.repoUrl} target="_blank" rel="noopener noreferrer" aria-label={t("hero.repoLabel")} className={`${BUTTON} bg-bg-soft text-fg`}>GitHub</a>}
              </>
            )}
            <ShareButton title={product.name} path={localePath(locale, `/p/${product.slug}`)} />
            <SaveButton slug={product.slug} name={product.name} />
            {follow?.project}
          </div>
          {product.repoGone && (
            <p className="text-[13px] text-fg-2">
              {installable
                ? t("hero.goneInstallable")
                : t("hero.goneDescription")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
