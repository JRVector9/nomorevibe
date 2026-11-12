import Link from "next/link";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { FeedSourceConfig } from "@/lib/crawl/feed-source-schema";
import { intervalText } from "@/lib/jobs/job-intervals";
import { formatCount, formatDuration, formatKst } from "@/lib/operations/console-tasks";
import { YIELD_MIN_FOUND, type CronRowView, type FunnelCounts, type JobStatus, type SourceRowView, type SourcesView } from "@/lib/operations/sources-model";
import { JobControl } from "../status/JobControl";
import { JOB_HOW } from "../status/work-owners";
import { FeedSettingsForm, JobIntervalForm } from "./IntervalForms";
import { FeedSourceAdd } from "./new/FeedSourceAdd";
import "./sources.css";

/** 수집원 화면 주소 — ?source=<열쇠> 는 그 수집원의 상세를 연다 */
export const SOURCES_HREF = "/admin/sources";
export const SOURCES_NEW_HREF = "/admin/sources/new";
export const sourceHref = (key: string) => `${SOURCES_HREF}?source=${encodeURIComponent(key)}`;
/** 주기 작업 한 줄의 조치(주기·멈춤)를 그 줄 아래에 연다 */
export const cronJobHref = (job: string) => `${SOURCES_HREF}?job=${encodeURIComponent(job)}#job-${job}`;

type Csrf = { token: string; expiresAt: number } | null;
export type SourcesConsoleProps = { view: SourcesView; settings: CrawlSettings | null; selected: string | null; readOnly: boolean; csrf: Csrf;
  jobs: Readonly<Record<string, { paused: boolean; notBefore: string | null; version: number }>>;
  /** ?job= — 주기 작업 표에서 조치를 연 줄 */
  openJob?: string | null };

/** 이미 쓰는 신호 이름 — 수집원 추가가 겹치는 이름을 미리 알린다(수집원 추가 화면 FeedSourceAddSlot 과 같은 계산) */
export const feedAddTaken = (view: SourcesView, settings: CrawlSettings | null) =>
  settings ? [...new Set([...settings.discover.queries.map(query => query.label), ...view.sources.map(source => source.label)])] : [];
const ago = (value: string | null, now: string) => value ? `${formatDuration(Math.max(0, (Date.parse(now) - Date.parse(value)) / 60_000))} 전` : "—";
const Status = ({ status }: { status: JobStatus }) => <span className="sc-st" data-tone={status.tone} title={status.why ?? undefined}><i aria-hidden="true" />{status.label}</span>;

/**
 * 운영 콘솔 「수집·작업」(2026-11-12 최종 시안 화면 5, 조각 4a) — 모델(LLM)을 쓰지 않는 들어오는 곳과 주기 작업을 따로 본다.
 * 1) 수집원: 공개까지 간 비율로 본다(7일 찾음 중 지금 공개된 것). 줄을 누르면(?source=) 상세 — 7일 동안 어디까지 갔나 · 규칙(설정 그대로) · 조치(주기 바꾸기 · 잠시 멈춤).
 * 2) 주기 작업: 수집 · 검색(벡터·재정렬 서버 상태 포함) · 공개 뒤 유지. 주기는 그 자리에서 고치고(저장 전 확인), 멈춤·재개는 기존 작업 멈춤(사유 필수)이다.
 * 상태는 읽은 사실만 적는다 — 사람이 멈춤(누가·언제·사유) · 마지막 회차 오류 · 제 일 못 함(degraded) · 성공 끊김.
 */
