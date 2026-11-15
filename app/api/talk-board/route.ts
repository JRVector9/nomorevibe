import { NextResponse } from "next/server";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { talkVisibility } from "@/lib/social/flags";
import { homeTalkEntries, readTalkBoard } from "@/lib/social/home-talk";
import { talkBoardResponse, talkEntryData, type TalkBoardResponse } from "@/lib/social/talk-wire";

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;
const MODES = ["now", "week", "home"] as const;
type BoardMode = (typeof MODES)[number];

/**
 * 화제 채우기(2026-11-15 공개 HTML 이름·요약만) — 홈 대표 구획·/talk 의 서버 HTML 에는 순위 자리·이름·요약·링크만 있다.
 * 표지·글(출처·제목·점수·댓글·링크·날짜)·스타·증가 곡선·확인 시각·공개 전 저장소 수는 브라우저가 여기서 받는다.
 *  - mode=now|week : /talk 목록(화면과 같은 읽기·같은 열쇠, home-talk.ts readTalkBoard)
 *  - mode=home     : 홈 대표 구획에 오른 항목(대표가 맨 앞) — 홈 화면과 같은 읽기
 * 화제 화면이 꺼져 있으면(관리자 미리보기도 아니면) 404. 공개 API 읽기 관문을 그대로 거치고 엣지에 담지 않는다.
 */
export const GET = withRoute("talk.board", async (req: Request) => {
  const refused = await guardPublicApiRead(req, "talk.board");
  if (refused) return refused;
  const mode = new URL(req.url).searchParams.get("mode") ?? "now";
  if (!(MODES as readonly string[]).includes(mode)) return NextResponse.json({ error: "unknown_mode" }, { status: 400, headers: NO_STORE });
  const { visible, preview } = await talkVisibility();
  // 관리자 미리보기 여부가 요청마다 달라 이 거절도 담지 않는다
  if (!visible) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const now = new Date();
  if ((mode as BoardMode) === "home") {
    const { shown } = await homeTalkEntries(now);
    return NextResponse.json({ preview, checkedAt: null, unlisted: null, entries: shown.map(talkEntryData) } satisfies TalkBoardResponse, { headers: NO_STORE });
  }
  const board = await readTalkBoard(mode as "now" | "week", now);
  return NextResponse.json(talkBoardResponse(board, preview), { headers: NO_STORE });
});
