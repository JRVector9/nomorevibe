"use client";

import { useEffect, useState } from "react";
import { ProductIcon } from "@/components/ProductIcon";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatDate, formatDateTime, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { reviveTalk, type TalkBoardResponse, type TalkEntryData, type TalkPostData } from "@/lib/social/talk-wire";
import { TalkSparkline } from "./TalkSparkline";
import { discussionUrl, linkOnly, sourceChip, sourceClass } from "./talk-format";

/**
 * 화제 채우기(2026-11-15 공개 HTML 이름·요약만) — 홈 대표 구획·/talk 의 서버 HTML 에는 순위 자리·이름·요약·링크만 있다.
 * 한 화면의 자리 여럿이 같은 응답(/api/talk-board?mode=…)을 한 번 받아 함께 쓴다. 받는 동안은 글자 없는 자리(aria-busy)만,
 * 못 받으면 자리를 거둔다(아이콘은 이름 첫 글자 타일로). 대기 문구는 두지 않는다.
 * 속성은 mode·slug·이름뿐 — 제품의 다른 칸은 RSC 데이터에 싣지 않는다.
 */
export type TalkFillMode = "home" | "now" | "week";

const loads = new Map<string, Promise<TalkBoardResponse | null>>();
/** 받아 둔 응답 — 화면을 다시 열면(앱 안 이동) 자리 없이 바로 그린다. 처음 그리는 HTML(하이드레이션)에는 아직 없다 */
const loaded = new Map<string, TalkBoardResponse>();

/** 한 화면의 자리들이 함께 쓰는 한 번의 요청 */
export function loadTalkBoard(mode: TalkFillMode, locale: string): Promise<TalkBoardResponse | null> {
  const key = `${locale}:${mode}`;
  let load = loads.get(key);
  if (!load) {
    load = fetch(`/api/talk-board?${new URLSearchParams({ mode, locale })}`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? JSON.parse(await response.text(), reviveTalk) as TalkBoardResponse : null)
      .catch(() => null)
      .then((data) => {
        // 실패는 담아 두지 않는다 — 다음에 열면 다시 받는다
        if (data) loaded.set(key, data); else loads.delete(key);
        return data;
      });
    loads.set(key, load);
  }
  return load;
}

type State = { key: string; data: TalkBoardResponse | null; done: boolean };

export function useTalkBoard(mode: TalkFillMode): { data: TalkBoardResponse | null; done: boolean } {
  const locale = useLocale();
  const key = `${locale}:${mode}`;
  const known = loaded.get(key);
  const [state, setState] = useState<State>(() => known ? { key, data: known, done: true } : { key, data: null, done: false });
  useEffect(() => {
    let alive = true;
    loadTalkBoard(mode, locale).then((data) => { if (alive) setState({ key: `${locale}:${mode}`, data, done: true }); });
    return () => { alive = false; };
  }, [mode, locale]);
  if (state.key === key) return state;
  return known ? { data: known, done: true } : { data: null, done: false };
}

/** 한 항목 — 받기 전이면 done=false, 받았는데 없으면(그사이 순위가 바뀜) entry=null */
function useTalkEntry(mode: TalkFillMode, slug: string): { entry: TalkEntryData | null; done: boolean } {
  const { data, done } = useTalkBoard(mode);
  return { entry: data?.entries.find((item) => item.slug === slug) ?? null, done };
}

/** 받는 동안의 자리 — 글자 없이 높이만 */
function Pending({ className = "", minHeight, inline = false }: { className?: string; minHeight: number; inline?: boolean }) {
  const Tag = inline ? "span" : "div";
  return <Tag aria-busy="true" className={`talk-pending ${className}`.trim()} style={{ minHeight }} />;
}

/** 출처마다 가장 큰 글 하나 — 칩 하나씩 */
export function leadPosts<P extends Pick<TalkPostData, "source">>(posts: readonly P[]): P[] {
  const seen = new Set<string>();
  return posts.filter((post) => !seen.has(post.source) && seen.add(post.source));
}

const postKey = (post: TalkPostData) => `${post.source}:${post.externalId}`;

export function TalkChips({ posts, t, locale, short = false }: { posts: readonly TalkPostData[]; t: Translator<"browse">; locale: Locale; short?: boolean }) {
  const count = (n: number) => formatNumber(n, locale);
  return (
    <span className="talk-srcs">
      {leadPosts(posts).map((post) => (
        <span key={postKey(post)} className={sourceClass(post.source)}>
          <b>{sourceChip(post)}</b>
          {short ? count(post.points) : t(linkOnly(post.source) ? "talk.xScore" : "talk.score", { points: count(post.points), comments: count(post.comments) })}
        </span>
      ))}
    </span>
  );
}