export function SourcesConsole({ view, settings, selected, readOnly, csrf, jobs, openJob = null }: SourcesConsoleProps) {
  const row = selected ? view.sources.find(entry => entry.key === selected) ?? null : null;
  return <div className="sources-console">
    <div className="sc-head">
      <h2>수집원</h2><span className="sc-count">{formatCount(view.sources.length)}개 · 7일 기준{view.funnelAt ? ` · 집계 ${formatKst(view.funnelAt)}` : ""}</span>
      {!readOnly && <span className="sc-right"><Link prefetch={false} className="button small primary" href={SOURCES_NEW_HREF}>수집원 추가</Link></span>}
    </div>
    {view.errors.map(error => <p key={error} role="alert" className="sc-notice">{error}</p>)}
    <div className="sc-scroll" role="region" aria-label="수집원" tabIndex={0}>
      <table className="sc-table" style={{ minWidth: 940 }}>
        <colgroup><col style={{ width: 148 }} /><col style={{ width: 128 }} /><col style={{ width: 72 }} /><col style={{ width: 104 }} /><col style={{ width: 104 }} />
          <col style={{ width: 104 }} /><col /><col style={{ width: 116 }} /><col style={{ width: 112 }} /></colgroup>
        <thead><tr><th scope="col">수집원</th><th scope="col">방식</th><th scope="col" className="n">주기</th><th scope="col" className="n">24시간 찾음</th>
          <th scope="col" className="n">7일 찾음</th><th scope="col" className="n">7일 공개</th><th scope="col">공개까지 간 비율</th><th scope="col" className="n">마지막 성공</th>
          <th scope="col">상태</th></tr></thead>
        <tbody>
          {view.sources.map(entry => <tr key={entry.key} data-selected={entry.key === selected ? "true" : undefined} data-source={entry.key}>
            <th scope="row"><Link prefetch={false} scroll={false} href={`${sourceHref(entry.key)}#source-detail`}
              aria-current={entry.key === selected ? "true" : undefined}>{entry.label}</Link></th>
            <td className="q">{entry.how}</td>
            <td className="n">{intervalText(entry.intervalMs)}</td>
            <td className="n">{formatCount(entry.found24)}</td>
            <td className="n">{formatCount(entry.funnel.found)}</td>
            <td className="n">{formatCount(entry.funnel.published)}</td>
            <td>{entry.yieldPct === null ? <span className="sc-none">자료 부족{entry.funnel.found ? `(${formatCount(entry.funnel.found)}건)` : ""}</span>
              : <span className="sc-use"><span aria-hidden="true"><i style={{ width: `${entry.bar.toFixed(0)}%` }} /></span><b>{entry.yieldPct.toFixed(1)}%</b></span>}</td>
            <td className="n">{ago(entry.lastSuccessAt, view.checkedAt)}</td>
            <td><Status status={entry.status} /></td>
          </tr>)}
          {!view.sources.length && <tr><td colSpan={9} className="q">수집원을 읽지 못했습니다.</td></tr>}
        </tbody>
      </table>
    </div>
    <p className="sc-hint">공개까지 간 비율 = 7일 동안 찾은 저장소 중 지금 공개된 것. 7일 찾음이 {YIELD_MIN_FOUND}건보다 적으면 「자료 부족」입니다. 막대는 25%가 끝입니다.
      마지막 성공은 그 수집원을 도는 작업의 마지막 성공입니다(글 목록 수집원은 한 작업을 함께 씁니다).</p>
    {selected && !row && <p role="alert" className="sc-notice">고른 수집원을 찾지 못했습니다(지워졌거나 설정을 읽지 못함).</p>}
    {row && <SourceDetail row={row} view={view} settings={settings} readOnly={readOnly} csrf={csrf} control={row.job ? jobs[row.job] ?? null : null} />}
    {/* 시안 화면 4 — 수집원 표 아래 「수집원 추가」 세 단계(수집원 추가 화면과 같은 구성 요소). 상세를 연 동안은 접어 둔다 */}
    {!selected && !readOnly && <FeedSourceAdd kind={null} readOnly={readOnly} embedded taken={feedAddTaken(view, settings)}
      jobIntervalMs={view.sources.find(source => source.feed?.legacy)?.intervalMs ?? null} />}
    <CronTable view={view} readOnly={readOnly} csrf={csrf} openJob={openJob} />
  </div>;
}

