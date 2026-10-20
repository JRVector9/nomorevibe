import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/locales";
import {
  REACTION_COMMENT_LIMIT, REACTION_SOURCES, REACTION_TAG_LIMIT, REACTION_TAGS, REACTION_VERDICTS,
  type ReactionCommentState, type ReactionSource, type ReactionTag, type ReactionVerdict,
} from "@/lib/me/contract";

/**
 * 써봤어요 평가 약속 — 입력 검사·한 줄 자동 검사·하루 변경 횟수(피드백 설계 4절, PR2).
 * DB 를 보지 않는 순수 함수만 둔다. 저장은 repository.ts.
 */

/** 한 행을 KST 하루에 바꿀 수 있는 횟수. 넘으면 마지막 값을 둔다 */
export const REACTION_CHANGES_PER_DAY = 10;
/** 요약은 써본 사람이 셋 이상일 때만 — 한두 명이면 누가 남겼는지 짐작된다 */
export const REACTION_SUMMARY_MIN = 3;
/** 같은 방문자의 /go 기록이 이 기간 안에 있으면 써봄 확인 */
export const TRIED_VERIFY_DAYS = 7;
/** 이 브라우저 목록·합치기가 한 번에 받는 slug 수 */
export const REACTION_SLUG_BATCH = 100;

export type ReactionDevice = "phone" | "desktop";
export type ReactionWrite = {
  verdict: ReactionVerdict; tags: ReactionTag[]; comment: string | null;
  source: ReactionSource; device: ReactionDevice | null; locale: Locale;
  /** 숨은 칸(봇 미끼)에 값이 있었다 — 성공처럼 답하고 버린다 */
  trapped: boolean;
};
export type ReactionMine = {
  verdict: ReactionVerdict; tags: ReactionTag[]; comment: string | null; commentState: ReactionCommentState | null;
  triedVerified: boolean; updatedAt: string;
};
export type ReactionSummary = { tried: number; good: number; meh: number; bad: number };
export type ReactionReply = { body: string; authorName: string; createdAt: string };
export type ReactionListItem = ReactionMine & {
  slug: string; name: string; ogImage: string | null; category: string; reply: ReactionReply | null;
};

export type ReactionErrorCode = "reaction_invalid" | "reaction_not_found" | "reaction_rate_limited" | "reaction_change_limited"
  | "reaction_refused" | "reaction_unavailable" | "reactions_disabled";

