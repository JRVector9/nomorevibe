import type { LocalizedTalkEntry } from "@/components/social/TalkHero";
import type { SocialSource } from "@/lib/db/social-schema";
import type { Locale } from "@/lib/i18n/locales";
import { localizeProductList } from "@/lib/i18n/products";
import { talkVisibility } from "./flags";
import { homeTalkLineup, listTalk } from "./talk";

export type HomeTalk = {
  lead: LocalizedTalkEntry | null;
  rest: LocalizedTalkEntry[];
  sources: SocialSource[];
  preview: boolean;
};

/** 홈 대표 구획의 재료 — 화면을 켰거나 관리자 미리보기일 때만 읽는다. 아니면 null */
export async function loadHomeTalk(now: Date, locale: Locale): Promise<HomeTalk | null> {
  const { visible, preview } = await talkVisibility();
  if (!visible) return null;
  const board = await listTalk({ mode: "now", now, limit: 20 });
  const { lead, rest } = homeTalkLineup(board.entries);
  const shown = [...(lead ? [lead] : []), ...rest];
  const localized = await localizeProductList(shown.map(entry => entry.product), locale);
  const entries = shown.map((entry, index) => ({ ...entry, product: localized[index] }));
  const realLead = lead ? entries[0] : null, realRest = lead ? entries.slice(1) : entries;
  const sources = [...new Set(board.entries.flatMap(entry => entry.sources))];
  return { lead: realLead, rest: realRest, sources, preview };
}