const FUNNEL: readonly { key: keyof FunnelCounts; label: string }[] = [
  { key: "found", label: "찾음" }, { key: "rejected", label: "거절" }, { key: "review", label: "사람 확인" }, { key: "approved", label: "승인 대기" },
  { key: "published", label: "공개" }, { key: "other", label: "아직 심사 전·중" },
];

function SourceDetail({ row, view, settings, readOnly, csrf, control }: { row: SourceRowView; view: SourcesView; settings: CrawlSettings | null; readOnly: boolean;
  csrf: Csrf; control: { paused: boolean; notBefore: string | null; version: number } | null }) {
  const found = row.funnel.found;
  const feedConfig = row.feed && !row.feed.legacy ? settings?.discover.feeds.find(feed => feed.id === row.feed!.id) ?? null : null;
  const jobMs = row.jobIntervalMs;
  const feedCount = view.sources.filter(entry => entry.kind === "feed").length;
  return <article id="source-detail" className="sc-detail" aria-labelledby="source-detail-title" data-source-detail={row.key}>
    <section>
      <div className="sc-head"><h3 id="source-detail-title">{row.label}</h3><Status status={row.status} />
        <span className="sc-right"><Link prefetch={false} className="text-button" href={SOURCES_HREF} scroll={false}>닫기</Link></span></div>
      <p className="sc-kv"><span>주기<b>{intervalText(row.intervalMs)}</b></span><span>7일 찾음<b>{formatCount(found)}</b></span>
        <span>7일 공개<b>{formatCount(row.funnel.published)}</b></span><span>24시간 찾음<b>{formatCount(row.found24)}</b></span>
        {row.readAt && <span>마지막으로 읽음<b>{ago(row.readAt, view.checkedAt)}</b></span>}</p>
      {row.status.why && <p className="sc-hint">{row.status.why}</p>}
    </section>
    <section aria-label="7일 동안 어디까지 갔나">
      <span className="sc-lab">7일 동안 어디까지 갔나</span>
      {found ? <div className="sc-fun">{FUNNEL.map(step => <div key={step.key} data-key={step.key}><span>{step.label}</span>
        <span className="b" aria-hidden="true"><i style={{ width: `${(row.funnel[step.key] / found * 100).toFixed(0)}%` }} /></span>
        <span>{formatCount(row.funnel[step.key])}</span></div>)}</div>
        : <p className="sc-hint">7일 동안 찾은 것이 없습니다.</p>}
      <p className="sc-hint">찾은 저장소가 지금 어디에 있는지입니다(후보 상태). 「아직 심사 전·중」은 원본 수집 대기·규칙 심사 전이거나 AI 심사 중인 것입니다.</p>
      {row.signals.length > 1 && <div className="sc-scroll"><table className="sc-table" style={{ minWidth: 420 }}>
        <colgroup><col /><col style={{ width: 96 }} /><col style={{ width: 96 }} /></colgroup>
        <thead><tr><th scope="col">{row.kind === "github" ? "검색어" : "신호"}</th><th scope="col" className="n">7일 찾음</th><th scope="col" className="n">7일 공개</th></tr></thead>
        <tbody>{row.signals.slice(0, 12).map(signal => <tr key={signal.signal}><th scope="row">{signal.signal}</th><td className="n">{formatCount(signal.found7)}</td>
          <td className="n">{formatCount(signal.published7)}</td></tr>)}</tbody></table></div>}
    </section>
    <section aria-label="규칙">
      <span className="sc-lab">규칙</span>
      <Rules row={row} settings={settings} jobMs={jobMs} />
    </section>
    <section aria-label="조치">
      <span className="sc-lab">조치</span>
      {row.kind === "other" ? <p className="sc-hint">어느 수집원에도 묶이지 않은 신호입니다(지운 검색어·다시 받기 신호 등). 바꿀 것이 없습니다.</p> : <>
        {feedConfig ? <FeedSettingsForm feed={feedConfig as FeedSourceConfig} jobIntervalMs={jobMs} readOnly={readOnly} />
          : row.job && <JobIntervalForm job={row.job} label={row.kind === "feed" ? "글 목록 작업" : row.label} currentMs={row.jobIntervalMs} defaultMs={row.jobDefaultMs}
            overridden={row.overridden} revision={view.revision} readOnly={readOnly}
            note={row.kind === "feed" ? `글 목록 작업(${row.job})의 주기입니다 — 글 목록 수집원 ${feedCount}개가 이 주기로 돕니다(각자 주기가 더 길면 그 주기).` : undefined} />}
        {row.job && control && csrf && !readOnly ? <div className="sc-acts"><details><summary className="button small">{control.paused ? "재개…" : "잠시 멈춤…"}</summary>
          <JobControl name={row.job} paused={control.paused} notBefore={control.notBefore} version={control.version} csrf={csrf} />
          {row.kind === "feed" && <p className="sc-hint">글 목록 작업({row.job})을 멈춥니다 — 글 목록 수집원 {feedCount}개가 함께 멈춥니다. 하나만 멈추려면 그 수집원을 끕니다.</p>}
        </details></div> : row.job && <p className="sc-hint">{readOnly ? "읽기 전용 화면입니다." : "멈춤·재개는 작업 흐름에서 합니다."}{" "}
          <Link prefetch={false} href={`/admin/status?tab=jobs&job=${encodeURIComponent(row.job)}`}>작업 상세 →</Link></p>}
      </>}
    </section>
  </article>;
}

