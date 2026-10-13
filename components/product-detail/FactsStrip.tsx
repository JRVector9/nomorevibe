"use client";

import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatNumber, formatDate, formatDateTime } from "@/lib/i18n/format";
import { LOCALE_CONFIG, type Locale } from "@/lib/i18n/locales";
import type { ReactNode } from "react";
import { BRAND } from "@/lib/copy/brand";
import type { LicenseValue, ProductDetailView } from "@/lib/domain/products/detail-view";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { LicenseDialog } from "./LicenseDialog";
import { safeExternalUrl } from "./format";

/** 칸 하나 — 값이 있는 것만 만든다 */
type Fact = { label: string; value: ReactNode; note?: string; tone?: "up" | "down"; title?: string };

function Tile({ label, value, note, tone, title }: Fact) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg";
  return (
    <div className="flex min-w-0 flex-col gap-1 border-l border-t border-line px-[14px] py-3" title={title}>
      <dt className="text-[13px] text-fg-2">{label}</dt>
      <dd className={`m-0 truncate text-[18px] font-semibold tracking-[-0.02em] tabular-nums ${color}`}>{value}</dd>
      {/* 덧말도 값의 일부로 둘째 dd 에 둔다 — dl 묶음 안에는 dt·dd 만 와야 스크린리더가 짝을 읽는다(A11Y-04) */}
      {note && <dd className="m-0 text-[13px] text-fg-2">{note}</dd>}
    </div>
  );
}

/** 서울 시각의 "2025년 1월" — 저장소를 만든 달(공개 날짜 형식은 일까지라 여기만 따로) */
function yearMonth(date: Date | string | null | undefined, locale: Locale): string {
  if (!date) return "";
  const at = new Date(date);
  return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat(LOCALE_CONFIG[locale].intl, { timeZone: "Asia/Seoul", year: "numeric", month: "long" }).format(at) : "";
}
const joinNote = (...parts: string[]) => parts.filter(Boolean).join(" · ");

/** GitHub 은 목록에 없는 라이선스를 spdxId "NOASSERTION" 으로 준다 — 그때는 표기 이름을 쓴다 */
const hasSpdx = (license: LicenseValue) => Boolean(license.spdxId && license.spdxId !== "NOASSERTION");
const licenseName = (license: LicenseValue) => hasSpdx(license) ? license.spdxId! : license.value;

/**
 * 핵심 사실 — 이미지 자리 대신 첫 화면을 사실로 채운다.
 * 유입 지표는 값이 있을 때만 일곱째 칸으로 — 공개 제품 대부분이 0·신규라 늘 보이면 빈 숫자가 가장 눈에 띈다.
 *
 * 값이 없는 칸('—'·'확인 안 됨'·'확인 전')은 그리지 않는다(UX-16).
 * 확인된 항목 수에 관계없이 같은 격자 스타일로 표시한다.
 *
 * 칸마다 왼쪽·위 선을 긋고 바깥 틀이 첫 줄·첫 칸의 선을 가린다.
 */