/** 아이콘 — 받기 전에는 같은 크기의 빈 타일, 못 받으면 이름 첫 글자 타일 */
export function TalkIcon({ mode, slug, name, size }: { mode: TalkFillMode; slug: string; name: string; size: number }) {
  const { entry, done } = useTalkEntry(mode, slug);
  if (!done) return <span aria-hidden="true" className="product-monogram talk-icon-pending" style={{ width: size, height: size }} />;
  return <ProductIcon name={name} ogImage={entry?.ogImage ?? null} size={size} category={entry?.category} />;
}

// ---------------------------------------------------------------------------------------------------------------
// 홈 대표 구획(TalkHero)

/** 대표 카드의 출처 칩과 글 뒤 스타 곡선 */
export function TalkLeadFacts({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const { entry, done } = useTalkEntry(mode, slug);
  if (!done) return <Pending minHeight={84} />;
  if (!entry) return null;
  const count = (n: number) => formatNumber(n, locale);
  const growth = entry.starGrowth;
  const firstPost = entry.posts.reduce<TalkPostData | null>((first, post) => !first || post.postedAt < first.postedAt ? post : first, null);
  return (
    <>
      <TalkChips posts={entry.posts} t={t} locale={locale} />
      {growth && (
        <div className="talk-lead-chart">
          <div>
            <b>{growth.delta >= 0 ? "+" : ""}{count(growth.delta)}</b>
            <small>{t(growth.basis === "mention" ? "talk.starsAfterMention" : "talk.starsAfterObservation")}</small>
          </div>
          <TalkSparkline growth={growth} postedAt={firstPost?.postedAt} label={`${count(growth.from)} → ${count(growth.to)}`} />
        </div>
      )}
    </>
  );
}

/** 대표 카드의 원문 토론 단추 — 자세히 보기 옆에 붙는다(받기 전에는 없다) */
export function TalkLeadDiscussion({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const t = useTranslations("browse");
  const { entry } = useTalkEntry(mode, slug);
  const first = entry?.posts[0];
  if (!first) return null;
  return <a href={discussionUrl(first)} target="_blank" rel="noopener" data-track-product={slug}>{t("talk.discussion")} ↗</a>;
}

/** 목록 줄의 짧은 칩 */
export function TalkRowChips({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const { entry, done } = useTalkEntry(mode, slug);
  if (!done) return <Pending inline className="talk-pending-block" minHeight={22} />;
  return entry ? <TalkChips posts={entry.posts} t={t} locale={locale} short /> : null;
}

/** 목록 줄 오른쪽의 스타와 증가 */
export function TalkRowStars({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const locale = useLocale();
  const { entry, done } = useTalkEntry(mode, slug);
  if (!done) return <Pending inline className="talk-row-stars talk-pending-block" minHeight={18} />;
  const count = (n: number) => formatNumber(n, locale);
  return (
    <span className="talk-row-stars">
      {entry && entry.stars !== null && <>★ {count(entry.stars)}</>}
      {entry?.starGrowth && entry.starGrowth.delta > 0 && <> <span className="talk-grow">+{count(entry.starGrowth.delta)}</span></>}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// /talk

/** 머리말 끝의 '마지막 확인' 시각 */
export function TalkCheckedAt({ mode }: { mode: TalkFillMode }) {
  const locale = useLocale();
  const now = useServerNow();
  const t = useTranslations("browse");
  const { data } = useTalkBoard(mode);
  if (!data?.checkedAt) return null;
  return <> · {t("talk.checkedAt", { time: formatDateTime(data.checkedAt, now, locale) })}</>;
}

/** 대표 줄 머리의 '출처 N곳' */
export function TalkSourceCount({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const { entry } = useTalkEntry(mode, slug);
  if (!entry) return null;
  return <> · {t("talk.sourceCount", { count: formatNumber(entry.sources.length, locale) })}</>;
}

/** 글 한 줄씩 — 출처 칩·제목·게시일·원문 토론 */
export function TalkPostLines({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const locale = useLocale();
  const now = useServerNow();
  const t = useTranslations("browse");
  const { entry, done } = useTalkEntry(mode, slug);
  if (!done) return <Pending className="talk-lines" minHeight={22} />;
  if (!entry) return null;
  const count = (n: number) => formatNumber(n, locale);
  return (
    <div className="talk-lines" data-track-product={slug}>
      {entry.posts.slice(0, 3).map((post) => {
        // X·Bluesky 게시물은 본문을 옮기지 않는다 — 반응 수와 링크만
        const reactions = linkOnly(post.source), x = post.source === "x";
        return (
          <div key={postKey(post)} className="talk-line">
            <span className={sourceClass(post.source)}><b>{sourceChip(post)}</b> {t(reactions ? "talk.xScore" : "talk.score", { points: count(post.points), comments: count(post.comments) })}</span>
            {post.kind === "show" && <span className="talk-maker">{t("talk.byMaker")}</span>}
            {reactions ? <span className="talk-line-title">{t(x ? "talk.xPost" : "talk.bskyPost")}</span> : <span className="talk-line-title" lang="en">{post.title}</span>}
            <span>{formatDate(post.postedAt, now, locale)}</span>
            <a className="talk-link" href={discussionUrl(post)} target="_blank" rel="noopener">{t(reactions ? (x ? "talk.viewOnX" : "talk.viewOnBluesky") : "talk.discussion")} ↗</a>
          </div>
        );
      })}
    </div>
  );
}

/** 대표 줄 오른쪽 — 글 뒤 스타 곡선(없으면 지금 스타) */
export function TalkFeatureChart({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const locale = useLocale();
  const now = useServerNow();
  const t = useTranslations("browse");
  const { entry, done } = useTalkEntry(mode, slug);
  if (!done) return <Pending className="talk-feature-chart" minHeight={168} />;
  if (!entry) return null;
  const count = (n: number) => formatNumber(n, locale);
  const growth = entry.starGrowth;
  const firstPosted = entry.posts.length ? new Date(Math.min(...entry.posts.map((post) => post.postedAt.getTime()))) : undefined;
  return (
    <div className="talk-feature-chart">
      <span className="talk-stat">{t(growth?.basis === "observation" ? "talk.starsAfterObservation" : "talk.starsAfterMention")}</span>
      {growth ? <>
        <b>{growth.delta >= 0 ? "+" : ""}{count(growth.delta)}</b>
        <TalkSparkline className="talk-spark-lg" width={520} height={110} growth={growth} postedAt={firstPosted}
          label={`${count(growth.from)} → ${count(growth.to)}`} />
        <span className="talk-caption">
          <span>{formatDate(growth.fromAt, now, locale)} {count(growth.from)}</span>
          <span>{formatDate(growth.toAt, now, locale)} {count(growth.to)}</span>
        </span>
      </> : <b className="talk-stat">{entry.stars !== null ? `★ ${count(entry.stars)}` : "—"}</b>}
    </div>
  );
}

/** 목록 줄 오른쪽 — GitHub 스타와 증가 */
export function TalkEntryStat({ mode, slug }: { mode: TalkFillMode; slug: string }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const { entry, done } = useTalkEntry(mode, slug);
  if (!done) return <Pending className="talk-stat" minHeight={44} />;
  if (!entry) return <div className="talk-stat" />;
  const count = (n: number) => formatNumber(n, locale);
  return (
    <div className="talk-stat">
      <span>{t("talk.stars")}</span>
      <b>{entry.stars !== null ? count(entry.stars) : "—"}</b>
      {entry.starGrowth ? <span className="talk-grow">+{count(entry.starGrowth.delta)}</span> : <span>{t("talk.outOfRange")}</span>}
    </div>
  );
}

/** 옆 칸의 '화제가 된 순간' — 가장 최근 글 여섯 */
export function TalkTimeline({ mode }: { mode: TalkFillMode }) {
  const locale = useLocale();
  const now = useServerNow();
  const t = useTranslations("browse");
  const { data, done } = useTalkBoard(mode);
  if (!done) return <Pending className="talk-box" minHeight={220} />;
  const recent = (data?.entries ?? []).flatMap((entry) => entry.posts.map((post) => ({ post, entry })))
    .sort((a, b) => b.post.postedAt.getTime() - a.post.postedAt.getTime()).slice(0, 6);
  if (!recent.length) return null;
  const count = (n: number) => formatNumber(n, locale);
  return (
    <section className="talk-box" aria-labelledby="talk-timeline-title">
      <h2 id="talk-timeline-title">{t("talk.timeline")}</h2>
      <ol className="talk-timeline">
        {recent.map(({ post, entry }) => (
          <li key={`${entry.slug}:${postKey(post)}`}>
            <span>{formatDate(post.postedAt, now, locale)}</span>
            <span><b>{entry.name}</b> {sourceChip(post, true)} {t(linkOnly(post.source) ? "talk.xScore" : "talk.score", { points: count(post.points), comments: count(post.comments) })}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 화제인데 아직 공개되지 않은 저장소 수 */
export function TalkUnlisted({ mode }: { mode: TalkFillMode }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const { data } = useTalkBoard(mode);
  const unlisted = data?.unlisted;
  if (!unlisted || unlisted.active + unlisted.unknown <= 0) return null;
  const count = (n: number) => formatNumber(n, locale);
  return <p className="talk-unlisted">{t("talk.unlisted", { count: count(unlisted.active + unlisted.unknown), active: count(unlisted.active) })}</p>;
}
