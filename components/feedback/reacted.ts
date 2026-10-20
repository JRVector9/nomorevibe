import { BROWSER_LIST_LIMIT, BROWSER_REACTED_KEY } from "@/lib/me/contract";

/**
 * 이 브라우저가 평가한 제품 slug(Q4) — localStorage, 최근 것이 앞, 최대 500개.
 * 익명 평가 행은 제품별 해시라 서버가 방문자 기준으로 모아 찾을 수 없다. 로그아웃 목록과 계정으로 옮기기가 이 목록으로 찾는다.
 */

const CHUNK = 100;
/** 계정마다 이미 옮긴 slug — 다시 묻지도 보내지도 않는다. 이 브라우저에서 다시 평가하면 그 slug 는 빠진다 */
const MERGED_KEY = "nmb-reacted-merged-v1";
/** 옮기기에 «나중에»를 고른 계정 id */
const LATER_KEY = "nmb-reacted-merge-later-v1";

export function reactedSlugs(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(BROWSER_REACTED_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))].slice(0, BROWSER_LIST_LIMIT) : [];
  } catch {
    return [];
  }
}

function persist(slugs: string[]): void {
  try { localStorage.setItem(BROWSER_REACTED_KEY, JSON.stringify(slugs.slice(0, BROWSER_LIST_LIMIT))); } catch { /* 저장소가 없으면 이 브라우저 목록만 비어 보인다 */ }
}

export function rememberReacted(slug: string): void {
  persist([slug, ...reactedSlugs().filter((item) => item !== slug)]);
  // 로그아웃한 채 다시 남겼으면 새 익명 평가다 — 옮긴 기록에서 빼서 다음에 다시 묻게 한다
  const merged = mergedSlugs();
  if (Object.values(merged).some((slugs) => slugs.includes(slug))) {
    writeJson(MERGED_KEY, Object.fromEntries(Object.entries(merged).map(([user, slugs]) => [user, slugs.filter((item) => item !== slug)])));
  }
}

export function forgetReacted(slug: string): void {
  persist(reactedSlugs().filter((item) => item !== slug));
}

/** 100개씩 나눠 보낸다 — /api/me/reactions/browser 와 /merge 의 한 번 상한 */
export function reactedChunks(slugs = reactedSlugs()): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < slugs.length; index += CHUNK) chunks.push(slugs.slice(index, index + CHUNK));
  return chunks;
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장소가 없으면 다음 방문에 다시 묻는다 */ }
}

function mergedSlugs(): Record<string, string[]> {
  const value = readJson(MERGED_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([user, slugs]) => [user, Array.isArray(slugs) ? slugs.filter((item): item is string => typeof item === "string") : []]));
}

function postponed(userId: number): boolean {
  const later = readJson(LATER_KEY);
  return Array.isArray(later) && later.includes(userId);
}

/**
 * 계정으로 옮길지 물을 이 브라우저의 익명 평가 slug — 이 쿠키의 익명 행이 남은 것만(GET /api/me/reactions/browser).
 * «나중에»를 고른 계정, 이미 옮긴 slug 는 묻지 않는다. 못 읽으면 빈 목록(묻지 않는다).
 */
export async function browserReactionsToMerge(userId: number): Promise<string[]> {
  if (postponed(userId)) return [];
  const done = new Set(mergedSlugs()[userId] ?? []);
  const found: string[] = [];
  for (const slugs of reactedChunks(reactedSlugs().filter((slug) => !done.has(slug)))) {
    try {
      const response = await fetch(`/api/me/reactions/browser?slugs=${encodeURIComponent(slugs.join(","))}`, { cache: "no-store" });
      if (!response.ok) return [];
      found.push(...((await response.json()) as { reactions: { slug: string }[] }).reactions.map((item) => item.slug));
    } catch {
      return [];
    }
  }
  return found;
}

/**
 * 이 브라우저의 익명 평가를 계정에 붙인다(L4, 묻고 나서만) — 계정 id·CSRF 는 로그인 세션의 값. 모든 묶음이 받아졌을 때만
 * 옮긴 기록을 남기고 옮긴 수를 돌려준다. 하나라도 실패하면 null — 익명 행은 그대로라 다음에 다시 옮길 수 있다.
 */
export async function mergeBrowserReactions(userId: number, csrfToken: string, slugs: string[]): Promise<number | null> {
  let merged = 0;
  for (const chunk of reactedChunks(slugs)) {
    try {
      const response = await fetch("/api/me/reactions/merge", {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ slugs: chunk }),
      });
      if (!response.ok) return null;
      merged += Number(((await response.json()) as { merged?: unknown }).merged) || 0;
    } catch {
      return null;
    }
  }
  const records = mergedSlugs();
  writeJson(MERGED_KEY, { ...records, [userId]: [...new Set([...(records[userId] ?? []), ...slugs])].slice(-BROWSER_LIST_LIMIT) });
  return merged;
}

/** «나중에» — 이 계정에는 다시 묻지 않는다. 익명 평가는 그대로 둔다 */
export function postponeReactionMerge(userId: number): void {
  const later = readJson(LATER_KEY);
  writeJson(LATER_KEY, [...new Set([...(Array.isArray(later) ? later : []), userId])]);
}