function Rules({ row, settings, jobMs }: { row: SourceRowView; settings: CrawlSettings | null; jobMs: number | null }) {
  if (!settings) return <p className="sc-hint">크롤 설정을 읽지 못했습니다.</p>;
  const yes = (value: boolean | undefined) => value ? "켬" : "끔";
  if (row.kind === "github") {
    const discover = settings.discover;
    return <>
      <dl className="sc-dl"><dt>검색어</dt><dd>{discover.queries.filter(query => query.enabled).length}개 켬 · 전체 {discover.queries.length}개</dd>
        <dt>범위</dt><dd className="num">최근 {discover.windowDays}일 · {discover.sort === "recent" ? "최신순" : "관련도순"}</dd>
        <dt>한 회차</dt><dd className="num">검색 {discover.pagesPerTick}쪽</dd>
        <dt>새 저장소 상한</dt><dd className="num">시간당 {formatCount(discover.maxNewPerHour)}</dd></dl>
      <div className="sc-scroll"><table className="sc-table" style={{ minWidth: 520 }}>
        <colgroup><col style={{ width: 168 }} /><col /><col style={{ width: 64 }} /><col style={{ width: 64 }} /></colgroup>
        <thead><tr><th scope="col">이름(신호)</th><th scope="col">검색어</th><th scope="col" className="n">우선</th><th scope="col">켬</th></tr></thead>
        <tbody>{discover.queries.map(query => <tr key={query.label}><th scope="row">{query.label}</th>
          <td className="q">{query.kind === "repositories" ? "저장소" : "커밋"} · <code>{query.query}</code>{query.requireEvidence ? " · AI 흔적 요구" : ""}</td>
          <td className="n">{query.priority}</td><td>{yes(query.enabled)}</td></tr>)}</tbody></table></div>
      <p className="sc-hint">검색어는 크롤 설정에서 고칩니다 — 고치면 GitHub 검색 주기가 처음부터 다시 돕니다(1~2시간 발견이 멈출 수 있음). <Link prefetch={false} href="/admin#signals">검색 신호 고치기 →</Link></p>
    </>;
  }
  if (row.kind === "show-hn") {
    const hn = settings.discover.showHn;
    return <><dl className="sc-dl"><dt>켜짐</dt><dd>{yes(hn.enabled)}</dd><dt>우선순위</dt><dd className="num">{hn.priority}</dd>
      <dt>AI 흔적</dt><dd>{hn.requireEvidence ? "요구함" : "요구하지 않음"}</dd>
      <dt>고를 글</dt><dd>HN 검색 API의 Show HN 글 <span className="sc-muted">· 코드에서 정함</span></dd>
      <dt>제품 링크</dt><dd>글의 링크가 GitHub 저장소인 것만 <span className="sc-muted">· 코드에서 정함</span></dd></dl>
      <p className="sc-hint">켜짐·우선순위·AI 흔적은 크롤 설정에서 고칩니다. <Link prefetch={false} href="/admin#signals">수집 설정 →</Link></p></>;
  }
  if (row.kind === "korean") return <><dl className="sc-dl"><dt>고를 것</dt><dd>Oracle 이 GitHub 검색으로 찾고 한국어로 확인한 저장소 <span className="sc-muted">· 코드에서 정함</span></dd>
    <dt>AI 흔적</dt><dd>늘 요구함(언어는 AI 제작 근거가 아님)</dd></dl>
    <p className="sc-hint">한국어 탐색의 켜기·검색어는 작업 흐름의 한국어 탐색에서 봅니다. <Link prefetch={false} href="/admin/status?tab=crawlers">크롤러 활동 →</Link></p></>;
  if (row.kind === "feed" && row.feed) {
    const feed = row.feed;
    return <><dl className="sc-dl"><dt>주소</dt><dd className="num">{feed.url}</dd>
      <dt>고를 글</dt><dd>{feed.titlePrefix ? <>제목이 「{feed.titlePrefix}」으로 시작</> : "모든 글"}</dd>
      <dt>제품 링크</dt><dd>{feed.link.kind === "page-title"
        ? <>글 페이지의 제목 링크 <span className="sc-muted">· 제목 영역 class 「{feed.link.titleClass}」 · 링크 class 「{feed.link.linkClass}」{feed.link.bodyId ? ` · 본문 id 「${feed.link.bodyId}」` : ""}</span></>
        : "피드 항목의 링크"}</dd>
      <dt>주기</dt><dd className="num">{feed.intervalMinutes === null ? `글 목록 작업마다(${intervalText(jobMs)})` : intervalText(feed.intervalMinutes * 60_000)}</dd>
      <dt>우선순위</dt><dd className="num">{feed.priority}</dd><dt>AI 흔적</dt><dd>{feed.requireEvidence ? "요구함" : "요구하지 않음"}</dd>
      <dt>켜짐</dt><dd>{yes(feed.enabled)}</dd></dl>
      <p className="sc-hint">{feed.legacy
        ? <>첫 수집원(2026-11-11)이라 주소·규칙은 코드에 있습니다. 켜짐·우선순위·AI 흔적은 크롤 설정의 Show GN 줄에서 고칩니다. <Link prefetch={false} href="/admin#signals">수집 설정 →</Link></>
        : "저장소가 있는 글만 심사 줄로 보냅니다. 사이트만 있는 글은 받지 않습니다(건수만 기록)."}</p></>;
  }
  return <p className="sc-hint">이 신호를 넣는 수집원 정의가 코드·설정에 없습니다.</p>;
}

