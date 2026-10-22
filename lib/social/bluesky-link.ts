/**
 * Bluesky 게시물 주소 — 글 ID(external_id = "<did>/<rkey>")로 만든다. 화면(talk-format)과 수집기가 같이 쓴다.
 *
 * at-uri(at://<did>/app.bsky.feed.post/<rkey>)의 DID 는 원문 링크(bsky.app/profile/<did>/post/<rkey>)와
 * 지운 글 다시 묻기(getPosts)에 꼭 필요한 글 주소의 일부라 남긴다. 핸들·이름·본문은 받지도 남기지도 않는다.
 */
const DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.%-]{1,40})$/;
const RKEY = /^[a-zA-Z0-9._~-]{1,15}$/;
/** external_id 칸(varchar 64)에 드는 길이까지만 받는다 — did:plc(32자) + / + TID(13자)는 46자다 */
export const BLUESKY_EXTERNAL_ID_MAX = 64;

/** at-uri → "<did>/<rkey>". 게시물(app.bsky.feed.post)이 아니거나 모양이 다르면 null */
export function blueskyExternalId(uri: string): string | null {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri);
  if (!match || !DID.test(match[1]) || !RKEY.test(match[2])) return null;
  const id = `${match[1]}/${match[2]}`;
  return id.length <= BLUESKY_EXTERNAL_ID_MAX ? id : null;
}

function parts(externalId: string): [string, string] | null {
  const slash = externalId.lastIndexOf("/");
  const did = externalId.slice(0, slash), rkey = externalId.slice(slash + 1);
  return slash > 0 && DID.test(did) && RKEY.test(rkey) ? [did, rkey] : null;
}

/** "<did>/<rkey>" → at-uri. 모양이 다르면 null */
export function blueskyAtUri(externalId: string): string | null {
  const split = parts(externalId);
  return split ? `at://${split[0]}/app.bsky.feed.post/${split[1]}` : null;
}

/** 원문 게시물 주소. 모양이 다르면 Bluesky 첫 화면 */
export function blueskyPostUrl(externalId: string): string {
  const split = parts(externalId);
  return split ? `https://bsky.app/profile/${split[0]}/post/${split[1]}` : "https://bsky.app/";
}

/** 게시물 끝 이름(rkey) — 관리자 화면 이름표 */
export const blueskyPostKey = (externalId: string) => parts(externalId)?.[1] ?? externalId.slice(0, 16);