export function FactsStrip({ product, repository, license, health, visits }: {
  product: ProductDetailView["product"];
  repository: ProductDetailView["repository"];
  license: ProductDetailView["license"];
  health: ProductDetailView["health"];
  visits: ProductDetailView["visits"];
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const now = useServerNow();
  const facts = repository?.facts ?? null;
  const installable = product.accessMode === "installable";
  const current = isHealthCurrent(health.checkedAt, now);
  const failed = health.down || health.lastCheckSucceeded === false;
  const release = facts?.latestRelease ?? null;
  // 원래 릴리스 페이지로 — http(s) 가 아니면 링크 없이 태그만
  const releaseUrl = safeExternalUrl(release?.url ?? null) ?? safeExternalUrl(release?.notesUrl ?? null);
  // 보관·fork 여부를 둘 다 확인했을 때만 '활성'이라 한다(InfoCard 와 같은 규칙)
  const activity = !facts ? "" : facts.archived === true ? t("repo.archived") : facts.fork === true ? t("repo.fork")
    : facts.archived === false && facts.fork === false ? t("repo.active") : t("repo.unknown");
  const shown = license.observed ?? license.maker;
  const unidentifiedLicense = license.state === "unidentified";
  const licenseSource = repository ? {
    state: repository.state,
    lastSuccess: repository.lastSuccessAt ? formatDateTime(repository.lastSuccessAt, now, locale) : "",
    lastFailure: repository.lastFailureAt ? formatDateTime(repository.lastFailureAt, now, locale) : "",
  } : null;
  const licenseObservationWarning = repository?.state === "disconnected" ? t("repo.disconnectedOld")
    : repository?.state === "failed" ? t("repo.failedOld")
      : repository?.state === "stale" ? t("repo.staleOld")
        : repository?.lastSuccessAt && now.getTime() - repository.lastSuccessAt.getTime() > 48 * 60 * 60 * 1_000 ? t("repo.previous") : "";
  const licenseObservationNote = license.observed ? joinNote(
    license.observed.sourceLabel.includes("GitHub") ? t("source.githubLicense") : t("source.maker"),
    licenseObservationWarning,
    licenseObservationWarning && repository?.lastSuccessAt ? t("repo.observedAt", { date: formatDate(repository.lastSuccessAt, now, locale) }) : "",
  ) : "";
  const measured = !visits.collecting && visits.uniqueVisitors !== null && visits.validVisits > 0;
  const pushed = facts?.pushedAt ? formatDate(facts.pushedAt, now, locale) : "";
  const created = yearMonth(facts?.createdAt, locale);

  const cells: Array<Fact | false> = [
    installable
      ? { label: t("facts.access"), value: t("hero.installable"), note: t("facts.runsLocally") }
      // 가동 상태는 한 번이라도 확인했을 때만. 응답 시간은 툴팁으로만(UX-14)
      : Boolean(health.checkedAt) && {
          label: t("facts.health"), tone: current && failed ? "down" : undefined,
          value: !current ? t("facts.recheck") : health.down ? t("health.down") : failed ? t("facts.failed")
            : <span className="inline-flex items-center gap-2"><i aria-hidden className="inline-block h-[9px] w-[9px] rounded-full bg-up" />{t("health.online")}</span>,
          note: health.uptime30d === null ? undefined : t("facts.uptime", { percent: formatNumber(health.uptime30d, locale) }),
          title: health.latencyMs === null ? undefined : t("hero.latency", { ms: formatNumber(health.latencyMs, locale) }),
        },
    Boolean(pushed) && { label: t("facts.codeUpdated"), value: pushed, note: activity || undefined },
    // 저장소를 읽었는데 릴리스가 없으면 '없음'도 읽은 값이다
    facts !== null && {
      label: t("facts.latestVersion"),
      value: !release ? t("facts.none") : releaseUrl
        ? <a href={releaseUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{release.tagName}<span aria-hidden className="ml-1 text-[13px] font-normal text-fg-3">↗</span></a>
        : release.tagName,
      note: release ? joinNote(release.name !== release.tagName ? release.name : "", release.publishedAt ? formatDate(release.publishedAt, now, locale) : "") || undefined : undefined,
    },
    Boolean(facts?.contributors) && {
      label: t("facts.contributors"), value: t("facts.contributorCount", { count: formatNumber(facts!.contributors!.count, locale), plus: facts!.contributors!.incomplete ? "+" : "" }),
      note: facts!.forks === null ? undefined : t("facts.forks", { count: formatNumber(facts!.forks, locale) }),
    },
    Boolean(shown) && {
      label: t("facts.license"),
      value: <LicenseDialog
        license={license}
        source={licenseSource}
        repositoryUrl={product.repoGone ? null : safeExternalUrl(facts?.repositoryUrl ?? repository?.sourceUrl ?? product.repoUrl)}
        label={license.state === "conflict" ? t("facts.conflict") : unidentifiedLicense ? t("facts.unidentified") : licenseName(shown!)}
      />,
      tone: license.state === "conflict" ? "down" : undefined,
      note: license.state === "conflict" && license.maker && license.observed
        ? joinNote(t("facts.conflictNote", { maker: licenseName(license.maker), repository: licenseName(license.observed) }), licenseObservationWarning ? licenseObservationNote : "")
        : unidentifiedLicense
          ? joinNote(t("facts.unidentifiedNote"), license.maker ? t("facts.makerLicense", { license: licenseName(license.maker) }) : "")
          : joinNote(licenseObservationNote || t("source.maker"), license.observed && !hasSpdx(license.observed) ? t("facts.spdxUnknown") : ""),
    },
    {
      label: t("facts.registered", { brand: BRAND }), value: formatDate(product.createdAt, now, locale),
      note: created ? t("facts.repoCreated", { date: created }) : undefined,
    },
    measured && {
      label: t("facts.visits", { days: formatNumber(visits.periodDays, locale) }), value: formatNumber(visits.validVisits, locale),
      note: joinNote(t("facts.unique", { count: formatNumber(visits.uniqueVisitors, locale) }), visits.uniqueChangePercent === null ? "" : `${visits.uniqueChangePercent > 0 ? "+" : ""}${formatNumber(visits.uniqueChangePercent, locale)}%`),
    },
  ];
  const tiles = cells.filter((cell): cell is Fact => Boolean(cell));

  return (
    <div className="overflow-hidden rounded-[18px] border border-line bg-bg-card">
      <dl className="-ml-px -mt-px grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
        {tiles.map((tile) => <Tile key={tile.label} {...tile} />)}
      </dl>
      {!facts && product.repoUrl && !product.repoGone && <p className="m-0 border-t border-line px-[14px] py-3 text-[13px] text-fg-2">{t("facts.notCollected")}</p>}
    </div>
  );
}
