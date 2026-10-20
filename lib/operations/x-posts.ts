import { createHmac } from "node:crypto";

/**
 * X 수집기(osaka-smoke)가 보내는 게시물 관측 — 서명한 push 로 받아 social_posts(source=x)에 둔다(SNS 화제 C안 T18).
 *
 * 받는 쪽은 app/api/ops/x-posts/route.ts, 보내는 쪽은 lib/social/x-report.ts 다. 비밀은 하루 보고(x-status)와 같은 것을 쓰고,
 * 서명 머리만 달라 한 주소의 서명을 다른 주소에 다시 쓸 수 없다. 비밀이 없으면 주소는 404 다.
 * 게시물마다 ID·작성 시각·저장소 하나·공개 반응 수만 받는다. 본문·작성자·프로필·원 응답은 받지 않는다(재배포는 ID 중심).
 */
export const X_POSTS_KEY = "x-posts";
export const X_POSTS_MAX_BODY_BYTES = 16_384;
/** 수집기는 하루 한 번 검색 한 페이지(최대 10건)만 읽는다 */
export const X_POSTS_MAX_POSTS = 10;
const SIGNING_PREFIX = "nomorevibe-x-posts-v1";
const METRIC_MAX = 1_000_000_000;

export type XPostMetrics = { like: number; reply: number; repost: number; quote: number };
export type XPostReport = { id: string; createdAt: string; repository: string; metrics: XPostMetrics };
export type XPostsReport = {
  v: 1;
  /** 수집기가 검색한 시각 */
  observedAt: string;
  /** 저장소 하나만 가리키고 반응 수가 모두 있는 공개 게시물 */
  posts: XPostReport[];
  /** 이번 검색에서 사용할 수 없다고 나온 게시물 ID — 이미 받은 것이면 내린다 */
  unavailable: string[];
};

/** HMAC-SHA256(비밀, "nomorevibe-x-posts-v1\n<보낸 시각>\n" + 본문 바이트) */
export function xPostsDigest(secret: string, timestamp: number, body: string | Uint8Array): Buffer {
  return createHmac("sha256", secret).update(`${SIGNING_PREFIX}\n${timestamp}\n`).update(body).digest();
}

export function signXPosts(secret: string, timestamp: number, body: string | Uint8Array): string {
  return `v1=${xPostsDigest(secret, timestamp, body).toString("hex")}`;
}

const POST_ID = /^[1-9]\d{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const metric = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= METRIC_MAX;

/** UTC ISO 시각 — 보낸 시각보다 뒤일 수 없고, 없는 날짜는 틀림 */
function instant(value: unknown, notAfterMs: number): string | null {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > notAfterMs) return null;
  const normalized = new Date(ms).toISOString();
  return normalized.slice(0, 19) === value.slice(0, 19) ? normalized : null;
}

/** 저장소 하나 — . 과 .. 은 이름이 아니다 */
const repository = (value: unknown): value is string => typeof value === "string" && REPOSITORY.test(value)
  && !value.split("/").some(part => part === "." || part === "..");

/** 받은 본문의 엄격한 형식 — 칸이 더 있거나 빠지거나 범위를 벗어나면 null */
export function parseXPostsReport(value: unknown, sentAt: number): XPostsReport | null {
  if (!isRecord(value) || !hasExactKeys(value, ["v", "observedAt", "posts", "unavailable"]) || value.v !== 1) return null;
  const notAfterMs = (sentAt + 1) * 1_000;
  const observedAt = instant(value.observedAt, notAfterMs);
  if (!observedAt || !Array.isArray(value.posts) || !Array.isArray(value.unavailable)) return null;
  if (value.posts.length > X_POSTS_MAX_POSTS || value.unavailable.length > X_POSTS_MAX_POSTS) return null;
  const posts: XPostReport[] = [];
  for (const item of value.posts) {
    if (!isRecord(item) || !hasExactKeys(item, ["id", "createdAt", "repository", "metrics"])) return null;
    const createdAt = instant(item.createdAt, Date.parse(observedAt));
    const metrics = item.metrics;
    if (typeof item.id !== "string" || !POST_ID.test(item.id) || !createdAt || !repository(item.repository)) return null;
    if (!isRecord(metrics) || !hasExactKeys(metrics, ["like", "reply", "repost", "quote"])
      || !metric(metrics.like) || !metric(metrics.reply) || !metric(metrics.repost) || !metric(metrics.quote)) return null;
    posts.push({ id: item.id, createdAt, repository: item.repository,
      metrics: { like: metrics.like, reply: metrics.reply, repost: metrics.repost, quote: metrics.quote } });
  }
  if (!value.unavailable.every(id => typeof id === "string" && POST_ID.test(id))) return null;
  const ids = [...posts.map(post => post.id), ...value.unavailable as string[]];
  // 한 게시물은 한 번만, 그리고 보임과 사용 불가 중 하나로만
  if (new Set(ids).size !== ids.length) return null;
  return { v: 1, observedAt, posts, unavailable: [...value.unavailable as string[]] };
}

/**
 * 화제 점수에 쓰는 값 — 점수는 좋아요 + 재게시×2, 댓글 칸에는 답글(SNS 화제·홍보 설계 4장 X 무게).
 * 인용은 따로 세지 않는다(재게시와 겹치는 확산이라 두 번 세지 않는다).
 */
export const xPoints = (metrics: XPostMetrics) => ({ points: metrics.like + metrics.repost * 2, comments: metrics.reply });
