import type { LicenseValue, ProductDetailView } from "@/lib/domain/products/detail-view";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { formatNumber, safeExternalUrl } from "./format";

function Tile({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg";
  return (
    <div className="flex min-w-0 flex-col gap-1 border-l border-t border-line px-[18px] pb-3.5 pt-4">
      <dt className="text-[13px] text-fg-3">{label}</dt>
      <dd className={`m-0 truncate text-[20px] font-semibold tracking-[-0.02em] tabular-nums ${color}`}>{value}</dd>
      {note && <span className="text-[13px] text-fg-3">{note}</span>}
    </div>
  );
}

/** 서울 시각으로 날짜 일부만 — 값이 없거나 깨졌으면 빈 문자열 */
function kst(date: Date | string | null | undefined, options: Intl.DateTimeFormatOptions): string {
  if (!date) return "";
  const at = new Date(date);
  return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", ...options }).format(at) : "";
}
/** 월·일만 — "10월 1일". 연도는 note 에 */
const monthDay = (date: Date | string | null | undefined) => kst(date, { month: "long", day: "numeric" }) || "—";
const year = (date: Date | string | null | undefined) => kst(date, { year: "numeric" });
const clock = (date: Date | string | null | undefined) => kst(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const yearMonth = (date: Date | string | null | undefined) => kst(date, { year: "numeric", month: "long" });
const joinNote = (...parts: string[]) => parts.filter(Boolean).join(" · ");

/** GitHub 은 목록에 없는 라이선스를 spdxId "NOASSERTION" 으로 준다 — 그때는 표기 이름을 쓴다 */
const hasSpdx = (license: LicenseValue) => Boolean(license.spdxId && license.spdxId !== "NOASSERTION");
const licenseName = (license: LicenseValue) => hasSpdx(license) ? license.spdxId! : license.value;

/**
 * 핵심 사실 여섯 칸 — 이미지 자리 대신 첫 화면을 사실로 채운다.
 * 유입 지표는 값이 있을 때만 일곱째 칸으로 — 공개 제품 대부분이 0·신규라 늘 보이면 빈 숫자가 가장 눈에 띈다.
 *
 * 칸 사이 선은 칸마다 왼쪽·위 선을 긋고 바깥 틀이 첫 줄·첫 칸의 선을 가린다 —
 * 칸 수가 열 수로 나누어떨어지지 않아도 빈 자리가 회색 덩어리로 보이지 않는다.
 */
export function FactsStrip({ product, repository, license, health, visits }: {
  product: ProductDetailView["product"];
  repository: ProductDetailView["repository"];
  license: ProductDetailView["license"];
  health: ProductDetailView["health"];
  visits: ProductDetailView["visits"];
}) {
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
  const measured = !visits.collecting && visits.uniqueVisitors !== null && visits.validVisits > 0;

  return (
    <div className="overflow-hidden rounded-[18px] border border-line bg-bg-card">
      <dl className="-ml-px -mt-px grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]">
        {installable
          ? <Tile label="이용 방식" value="직접 설치" note="사용자 환경에서 실행" />
          : <Tile label="가동 상태" tone={current && failed ? "down" : undefined}
              value={!health.checkedAt ? "확인 전" : !current ? "재확인 필요" : health.down ? "접속 불안정" : failed ? "접속 확인 실패"
                : <span className="inline-flex items-center gap-2"><i aria-hidden className="inline-block h-[9px] w-[9px] rounded-full bg-up" />온라인</span>}
              note={health.checkedAt ? joinNote(health.latencyMs === null ? "응답 시간 미측정" : `${health.latencyMs}ms`, health.uptime30d === null ? "" : `30일 가동률 ${health.uptime30d}%`) : undefined} />}
        <Tile label="최근 push" value={monthDay(facts?.pushedAt)} note={facts ? joinNote(year(facts.pushedAt), clock(facts.pushedAt) ? `${clock(facts.pushedAt)} KST` : "", activity) : "저장소 미확인"} />
        <Tile label="최신 release"
          value={!facts ? "—" : !release ? "없음" : releaseUrl
            ? <a href={releaseUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">{release.tagName}<span aria-hidden className="ml-1 text-[13px] font-normal text-fg-3">↗</span></a>
            : release.tagName}
          note={release ? joinNote(release.name !== release.tagName ? release.name : "", kst(release.publishedAt, { month: "long", day: "numeric" })) : facts ? "GitHub 릴리스 기준" : undefined} />
        <Tile label="기여자" value={facts?.contributors ? `${formatNumber(facts.contributors.count)}명${facts.contributors.incomplete ? "+" : ""}` : "—"}
          note={facts ? `포크 ${formatNumber(facts.forks)}` : undefined} />
        <Tile label="라이선스" value={license.state === "conflict" ? "정보 충돌" : shown ? licenseName(shown) : "확인 안 됨"} tone={license.state === "conflict" ? "down" : undefined}
          note={license.state === "conflict" && license.maker && license.observed
            ? `메이커 ${licenseName(license.maker)} · 저장소 ${licenseName(license.observed)} — 두 값을 모두 확인하세요`
            : shown ? joinNote(shown.sourceLabel, license.observed && !hasSpdx(license.observed) ? "SPDX 미확인" : "") : undefined} />
        <Tile label="nomorevibe 등록" value={monthDay(product.createdAt)}
          note={joinNote(year(product.createdAt), facts?.createdAt && yearMonth(facts.createdAt) ? `저장소 생성 ${yearMonth(facts.createdAt)}` : "")} />
        {measured && <Tile label={`유효 방문 · 최근 ${visits.periodDays}일`} value={formatNumber(visits.validVisits)}
          note={joinNote(`고유 ${formatNumber(visits.uniqueVisitors)}`, visits.uniqueChangePercent === null ? "" : `${visits.uniqueChangePercent > 0 ? "+" : ""}${visits.uniqueChangePercent}%`)} />}
      </dl>
    </div>
  );
}
