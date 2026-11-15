import type { LocalizedTalkEntry } from "@/components/social/TalkHero";
import type { SocialSource } from "@/lib/db/social-schema";
import { publicRead } from "@/lib/domain/products/public-reads";
import type { Locale } from "@/lib/i18n/locales";
import { localizeProductList } from "@/lib/i18n/products";
import { talkVisibility } from "./flags";
import { homeTalkLineup, listTalk, type TalkBoard, type TalkEntry } from "./talk";
import type { TalkMode } from "./talk-score";

export type HomeTalk = {
  lead: LocalizedTalkEntry | null;
  rest: LocalizedTalkEntry[];
  sources: SocialSource[];
  preview: boolean;
};

/**
 * 화제 목록 읽기 — 화면(홈·/talk)과 채우기 API(/api/talk-board)가 같은 열쇠로 30초 함께 쓴다(public-reads.ts).
 * 서버 HTML 은 이름·요약만 그리고 나머지 칸은 API 가 같은 값으로 채우므로 DB 를 두 번 읽지 않는다.
 */
export function readTalkBoard(mode: TalkMode, now: Date, limit?: number): Promise<TalkBoard> {
  return publicRead("list", ["talk-board", mode, limit ?? null], () => listTalk({ mode, now, limit }));
}

/** 홈 대표 구획에 오르는 항목(대표가 있으면 맨 앞)과 출처 — 언어와 관계없다. 화면과 채우기 API 가 함께 쓴다 */
export async function homeTalkEntries(now: Date): Promise<{ lead: TalkEntry | null; shown: TalkEntry[]; sources: SocialSource[] }> {
  const board = await readTalkBoard("now", now, 20);
  const { lead, rest } = homeTalkLineup(board.entries);
  return { lead, shown: [...(lead ? [lead] : []), ...rest], sources: [...new Set(board.entries.flatMap(entry => entry.sources))] };
}

/** 홈 대표 구획의 재료 — 화면을 켰거나 관리자 미리보기일 때만 읽는다. 아니면 null */
export async function loadHomeTalk(now: Date, locale: Locale): Promise<HomeTalk | null> {
  const { visible, preview } = await talkVisibility();
  if (!visible) return null;
  const { lead, shown, sources } = await homeTalkEntries(now);
  const localized = await localizeProductList(shown.map(entry => entry.product), locale);
  const entries = shown.map((entry, index) => ({ ...entry, product: localized[index] }));
  const realLead = lead ? entries[0] : null, realRest = lead ? entries.slice(1) : entries;
  return { lead: realLead, rest: realRest, sources, preview };
}
