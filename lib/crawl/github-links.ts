/**
 * 페이지가 공개한 GitHub 링크.
 *
 * 제작자가 자기 페이지에 GitHub 링크를 걸어 두었다면 그 페이지는 프로젝트의 집이다 — 남의 글·목록
 * 페이지가 아니다(2026-09-19 사용자 결정: 깃헙 링크를 공개한 페이지는 승인 대상).
 *
 * site-fingerprint 의 extractSiteRepositoryKeys 와 따로 둔다. 그쪽은 "이 사이트의 소스는 이 저장소 하나"를
 * 확정하는 증거라 "Source code"처럼 이름 붙은 링크만 센다. 여기서는 아이콘이나 "GitHub" 글자로만 걸린
 * 링크도 센다 — Lody 는 그쪽 기준으로 0건이었다.
 */

/** github.com 첫 경로가 사람·조직이 아닌 것 */
const RESERVED = new Set([
  "about", "apps", "collections", "contact", "customer-stories", "enterprise", "events", "explore", "features",
  "join", "login", "marketplace", "new", "notifications", "orgs", "pricing", "readme", "security", "settings",
  "signup", "site", "solutions", "sponsors", "team", "topics", "trending",
]);
const MAX_LINKS = 20;

/** 링크를 owner 또는 owner/repo(소문자)로 모은다. 순서는 처음 나온 순, 최대 20개 */
export function extractGithubLinks(html: string, baseUrl: string): string[] {
  const keys: string[] = [];
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    let url: URL;
    try { url = new URL(match[1] ?? match[2], baseUrl); } catch { continue; }
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname)) continue;
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || RESERVED.has(owner.toLowerCase()) || !/^[a-z0-9-]{1,39}$/i.test(owner)) continue;
    const name = repo?.replace(/\.git$/i, "");
    const key = (name && /^[a-z0-9._-]{1,100}$/i.test(name) ? `${owner}/${name}` : owner).toLowerCase();
    if (!keys.includes(key)) keys.push(key);
    if (keys.length >= MAX_LINKS) break;
  }
  return keys;
}

/** 후보 레포의 주인(사람·조직)에게 가는 GitHub 링크가 페이지에 있는가 */
export function linksOwnGithub(repo: string, links: readonly string[] | null | undefined): boolean {
  const owner = repo.split("/")[0]?.toLowerCase();
  return Boolean(owner) && (links ?? []).some((key) => key.split("/")[0] === owner);
}