function CronTable({ view, readOnly, csrf, openJob }: { view: SourcesView; readOnly: boolean; csrf: Csrf; openJob: string | null }) {
  const count = view.cron.reduce((sum, group) => sum + group.rows.length, 0);
  return <section className="sources-console" aria-labelledby="cron-title">
    <div className="sc-head"><h2 id="cron-title">주기 작업</h2><span className="sc-count">{formatCount(count)}개 · 모델(LLM)을 쓰지 않는 작업 · 주기는 그 자리에서 고칩니다</span></div>
    <div className="sc-scroll" role="region" aria-label="주기 작업" tabIndex={0}>
      <table className="sc-table" style={{ minWidth: 980 }}>
        <colgroup><col style={{ width: 184 }} /><col /><col style={{ width: 84 }} /><col style={{ width: 104 }} /><col style={{ width: 84 }} />
          <col style={{ width: 200 }} /><col style={{ width: 96 }} /></colgroup>
        <thead><tr><th scope="col">작업</th><th scope="col">하는 일</th><th scope="col" className="n">주기</th><th scope="col" className="n">마지막 성공</th>
          <th scope="col" className="n">대기</th><th scope="col">상태</th><th scope="col">조치</th></tr></thead>
        {view.cron.map(group => <tbody key={group.group}>
          <tr className="sc-group"><th scope="rowgroup" colSpan={7}>{group.label}</th></tr>
          {group.rows.map(row => <CronRow key={row.job} row={row} view={view} readOnly={readOnly} csrf={csrf} open={row.job === openJob} />)}
          {group.servers.map(server => <tr key={server.name} data-server={server.name}>
            <th scope="row">{server.name}</th><td className="q">의미 검색이 부르는 서버의 응답 확인(화면을 그릴 때 한 번)</td>
            <td className="n">—</td><td className="n">—</td><td className="n">—</td>
            <td><span className="sc-st" data-tone={server.ok ? "ok" : "bad"}><i aria-hidden="true" />{server.ok ? "응답함" : server.error ?? "응답 없음"}</span></td><td />
          </tr>)}
        </tbody>)}
      </table>
    </div>
    <p className="sc-hint">대기는 워커가 알린 단계 대기(원본 수집·규칙 심사·응답 점검·근거)와 공개 제품 중 벡터가 없는 수입니다. 모델을 부르는 단계(1·2차 심사·번역·소개 검수 등)는 홈의 단계 패널과 「모델」에서 봅니다.</p>
  </section>;
}

