import type { ReactNode } from "react";
import { BRAND } from "@/lib/copy/brand";
import { LAST_CODE_UPDATE_LABEL, LATEST_VERSION_LABEL } from "@/lib/copy/terms";
import { formatCount } from "@/lib/format/number";
import { formatPublicDate, formatPublicDateTime } from "@/lib/format/time";
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
function yearMonth(date: Date | string | null | undefined): string {
  if (!date) return "";
  const at = new Date(date);
  return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long" }).format(at) : "";
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
  const now = new Date();
  const facts = repository?.facts ?? null;
  const installable = product.accessMode === "installable";
  const current = isHealthCurrent(health.checkedAt);
  const failed = health.down || health.lastCheckSucceeded === false;
  const release = facts?.latestRelease ?? null;
  // 원래 릴리스 페이지로 — http(s) 가 아니면 링크 없이 태그만
  const releaseUrl = safeExternalUrl(release?.url ?? null) ?? safeExternalUrl(release?.notesUrl ?? null);
  // 보관·fork 여부를 둘 다 확인했을 때만 '활성'이라 한다(InfoCard 와 같은 규칙)
  const activity = !facts ? "" : facts.archived === true ? "보관됨" : facts.fork === true ? "fork 저장소"
    : facts.archived === false && facts.fork === false ? "활성 저장소" : "상태 미확인";
  const shown = license.observed ?? license.maker;
  const unidentifiedLicense = license.state === "unidentified";
  const licenseSource = repository ? {
    state: repository.state,
    lastSuccess: formatPublicDateTime(repository.lastSuccessAt, now, ""),
    lastFailure: formatPublicDateTime(repository.lastFailureAt, now, ""),
  } : null;
  const licenseObservationWarning = repository?.state === "disconnected" ? "연결 끊김·이전 수집 값"
    : repository?.state === "failed" ? "최근 갱신 실패·이전 수집 값"
      : repository?.state === "stale" ? "갱신 지연·이전 수집 값"
        : repository?.lastSuccessAt && now.getTime() - repository.lastSuccessAt.getTime() > 48 * 60 * 60 * 1_000 ? "이전 수집 값" : "";
  const licenseObservationNote = license.observed ? joinNote(
    license.observed.sourceLabel.includes("GitHub") ? "GitHub 자동 판별" : license.observed.sourceLabel,
    licenseObservationWarning,
    licenseObservationWarning && repository?.lastSuccessAt ? `${formatPublicDate(repository.lastSuccessAt, now)} 수집 기준` : "",
  ) : "";
  const measured = !visits.collecting && visits.uniqueVisitors !== null && visits.validVisits > 0;
  const pushed = formatPublicDate(facts?.pushedAt, now, "");
  const created = yearMonth(facts?.createdAt);

  const cells: Array<Fact | false> = [
    installable
      ? { label: "이용 방식", value: "직접 설치", note: "사용자 환경에서 실행" }
      // 가동 상태는 한 번이라도 확인했을 때만. 응답 시간은 툴팁으로만(UX-14)
      : Boolean(health.checkedAt) && {
          label: "가동 상태", tone: current && failed ? "down" : undefined,
          value: !current ? "재확인 필요" : health.down ? "접속 불안정" : failed ? "접속 확인 실패"
            : <span className="inline-flex items-center gap-2"><i aria-hidden className="inline-block h-[9px] w-[9px] rounded-full bg-up" />온라인</span>,
          note: health.uptime30d === null ? undefined : `30일 가동률 ${health.uptime30d}%`,
          title: health.latencyMs === null ? undefined : `응답 시간 ${health.latencyMs}ms`,
        },
    Boolean(pushed) && { label: LAST_CODE_UPDATE_LABEL, value: pushed, note: activity || undefined },
    // 저장소를 읽었는데 릴리스가 없으면 '없음'도 읽은 값이다
    facts !== null && {
      label: LATEST_VERSION_LABEL,
      value: !release ? "없음" : releaseUrl
        ? <a href={releaseUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{release.tagName}<span aria-hidden className="ml-1 text-[13px] font-normal text-fg-3">↗</span></a>
        : release.tagName,
      note: release ? joinNote(release.name !== release.tagName ? release.name : "", formatPublicDate(release.publishedAt, now, "")) || undefined : undefined,
    },
    Boolean(facts?.contributors) && {
      label: "기여자", value: `${formatCount(facts!.contributors!.count)}명${facts!.contributors!.incomplete ? "+" : ""}`,
      note: facts!.forks === null ? undefined : `포크 ${formatCount(facts!.forks)}`,
    },
    Boolean(shown) && {
      label: "라이선스",
      value: <LicenseDialog
        license={license}
        source={licenseSource}
        repositoryUrl={product.repoGone ? null : safeExternalUrl(facts?.repositoryUrl ?? repository?.sourceUrl ?? product.repoUrl)}
        label={license.state === "conflict" ? "정보 충돌" : unidentifiedLicense ? "식별 미확인" : licenseName(shown!)}
      />,
      tone: license.state === "conflict" ? "down" : undefined,
      note: license.state === "conflict" && license.maker && license.observed
        ? joinNote(`메이커 ${licenseName(license.maker)} · 저장소 ${licenseName(license.observed)} — 두 값을 모두 확인하세요`, licenseObservationWarning ? licenseObservationNote : "")
        : unidentifiedLicense
          ? joinNote("식별 미확인·원문 확인 필요", license.maker ? `메이커 ${licenseName(license.maker)}·미검증` : "")
          : joinNote(licenseObservationNote || shown!.sourceLabel, license.observed && !hasSpdx(license.observed) ? "SPDX 미확인" : ""),
    },
    {
      label: `${BRAND} 등록`, value: formatPublicDate(product.createdAt, now),
      note: created ? `저장소 생성 ${created}` : undefined,
    },
    measured && {
      label: `유효 방문 · 최근 ${visits.periodDays}일`, value: formatCount(visits.validVisits),
      note: joinNote(`고유 ${formatCount(visits.uniqueVisitors)}`, visits.uniqueChangePercent === null ? "" : `${visits.uniqueChangePercent > 0 ? "+" : ""}${visits.uniqueChangePercent}%`),
    },
  ];
  const tiles = cells.filter((cell): cell is Fact => Boolean(cell));

  return (
    <div className="overflow-hidden rounded-[18px] border border-line bg-bg-card">
      <dl className="-ml-px -mt-px grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
        {tiles.map((tile) => <Tile key={tile.label} {...tile} />)}
      </dl>
      {!facts && product.repoUrl && !product.repoGone && <p className="m-0 border-t border-line px-[14px] py-3 text-[13px] text-fg-2">저장소 정보는 아직 수집하지 않았습니다.</p>}
    </div>
  );
}
