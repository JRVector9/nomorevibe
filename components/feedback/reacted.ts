import { BROWSER_LIST_LIMIT, BROWSER_REACTED_KEY } from "@/lib/me/contract";

/**
 * 이 브라우저가 평가한 제품 slug(Q4) — localStorage, 최근 것이 앞, 최대 500개.
 * 익명 평가 행은 제품별 해시라 서버가 방문자 기준으로 모아 찾을 수 없다. 로그아웃 목록과 첫 로그인 합치기가 이 목록으로 찾는다.
 */

const CHUNK = 100;

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

/**
 * 로그인 직후 한 번 — 이 브라우저의 익명 평가를 계정에 붙인다(L4). csrfToken 은 /api/me 의 값.
 * 실패해도 던지지 않는다: 익명 행은 그대로 남아 다음에 다시 합칠 수 있다. 옮긴 수를 돌려준다.
 */
export async function mergeBrowserReactions(csrfToken: string): Promise<number> {
  let merged = 0;
  for (const slugs of reactedChunks()) {
    try {
      const response = await fetch("/api/me/reactions/merge", {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify({ slugs }),
      });
      if (!response.ok) break;
      merged += Number(((await response.json()) as { merged?: unknown }).merged) || 0;
    } catch {
      break;
    }
  }
  return merged;
}
