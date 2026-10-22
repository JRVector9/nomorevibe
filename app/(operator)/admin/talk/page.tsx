import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Panel } from "@/components/Panel";
import { discussionUrl, SOURCE_NAME, sourceChip } from "@/components/social/talk-format";
import { currentAdmin } from "@/lib/auth/admin";
import type { SocialSource } from "@/lib/db/schema";
import { formatListTime } from "@/lib/format/time";
import { blueskyTalkJobState, hnTalkJobState, listTalkPostsPage, TALK_ADMIN_PAGE_SIZE, talkAdminFilter, type TalkAdminFilter } from "@/lib/social/admin";
import { blueskyPostKey } from "@/lib/social/bluesky-link";
import { talkPublicEnabled } from "@/lib/social/flags";
import { SOCIAL_RETENTION_MS } from "@/lib/social/hn-talk";
import { BLUESKY_FRESH_MS, homeTalkLineup, listTalk, TALK_LIST_LIMIT, X_FRESH_MS } from "@/lib/social/talk";
import { thresholdLabel } from "@/lib/social/talk-reasons";
import { TALK_VISIBLE_MS } from "@/lib/social/talk-score";
import { pageWindow } from "../paging";
import { TalkHomeBoard, type TalkHomeRow } from "./TalkHomeBoard";
import { TalkPostsBoard } from "./TalkPostsBoard";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "SNS 화제 — NoMoreVibe", robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const RETENTION_DAYS = Math.round(SOCIAL_RETENTION_MS / 86_400_000);
const VISIBLE_DAYS = Math.round(TALK_VISIBLE_MS / 86_400_000);
const X_HOURS = Math.round(X_FRESH_MS / 3_600_000);
const BLUESKY_HOURS = Math.round(BLUESKY_FRESH_MS / 3_600_000);

/** 본문을 받지 않는 출처(X·Bluesky)의 글 이름 — 게시물 ID 로 붙인다 */
function postName(post: { source: SocialSource; title: string; externalId: string }): string {
  if (post.title) return post.title;
  return post.source === "bluesky" ? `Bluesky 게시물 ${blueskyPostKey(post.externalId)}` : `X 게시물 ${post.externalId}`;
}

/** 글이 가리킨 주소 — 저장소가 아닌 글(github.io·gist 등)이 어디를 가리키는지 호스트로 한눈에. http(s) 가 아니면 링크를 달지 않는다 */
function linkOf(url: string): { linkUrl: string | null; linkHost: string } {
  try {
    const parsed = new URL(url);
    return { linkUrl: parsed.protocol === "https:" || parsed.protocol === "http:" ? url : null, linkHost: parsed.host || url.slice(0, 60) };
  } catch {
    return { linkUrl: null, linkHost: url.slice(0, 60) };
  }
}

/**
 * SNS 화제(C안) 운영 — 홈 1위 확인, 수집한 글 전부(HN·X·Bluesky, 모든 상태) 보기·숨기기, 저장소를 화제에서 빼기.
 * 수집은 crawler 의 hn-talk·bluesky-talk 잡(30분)과 X 보고, 공개 여부는 SNS_TALK_PUBLIC_ENABLED.
 */
