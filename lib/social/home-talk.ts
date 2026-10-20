import type { LocalizedTalkEntry } from "@/components/social/TalkHero";
import type { SocialSource } from "@/lib/db/social-schema";
import { getTranslator } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { localizeProductList } from "@/lib/i18n/products";
import { talkVisibility } from "./flags";
import { homeTalkLineup, listTalk } from "./talk";
import { TALK_SAMPLE_TARGET, talkSamples } from "./talk-samples";

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
  if (entries.length >= TALK_SAMPLE_TARGET) return { lead: realLead, rest: realRest, sources, preview };
  // 실제 화제가 모이기 전: 모자란 자리를 '예시' 카드로 채운다. 1위 자리가 비면 예시가 1위 카드에 서고, 나머지는 목록 끝에 붙는다
  const t = await getTranslator(locale, "browse");
  const nextRank = entries.reduce((max, entry) => Math.max(max, entry.rank), 0) + 1;
  const samples = talkSamples(TALK_SAMPLE_TARGET - entries.length, nextRank, now, n => t("talk.sampleName", { n: String(n) }));
  const sampleLead = realLead ? null : samples.shift() ?? null;
  // 예시 1위 카드는 순위 대신 '예시'를 단다 — 목록의 예시는 실제 다음 순위부터 빈칸 없이
  samples.forEach((sample, index) => { sample.rank = nextRank + index; });
  return { lead: realLead ?? sampleLead, rest: [...realRest, ...samples], preview,
    sources: [...new Set([...sources, ...(sampleLead ? sampleLead.sources : []), ...samples.flatMap(entry => entry.sources)])] };
}
