import { z } from 'zod';
import { splitSearchWindow, type SearchWindow } from '@/lib/crawl/search-window';

export const KoreanQuerySchema = z.object({ label: z.string().min(1).max(40), query: z.string().min(1).max(200), priority: z.number().int().min(0).max(1000) }).strict();
export type KoreanQuery = z.infer<typeof KoreanQuerySchema>;
export const KoreanCursorSchema = z.object({ window: z.object({ from: z.string().datetime(), to: z.string().datetime() }),
  page: z.number().int().min(1).max(10), pendingWindows: z.array(z.object({ from: z.string().datetime(), to: z.string().datetime() })).max(256).default([]),
  waitingUntil: z.string().datetime().optional(), unresolved: z.boolean().optional() }).strict();
export type KoreanCursor = z.infer<typeof KoreanCursorSchema>;
export const KOREAN_QUERY_LEASE_MS = 120_000;
export const KOREAN_UNKNOWN_RETRY_MS = 15 * 60_000;
export const KOREAN_CYCLE_WAIT_MS = 60 * 60_000;

/** A repository search whose query text contains Hangul is a Korean-only search. Oracle is its only runner. */
export function isKoreanRepositoryQuery(query: { kind: string; query: string }): boolean {
  return query.kind === 'repositories' && /[가-힣]/.test(query.query);
}
/**
 * M3 general discovery never runs Korean-only searches, whether Oracle is on or off.
 * The admin list still owns them; the Oracle consumer receives the enabled ones via synchronizeKoreanQueries.
 */
export function m3DiscoveryQueries<Q extends { kind: string; query: string }>(queries: readonly Q[]): Q[] {
  return queries.filter(query => !isKoreanRepositoryQuery(query));
}
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

export function koreanSearchQuery(query: string, window: SearchWindow): string {
  // Explicit public visibility keeps shared cache entries independent of private installation access.
  return `${query} is:public pushed:${window.from}..${window.to}`;
}
export function firstKoreanCursor(startAt: Date, days: number, now: Date): KoreanCursor {
  return { window: { from: iso(startAt.getTime()), to: iso(Math.min(now.getTime(), startAt.getTime() + days * 86400000)) }, page: 1, pendingWindows: [] };
}
/** A saturated/incomplete one-second interval is retained for retry, never reported complete. */
export function nextKoreanCursor(cursor: KoreanCursor, page: { length: number; total?: number; incomplete?: boolean }, days: number, now: Date): KoreanCursor {
  if (page.incomplete || cursor.unresolved || (page.total ?? 0) > 1000 || (cursor.page === 10 && page.length >= 100)) {
    const halves = splitSearchWindow(cursor.window);
    if (!halves || cursor.pendingWindows.length >= 255) {
      if (page.length >= 100 && cursor.page < 10) return { ...cursor, page: cursor.page+1, unresolved: true, waitingUntil: undefined };
      return { ...cursor, page: 1, unresolved: true, waitingUntil: iso(now.getTime() + KOREAN_CYCLE_WAIT_MS) };
    }
    return { window: halves[0], page: 1, pendingWindows: [halves[1], ...cursor.pendingWindows] };
  }
  if (page.length >= 100 && cursor.page < 10) return { ...cursor, page: cursor.page + 1 };
  if (cursor.pendingWindows.length) return { window: cursor.pendingWindows[0], page: 1, pendingWindows: cursor.pendingWindows.slice(1) };
  const after = Date.parse(cursor.window.to) + 1000;
  if (after >= now.getTime()) return { window: cursor.window, page: 1, pendingWindows: [], waitingUntil: iso(now.getTime() + KOREAN_CYCLE_WAIT_MS) };
  return firstKoreanCursor(new Date(after), days, now);
}

/** Each unresolved retry starts a fresh attempt over the same retained interval; a recovered complete response may finish it. */
export function resumeKoreanCursor(cursor: KoreanCursor, days: number, now: Date): KoreanCursor {
  if (!cursor.waitingUntil || Date.parse(cursor.waitingUntil)>now.getTime()) return cursor;
  if (cursor.unresolved) return {window:cursor.window,page:1,pendingWindows:cursor.pendingWindows};
  return firstKoreanCursor(new Date(Date.parse(cursor.window.to)-5*60_000),days,now);
}