function CronRow({ row, view, readOnly, csrf, open }: { row: CronRowView; view: SourcesView; readOnly: boolean; csrf: Csrf; open: boolean }) {
  return <>
    <tr id={`job-${row.job}`} data-job={row.job} data-selected={open ? "true" : undefined}>
      <th scope="row" className="top">{row.label}<small><code>{row.job}</code></small></th>
      <td className="q top">{JOB_HOW[row.job] ?? "—"}</td>
      <td className="n top">{row.intervalMs === null ? "요청될 때" : intervalText(row.intervalMs)}{row.overridden && <small>바꿈 · 기본 {intervalText(row.defaultMs)}</small>}</td>
      <td className="n top">{ago(row.lastSuccessAt, view.checkedAt)}</td>
      <td className="n top">{row.waiting === null ? "—" : formatCount(row.waiting)}</td>
      <td className="top"><Status status={row.status} />{row.status.why && <span className="sc-why">{row.status.why}</span>}</td>
      <td className="top">{open ? <Link prefetch={false} scroll={false} className="text-button" href={SOURCES_HREF}>닫기</Link>
        : <Link prefetch={false} scroll={false} className="text-button" href={cronJobHref(row.job)}>{row.paused ? "재개·주기" : "주기·멈춤"}</Link>}</td>
    </tr>
    {open && <tr data-job-actions={row.job}><td colSpan={7}>
      <div className="sc-acts" style={{ alignItems: "flex-start" }}>
        <div className="sc-form" style={{ flex: "1 1 320px" }}><span className="sc-lab">주기</span>
          <JobIntervalForm job={row.job} label={row.label} currentMs={row.intervalMs} defaultMs={row.defaultMs} overridden={row.overridden} revision={view.revision} readOnly={readOnly} /></div>
        <div className="sc-form" style={{ flex: "1 1 320px" }}><span className="sc-lab">{row.paused ? "재개" : "잠시 멈춤"}</span>
          {csrf && !readOnly ? <JobControl name={row.job} paused={row.paused} notBefore={row.notBefore} version={row.version} csrf={csrf} />
            : <p className="sc-hint">{readOnly ? "읽기 전용 화면입니다." : "이 화면에서는 멈출 수 없습니다."} <Link prefetch={false} href={`/admin/status?tab=jobs&job=${encodeURIComponent(row.job)}`}>작업 상세 →</Link></p>}</div>
      </div>
    </td></tr>}
  </>;
}