export class ReactionError extends Error {
  constructor(public readonly code: ReactionErrorCode, public readonly status: number) {
    super(code);
    this.name = "ReactionError";
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const isReactionSlug = (value: unknown): value is string => typeof value === "string" && SLUG.test(value);

/** 몸통은 읽기 전에 막는다 — 한 줄 140자를 \u 로 적어도 4KB 안에 든다 */
export async function readReactionJson(request: Request): Promise<unknown> {
  const limit = 4 * 1024;
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new ReactionError("reaction_invalid", 415);
  if (Number(request.headers.get("content-length")) > limit || !request.body) throw new ReactionError("reaction_invalid", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("too_large"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ReactionError("reaction_invalid", 400);
  } finally { reader.releaseLock(); }
}

/** 한 줄은 줄바꿈·제어 문자를 띄어쓰기로 바꾸고 앞뒤를 자른다. 글자 수는 DB(varchar)처럼 코드 포인트로 센다 */
export function normalizeReactionComment(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ReactionError("reaction_invalid", 400);
  const text = value.normalize("NFC").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  if (!text) return null;
  if (Array.from(text).length > REACTION_COMMENT_LIMIT) throw new ReactionError("reaction_invalid", 400);
  return text;
}

export function validateReactionWrite(input: unknown): ReactionWrite {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ReactionError("reaction_invalid", 400);
  const value = input as Record<string, unknown>;
  if (!REACTION_VERDICTS.includes(value.verdict as ReactionVerdict)) throw new ReactionError("reaction_invalid", 400);
  const rawTags = value.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.some((tag) => !REACTION_TAGS.includes(tag as ReactionTag))) throw new ReactionError("reaction_invalid", 400);
  // 같은 태그를 두 번 보내면 한 번으로 — 순서는 고정 어휘 순서
  const tags = REACTION_TAGS.filter((tag) => rawTags.includes(tag));
  if (tags.length > REACTION_TAG_LIMIT) throw new ReactionError("reaction_invalid", 400);
  const source = value.source ?? "panel";
  if (!REACTION_SOURCES.includes(source as ReactionSource)) throw new ReactionError("reaction_invalid", 400);
  const device = value.device ?? null;
  if (device !== null && device !== "phone" && device !== "desktop") throw new ReactionError("reaction_invalid", 400);
  const trap = value.website;
  if (trap !== undefined && typeof trap !== "string") throw new ReactionError("reaction_invalid", 400);
  return {
    verdict: value.verdict as ReactionVerdict, tags, comment: normalizeReactionComment(value.comment),
    source: source as ReactionSource, device, locale: isLocale(value.locale) ? value.locale : DEFAULT_LOCALE,
    trapped: Boolean(trap?.trim()),
  };
}

/** 바로 걸리는 주소꼴 — 흔한 최상위 도메인만 본다("Node.js"·"v2.0" 같은 말은 걸지 않는다) */
const LINK = /https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|app|dev|co|kr|me|ly|gg|so|to|xyz|site|online|info|biz|link|click|top|shop|store|page|cc|tv|us|uk|jp|cn|ru|in)\b/i;
const MENTION = /(?:^|[^\p{L}\p{N}_.])@[\p{L}\p{N}_][\p{L}\p{N}_.-]{1,}|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/iu;
/** 같은 글자 여덟 번 이상, 같은 낱말 네 번 이상 */
const REPEATED_CHARACTER = /(.)\1{7,}/u;
const REPEATED_WORD = /(?:^|\s)(\S+)(?:\s+\1){3,}(?:\s|$)/u;
/** 제품 스팸 검사기의 미끼 문구(lib/crawl/spam-signals.ts LURE_PHRASES)와 같은 결의 말 */
const LURE = /visit this (?:link|page) to download|download the application|click the download button|free download for windows|무료\s*크레딧|텔레그램|카톡\s*문의|오픈\s*채팅/i;

/**
 * 익명 한 줄 자동 검사 — 걸리면 거부하지 않고 사람에게 넘긴다(보류). 로그인 댓글(initialFeedbackReview)은 링크 넷부터지만,
 * 익명 한 줄은 링크 하나부터 보류한다. 이유는 comment_reason(40자)에 남는다.
 */
export function reviewReactionComment(comment: string): { state: Exclude<ReactionCommentState, "rejected">; reason: string | null } {
  if (LINK.test(comment)) return { state: "held", reason: "link" };
  if (MENTION.test(comment)) return { state: "held", reason: "mention" };
  if (REPEATED_CHARACTER.test(comment) || REPEATED_WORD.test(comment)) return { state: "held", reason: "repeated" };
  if (LURE.test(comment)) return { state: "held", reason: "lure" };
  return { state: "accepted", reason: null };
}

/** KST 날짜(YYYY-MM-DD) — 하루 변경 횟수는 한국 자정에 다시 센다 */
export function kstDay(at: Date): string {
  return new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 이번 변경 뒤의 changes_today. 같은 KST 날의 한도를 넘으면 null(마지막 값을 둔다) */
export function nextChangeCount(previous: { changesToday: number; updatedAt: Date } | null, now: Date): number | null {
  if (!previous || kstDay(previous.updatedAt) !== kstDay(now)) return 1;
  return previous.changesToday >= REACTION_CHANGES_PER_DAY ? null : previous.changesToday + 1;
}

/** 쉼표로 이은 slug 목록 — 틀린 것은 버리고, 같은 것은 한 번만, 상한까지 */
export function parseReactionSlugs(value: unknown, limit = REACTION_SLUG_BATCH): string[] {
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return [...new Set(items.map((item) => typeof item === "string" ? item.trim() : "").filter(isReactionSlug))].slice(0, limit);
}