export default async function AdminTalkPage({ searchParams }: Props) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const filter = talkAdminFilter({ source: first(params.source), state: first(params.state), link: first(params.link), talk: first(params.talk), sort: first(params.sort) });
  const parsedPage = Number(first(params.page) ?? 1);
  const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const now = new Date();
  const [board, listed, job, blueskyJob] = await Promise.all([
    listTalk({ mode: "now", now, limit: 15 }),
    listTalkPostsPage(filter, { now, page }),
    hnTalkJobState(),
    blueskyTalkJobState(),
  ]);
  const { summary } = listed;
  const lineup = homeTalkLineup(board.entries);
  const place = (key: string): TalkHomeRow["onHome"] => lineup.lead?.repositoryKey === key ? "lead"
    : lineup.waiting.some(entry => entry.repositoryKey === key) ? "waiting"
    : lineup.rest.some(entry => entry.repositoryKey === key) ? "rest" : null;
  const homeRows: TalkHomeRow[] = board.entries.map(entry => ({
    rank: entry.rank, repositoryKey: entry.repositoryKey, slug: entry.product.slug, name: entry.product.name,
    best: entry.posts[0] ? `${sourceChip(entry.posts[0], true)} ${entry.posts[0].points}점 · 댓글 ${entry.posts[0].comments}` : "",
    decision: entry.homeDecision, onHome: place(entry.repositoryKey),
  }));
  const publicOn = talkPublicEnabled();
  const pages = Math.max(1, Math.ceil(listed.total / TALK_ADMIN_PAGE_SIZE));
  const count = (n: number) => n.toLocaleString("ko-KR");
  const seen = (source: SocialSource) => summary.lastSeenAt[source] ? formatListTime(summary.lastSeenAt[source]!.toISOString(), now.toISOString()) : "아직 없음";

  // 거르기를 이어 가고, 거르기가 바뀌면 첫 쪽부터
  const href = (next: Partial<TalkAdminFilter> & { page?: number }) => {
    const merged = { ...filter, ...next };
    const query = new URLSearchParams();
    if (merged.source !== "all") query.set("source", merged.source);
    if (merged.state !== "all") query.set("state", merged.state);
    if (merged.link !== "all") query.set("link", merged.link);
    if (merged.talk !== "all") query.set("talk", merged.talk);
    if (merged.sort !== "recent") query.set("sort", merged.sort);
    if ((next.page ?? 1) > 1) query.set("page", String(next.page));
    return `/admin/talk${query.size ? `?${query}` : ""}`;
  };
  const filterRows: { title: string; options: { label: string; count?: number; next: Partial<TalkAdminFilter>; active: boolean }[] }[] = [
    { title: "출처", options: [
      { label: "전체", count: summary.total, next: { source: "all" }, active: filter.source === "all" },
      ...(["hn", "x", "bluesky", "geeknews"] as const).filter(source => source !== "geeknews" || summary.source.geeknews > 0)
        .map(source => ({ label: SOURCE_NAME[source], count: summary.source[source], next: { source }, active: filter.source === source })),
    ] },
    { title: "상태", options: [
      { label: "전체", next: { state: "all" }, active: filter.state === "all" },
      { label: "보임", count: summary.state.visible, next: { state: "visible" }, active: filter.state === "visible" },
      { label: "숨김", count: summary.state.hidden, next: { state: "hidden" }, active: filter.state === "hidden" },
      { label: "원문 삭제", count: summary.state.gone, next: { state: "gone" }, active: filter.state === "gone" },
    ] },
    { title: "제품 연결", options: [
      { label: "전체", next: { link: "all" }, active: filter.link === "all" },
      { label: "제품 있음", count: summary.link.product, next: { link: "product" }, active: filter.link === "product" },
      { label: "제품 없음", count: summary.link.none, next: { link: "none" }, active: filter.link === "none" },
      { label: "저장소 아님", count: summary.link.site, next: { link: "site" }, active: filter.link === "site" },
    ] },
    { title: "/talk", options: [
      { label: "전체", next: { talk: "all" }, active: filter.talk === "all" },
      { label: "보임", count: summary.talk.on, next: { talk: "on" }, active: filter.talk === "on" },
      { label: "안 보임", count: summary.talk.off, next: { talk: "off" }, active: filter.talk === "off" },
    ] },
    { title: "순서", options: [
      { label: "최근 게시", next: { sort: "recent" }, active: filter.sort === "recent" },
      { label: "점수", next: { sort: "points" }, active: filter.sort === "points" },
    ] },
  ];

  return (
    <main className="mx-auto max-w-[1200px] px-6 pb-20"><PageStamp />
      <div className="flex flex-wrap items-baseline gap-3 pt-6">
        <h1 className="text-[22px] font-extrabold tracking-tight">SNS 화제</h1>
        <span className="text-[13px] text-fg-3">{admin.login}</span>
      </div>
      <p className="mt-2 max-w-[80ch] text-[13.5px] leading-[1.7] text-fg-2">
        Hacker News에서 주소가 github.com인 글을 30분마다(hn-talk), X에서 GitHub 저장소를 가리킨 게시물을 받아,
        Bluesky에서 GitHub를 가리킨 게시물을 30분마다(bluesky-talk) 기록합니다.
        검색이 돌려준 글은 저장소가 아니어도 버리지 않고 <a href="#posts" className="text-accent hover:underline">수집한 글 전부</a>에 {RETENTION_DAYS}일 동안 남깁니다.
        Bluesky는 봇으로 보이는 계정·라벨 붙은 글도 남기되 숨김(까닭은 /talk 칸)으로 두고, 원문이 지워진 글은 7일 뒤 지웁니다.
        /talk·홈·상세에는 공개 제품에 이어진 글 중 기준({thresholdLabel("hn")}, {thresholdLabel("x")}, {thresholdLabel("bluesky")})을 넘은 저장소만, 최근 {VISIBLE_DAYS}일 글만 오릅니다(X·Bluesky는 마지막 확인 뒤 {X_HOURS}·{BLUESKY_HOURS}시간).
        홈 첫 화면 1위는 여기서 허용한 제품만 오릅니다.
      </p>
      <p className="mt-2 text-[13px] text-fg-2">
        공개: <b className={publicOn ? "text-up" : "text-fg"}>{publicOn ? "켜짐" : "꺼짐 — 관리자에게만 미리보기"}</b>
        {" · "}HN 마지막 수집: {job?.lastRunAt ? formatListTime(job.lastRunAt.toISOString(), now.toISOString()) : "아직 없음"}
        {job?.lastError && <span className="text-down"> · 마지막 오류 {job.lastError.slice(0, 120)}</span>}
        {" · "}X 마지막 확인: {seen("x")}
        {" · "}Bluesky 마지막 수집: {blueskyJob?.lastRunAt ? formatListTime(blueskyJob.lastRunAt.toISOString(), now.toISOString()) : "아직 없음"}
        {blueskyJob?.lastError && <span className="text-down"> · 마지막 오류 {blueskyJob.lastError.slice(0, 120)}</span>}
        {" · "}<a href="/talk" target="_blank" rel="noopener" className="text-accent hover:underline">/talk 미리보기</a>
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <Panel title="홈 1위 확인" note={`지금 순위 상위 ${homeRows.length}개. 허용하지 않은 제품이 1위면 1위 자리를 건너뛰고 다음 허용 제품이 섭니다. 2~5위 목록은 허용을 기다리지 않습니다.`}>
          <TalkHomeBoard rows={homeRows} />
        </Panel>
        <div id="posts" className="scroll-mt-4">
          <Panel title="수집한 글 전부"
            note={`HN·X·Bluesky에서 모은 글을 상태와 관계없이 모두 보여 줍니다(보관 ${RETENTION_DAYS}일 · 전체 ${count(summary.total)}건, 단추 옆 숫자는 거르기 전 전체 기준). 글마다 지금 /talk에 보이는지, 아니면 왜 아닌지 적습니다(순위는 '지금' 기준, ${TALK_LIST_LIMIT}위까지 보임). 숨긴 글은 다시 수집돼도 숨긴 채로 남습니다. 저장소를 빼면 그 저장소의 모든 글이 화면에서 빠집니다.${board.unlisted.active + board.unlisted.unknown > 0 ? ` 화제인데 아직 공개 제품이 아닌 저장소 ${board.unlisted.active + board.unlisted.unknown}개(심사 중 ${board.unlisted.active}).` : ""}`}>
            <div className="mb-3 flex flex-col gap-2">
              {filterRows.map(row => (
                <nav key={row.title} className="flex flex-wrap items-center gap-2" aria-label={`${row.title} 거르기`}>
                  <span className="w-16 shrink-0 text-[13px] font-semibold text-fg-3">{row.title}</span>
                  {row.options.map(option => (
                    <Link key={option.label} href={href(option.next)} aria-current={option.active ? "page" : undefined}
                      className={`rounded-full border px-3 py-1 text-[13px] ${option.active ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-fg-2"}`}>
                      {option.label}{option.count !== undefined && ` ${count(option.count)}`}
                    </Link>
                  ))}
                </nav>
              ))}
              <p className="text-[13px] text-fg-3">
                거른 결과 {count(listed.total)}건{pages > 1 ? ` · ${page}/${pages} 쪽 · ${TALK_ADMIN_PAGE_SIZE}건씩` : ""}
              </p>
            </div>
            <TalkPostsBoard
              key={href({ page })}
              now={now.toISOString()}
              rows={listed.rows.map(post => ({
                id: post.id, source: post.kind === "show" && post.source === "hn" ? "Show HN" : SOURCE_NAME[post.source], kind: post.kind,
                // X·Bluesky 는 본문을 받지 않는다 — 게시물 ID 로 이름을 붙인다
                title: postName(post),
                discussionUrl: discussionUrl(post), ...linkOf(post.linkUrl), linkTarget: post.linkTarget,
                repositoryKey: post.repositoryKey, points: post.points, comments: post.comments, frontPage: post.frontPage,
                postedAt: post.postedAt.toISOString(), firstSeenAt: post.firstSeenAt.toISOString(), lastSeenAt: post.lastSeenAt.toISOString(),
                state: post.state, excluded: post.excluded, product: post.product ? { slug: post.product.slug, status: post.product.status } : null,
                talk: { shown: post.talk.shown, rank: post.talk.rank, reasons: post.talk.reasons.map(reason => reason.label) },
              }))} />
            {pages > 1 && (
              <nav aria-label="수집한 글 쪽 이동" className="mt-3 flex flex-wrap items-center gap-1 text-[13px]">
                {page > 1 && <Link href={href({ page: page - 1 })} className="rounded-lg border border-line px-2.5 py-1">이전</Link>}
                {pageWindow(page, pages).map((item, i) => item === null
                  ? <span key={`gap-${i}`} className="px-1 text-fg-3">…</span>
                  : <Link key={item} href={href({ page: item })} aria-current={item === page ? "page" : undefined}
                      className={`min-w-8 rounded-lg border px-2.5 py-1 text-center font-mono ${item === page ? "border-accent bg-accent text-white" : "border-line text-fg-2"}`}>{item}</Link>)}
                {page < pages && <Link href={href({ page: page + 1 })} className="rounded-lg border border-line px-2.5 py-1">다음</Link>}
              </nav>
            )}
          </Panel>
        </div>
      </div>
    </main>
  );
}
