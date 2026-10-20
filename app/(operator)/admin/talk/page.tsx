import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Panel } from "@/components/Panel";
import { discussionUrl, SOURCE_NAME, sourceChip } from "@/components/social/talk-format";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { hnTalkJobState, listTalkPostsForAdmin } from "@/lib/social/admin";
import { talkPublicEnabled } from "@/lib/social/flags";
import { homeTalkLineup, listTalk } from "@/lib/social/talk";
import { TALK_VISIBLE_MS } from "@/lib/social/talk-score";
import { TalkHomeBoard, type TalkHomeRow } from "./TalkHomeBoard";
import { TalkPostsBoard } from "./TalkPostsBoard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "SNS 화제 — NoMoreVibe", robots: { index: false } };

/**
 * SNS 화제(C안) 운영 — 홈 1위 확인, 글 숨기기, 저장소를 화제에서 빼기.
 * 수집은 crawler 의 hn-talk 잡(30분), 공개 여부는 SNS_TALK_PUBLIC_ENABLED.
 */
export default async function AdminTalkPage() {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const now = new Date();
  const [board, posts, job] = await Promise.all([
    listTalk({ mode: "now", now, limit: 15 }),
    listTalkPostsForAdmin(new Date(now.getTime() - TALK_VISIBLE_MS)),
    hnTalkJobState(),
  ]);
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

  return (
    <main className="mx-auto max-w-[1100px] px-6 pb-20">
      <div className="flex flex-wrap items-baseline gap-3 pt-6">
        <h1 className="text-[22px] font-extrabold tracking-tight">SNS 화제</h1>
        <span className="text-[13px] text-fg-3">{admin.login}</span>
      </div>
      <p className="mt-2 max-w-[72ch] text-[13.5px] leading-[1.7] text-fg-2">
        Hacker News에서 GitHub 저장소를 가리킨 글을 30분마다 기록합니다(hn-talk). 공개 제품에 이어진 글 중 30점 또는 댓글 15개를 넘은 것만 /talk·홈·상세에 오릅니다.
        홈 첫 화면 1위는 여기서 허용한 제품만 오릅니다.
      </p>
      <p className="mt-2 text-[13px] text-fg-2">
        공개: <b className={publicOn ? "text-up" : "text-fg"}>{publicOn ? "켜짐" : "꺼짐 — 관리자에게만 미리보기"}</b>
        {" · "}마지막 수집: {job?.lastRunAt ? formatListTime(job.lastRunAt.toISOString(), now.toISOString()) : "아직 없음"}
        {job?.lastError && <span className="text-down"> · 마지막 오류 {job.lastError.slice(0, 120)}</span>}
        {" · "}<a href="/talk" target="_blank" rel="noopener" className="text-accent hover:underline">/talk 미리보기</a>
      </p>

      <div className="mt-6 flex flex-col gap-4">
        <Panel title="홈 1위 확인" note={`지금 순위 상위 ${homeRows.length}개. 허용하지 않은 제품이 1위면 1위 자리를 건너뛰고 다음 허용 제품이 섭니다. 2~5위 목록은 허용을 기다리지 않습니다.`}>
          <TalkHomeBoard rows={homeRows} />
        </Panel>
        <Panel title="화제 글 (최근 7일)" note={`기록한 글 ${posts.length}건 · 점수 큰 순. 숨긴 글은 다시 수집돼도 숨긴 채로 남습니다. 저장소를 빼면 그 저장소의 모든 글이 화면에서 빠집니다.${board.unlisted.active + board.unlisted.unknown > 0 ? ` 화제인데 아직 공개 제품이 아닌 저장소 ${board.unlisted.active + board.unlisted.unknown}개(심사 중 ${board.unlisted.active}).` : ""}`}>
          <TalkPostsBoard now={now.toISOString()} rows={posts.map(post => ({
            id: post.id, source: post.kind === "show" && post.source === "hn" ? "Show HN" : SOURCE_NAME[post.source], kind: post.kind,
            // X 는 본문을 받지 않는다 — 게시물 ID 로 이름을 붙인다
            title: post.title || `X 게시물 ${post.externalId}`,
            discussionUrl: discussionUrl(post), linkTarget: post.linkTarget, repositoryKey: post.repositoryKey, points: post.points, comments: post.comments,
            postedAt: post.postedAt.toISOString(), state: post.state, excluded: post.excluded, product: post.product,
          }))} />
        </Panel>
      </div>
    </main>
  );
}
