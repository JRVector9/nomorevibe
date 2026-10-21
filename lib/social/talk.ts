import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  products, productStarObservations, socialPosts, socialTalkDecisions,
  type SocialLinkTarget, type SocialPostKind, type SocialSource, type TaglineSource, type TalkHomeDecision,
} from "@/lib/db/schema";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { taglineKo } from "@/lib/domain/products/korean-tagline";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { listedByDefault, notAuditHeld, notDown, repoGone } from "@/lib/domain/products/repository";
import { repositoryTalkScore, TALK_VISIBLE_MS, talkQualifies, type TalkMode } from "./talk-score";

/**
 * 화제 읽기 — /talk·홈 대표 구획·상세 화제 띠가 읽는다(SNS 화제·홍보 설계 C안).
 *
 * 공개 제품(seeded·verified, 응답 있음, 기본 목록, 감사 보류 아님, 저장소 살아 있음)에 이어진 글만 오른다. 관리자가 뺀 저장소는 빠진다.
 * 이슈·PR 을 가리킨 글은 상세에서만 보이고 순위에는 세지 않는다 — 저장소 자체가 아니라 그 안의 토론이다.
 */
/** 상세 화제 기록을 남기는 기간(시안 Q3 권장: 관측 보관과 같은 90일) */
export const TALK_DETAIL_MS = 90 * 86_400_000;
const RANKED_TARGETS: SocialLinkTarget[] = ["repo", "path"];
/** products_repository_identity_idx 와 같은 식 — 저장소 키로 제품을 찾을 때 이 인덱스를 탄다(ai-level-refresh.ts) */
const PRODUCT_IDENTITY = sql`regexp_replace(regexp_replace(lower(rtrim(${products.repoUrl}, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')`;
/** 쓸 때 만든다 — 모듈을 불러오는 것만으로 제품 조건을 읽지 않게(홈 화면 테스트가 그 모듈을 가짜로 바꾼다) */
const publicProduct = () => and(inArray(products.status, ["seeded", "verified"]), notDown, listedByDefault, notAuditHeld, sql`not ${repoGone}`);
const notExcluded = sql`not exists (select 1 from ${socialTalkDecisions} d where d.repository_key = ${socialPosts.repositoryKey} and d.excluded)`;
/**
 * X 게시물은 마지막으로 확인한 뒤 24시간만 보인다 — X 정책은 API 로 최신 상태를 확인한 콘텐츠만 표시하게 한다.
 * 수집기는 하루 한 번 최근 24시간을 다시 검색하므로, 다시 잡히지 않은 글은 하루 뒤 화면에서 빠진다.
 */
export const X_FRESH_MS = 24 * 3_600_000;
const freshX = (now: Date) => sql`(${socialPosts.source} <> 'x' or ${socialPosts.lastSeenAt} >= ${new Date(now.getTime() - X_FRESH_MS).toISOString()}::timestamptz)`;

export type TalkPost = {
  id: number;
  source: SocialSource;
  externalId: string;
  kind: SocialPostKind;
  title: string;
  linkTarget: SocialLinkTarget;
  postedAt: Date;
  points: number;
  comments: number;
  frontPage: boolean;
};
export type TalkProduct = {
  id: number;
  slug: string;
  name: string;
  /** 번역 해시에 쓰는 원래 이름 — 화면 이름(name)은 저장소 이름으로 바뀌었을 수 있다 */
  translationName: string;
  tagline: string;
  taglineKo: string | null;
  taglineSource: TaglineSource;
  category: string;
  repoUrl: string | null;
  ogImage: string | null;
  stars: number | null;
  aiLevel: number | null;
  accessMode: "website" | "installable";
};
/** 글 뒤 GitHub 스타. mention: 첫 글 직전 관측부터, observation: 첫 글 뒤 첫 관측부터(관측 범위에 늦게 든 제품) */
export type TalkStarGrowth = {
  delta: number; basis: "mention" | "observation"; from: number; fromAt: Date; to: number; toAt: Date;
  /** 기준 관측부터 마지막 관측까지 — 곡선을 그린다 */
  points: { stars: number; at: Date }[];
};
export type TalkEntry = {
  rank: number;
  repositoryKey: string;
  score: number;
  product: TalkProduct;
  /** 출처마다 가장 큰 글이 앞, 그다음 점수순 */
  posts: TalkPost[];
  sources: SocialSource[];
  byMaker: boolean;
  starGrowth: TalkStarGrowth | null;
  homeDecision: TalkHomeDecision | null;
  /** 실제 화제가 모이기 전 빈 자리를 채우는 '예시' 카드(lib/social/talk-samples.ts) — 링크·실제 제품이 없다 */
  sample?: true;
};
export type TalkBoard = {
  mode: TalkMode;
  entries: TalkEntry[];
  /** 자격을 넘었지만 아직 공개 제품이 아닌 저장소 — 심사 중(active)과 아직 모르는 것(unknown) */
  unlisted: { active: number; unknown: number };
  /** 마지막으로 출처를 읽은 시각 */
  checkedAt: Date | null;
};

const postFields = {
  id: socialPosts.id, source: socialPosts.source, externalId: socialPosts.externalId, kind: socialPosts.kind,
  title: socialPosts.title, linkTarget: socialPosts.linkTarget, postedAt: socialPosts.postedAt,
  points: socialPosts.points, comments: socialPosts.comments, frontPage: socialPosts.frontPage,
  repositoryKey: socialPosts.repositoryKey,
};
const productFields = {
  productId: products.id, slug: products.slug, name: products.name, tagline: products.tagline, taglineKo,
  taglineSource: products.taglineSource, category: products.category, repoUrl: products.repoUrl, ogImage: products.ogImage,
  stars: products.stars, aiLevel: products.aiLevel, accessMode: products.accessMode,
};

type Row = TalkPost & { repositoryKey: string | null } & Partial<Record<keyof typeof productFields, unknown>>;

function product(row: Row): TalkProduct {
  const repoUrl = row.repoUrl as string | null;
  return {
    id: row.productId as number, slug: row.slug as string, name: displayProjectName(row.name as string, repoUrl), translationName: row.name as string,
    tagline: row.tagline as string, taglineKo: row.taglineKo as string | null, taglineSource: row.taglineSource as TaglineSource,
    category: row.category as string, repoUrl, ogImage: row.ogImage as string | null, stars: row.stars as number | null,
    aiLevel: row.aiLevel as number | null, accessMode: row.accessMode as "website" | "installable",
  };
}

const post = (row: Row): TalkPost => ({
  id: row.id, source: row.source, externalId: row.externalId, kind: row.kind, title: row.title, linkTarget: row.linkTarget,
  postedAt: row.postedAt, points: row.points, comments: row.comments, frontPage: row.frontPage,
});

/** 출처마다 가장 큰 글을 앞에, 나머지는 점수순 */
function orderPosts(list: TalkPost[]): TalkPost[] {
  const byScore = [...list].sort((a, b) => b.points + b.comments / 2 - (a.points + a.comments / 2) || b.postedAt.getTime() - a.postedAt.getTime());
  const lead = new Map<SocialSource, TalkPost>();
  for (const item of byScore) if (!lead.has(item.source)) lead.set(item.source, item);
  const leaders = new Set(lead.values());
  return [...leaders, ...byScore.filter(item => !leaders.has(item))];
}

/** 첫 글 직전의 마지막 관측(없으면 첫 글 뒤 첫 관측)부터 마지막 관측까지 */
export function starGrowthSince(observations: readonly { stars: number; observedAt: Date }[], firstPostedAt: Date): TalkStarGrowth | null {
  const sorted = [...observations].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const latest = sorted.at(-1);
  if (!latest) return null;
  const before = sorted.filter(item => item.observedAt <= firstPostedAt).at(-1);
  const base = before ?? sorted.find(item => item.observedAt > firstPostedAt);
  if (!base || base === latest) return null;
  return {
    delta: latest.stars - base.stars, basis: before ? "mention" : "observation", from: base.stars, fromAt: base.observedAt, to: latest.stars, toAt: latest.observedAt,
    points: sorted.slice(sorted.indexOf(base)).map(item => ({ stars: item.stars, at: item.observedAt })),
  };
}

async function starGrowths(entries: { productId: number; firstPostedAt: Date }[]): Promise<Map<number, TalkStarGrowth>> {
  if (!entries.length) return new Map();
  const earliest = new Date(Math.min(...entries.map(entry => entry.firstPostedAt.getTime())) - 2 * 86_400_000);
  const rows = await db.select({ productId: productStarObservations.productId, stars: productStarObservations.stars, observedAt: productStarObservations.observedAt })
    .from(productStarObservations)
    .where(and(inArray(productStarObservations.productId, entries.map(entry => entry.productId)), eq(productStarObservations.status, "ok"),
      gte(productStarObservations.observedAt, earliest)))
    .orderBy(asc(productStarObservations.observedAt));
  const byProduct = new Map<number, { stars: number; observedAt: Date }[]>();
  for (const row of rows) {
    if (row.stars === null || !row.observedAt) continue;
    byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), { stars: row.stars, observedAt: row.observedAt }]);
  }
  const result = new Map<number, TalkStarGrowth>();
  for (const entry of entries) {
    const growth = starGrowthSince(byProduct.get(entry.productId) ?? [], entry.firstPostedAt);
    if (growth) result.set(entry.productId, growth);
  }
  return result;
}

async function unlistedCounts(postedSince: Date, now: Date, listed: Set<string>) {
  const rows = await db.select(postFields).from(socialPosts)
    .where(and(eq(socialPosts.state, "visible"), inArray(socialPosts.linkTarget, RANKED_TARGETS), gte(socialPosts.postedAt, postedSince), notExcluded, freshX(now)));
  const keys = new Set<string>();
  for (const row of rows) if (row.repositoryKey && !listed.has(row.repositoryKey) && talkQualifies(row) && row.postedAt <= now) keys.add(row.repositoryKey);
  if (!keys.size) return { active: 0, unknown: 0 };
  // 이미 제품이 있는데 공개가 아닌 것(차단·응답 없음·내려감)은 결정이 끝났다 — 곧 오를 것으로 세지 않는다
  const list = sql.join([...keys].map(key => sql`${key}`), sql`, `);
  const decided = await db.execute<{ key: string }>(sql`
    SELECT DISTINCT substring(${PRODUCT_IDENTITY} from '^https://github[.]com/(.+)$') AS key FROM ${products}
    WHERE ${PRODUCT_IDENTITY} IN (${sql.join([...keys].map(key => sql`${"https://github.com/" + key}`), sql`, `)})`);
  for (const row of decided) keys.delete(row.key);
  if (!keys.size) return { active: 0, unknown: 0 };
  const active = await db.execute<{ key: string }>(sql`
    SELECT DISTINCT lower(repo) AS key FROM crawl_candidates
    WHERE state IN ('new', 'needs_review', 'approved') AND lower(repo) IN (${list})`);
  const activeKeys = active.filter(row => keys.has(row.key)).length;
  return { active: activeKeys, unknown: keys.size - activeKeys };
}

/** 화제 목록. now: 36시간 반감, week: 최근 7일을 그대로 합친다 */
export async function listTalk(options: { mode: TalkMode; now?: Date; limit?: number }): Promise<TalkBoard> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - TALK_VISIBLE_MS);
  const rows: Row[] = await db.select({ ...postFields, ...productFields }).from(socialPosts)
    .innerJoin(products, sql`${PRODUCT_IDENTITY} = 'https://github.com/' || ${socialPosts.repositoryKey}`)
    .where(and(eq(socialPosts.state, "visible"), inArray(socialPosts.linkTarget, RANKED_TARGETS),
      gte(socialPosts.postedAt, since), sql`${socialPosts.postedAt} <= ${now.toISOString()}::timestamptz`, notExcluded, freshX(now), publicProduct()));

  // 같은 저장소를 가리키는 제품이 둘이면 먼저 등록된 것(id 가 작은 것) 하나에 모은다
  const groups = new Map<string, { product: TalkProduct; posts: TalkPost[] }>();
  for (const row of rows) {
    const key = row.repositoryKey!;
    const group = groups.get(key);
    if (!group || (row.productId as number) < group.product.id) groups.set(key, { product: product(row), posts: group?.posts ?? [] });
    groups.get(key)!.posts.push(post(row));
  }
  for (const group of groups.values()) group.posts = [...new Map(group.posts.map(item => [item.id, item])).values()];

  const scored = [...groups.entries()].flatMap(([repositoryKey, group]) => {
    const score = repositoryTalkScore(group.posts, now, options.mode);
    return score === null ? [] : [{ repositoryKey, score, ...group }];
  }).sort((a, b) => b.score - a.score || a.product.id - b.product.id);
  const limited = scored.slice(0, options.limit ?? 50);

  const decisions = limited.length
    ? await db.select().from(socialTalkDecisions).where(inArray(socialTalkDecisions.repositoryKey, limited.map(entry => entry.repositoryKey)))
    : [];
  const decided = new Map(decisions.map(row => [row.repositoryKey, row.homeDecision]));
  const growth = await starGrowths(limited.map(entry => ({
    productId: entry.product.id, firstPostedAt: new Date(Math.min(...entry.posts.map(item => item.postedAt.getTime()))),
  })));

  return {
    mode: options.mode,
    entries: limited.map((entry, index) => ({
      rank: index + 1, repositoryKey: entry.repositoryKey, score: entry.score, product: entry.product,
      posts: orderPosts(entry.posts.filter(item => item.postedAt >= since)),
      sources: [...new Set(entry.posts.filter(talkQualifies).map(item => item.source))],
      byMaker: entry.posts.some(item => item.kind === "show"),
      starGrowth: growth.get(entry.product.id) ?? null,
      homeDecision: decided.get(entry.repositoryKey) ?? null,
    })),
    unlisted: await unlistedCounts(since, now, new Set(groups.keys())),
    checkedAt: await lastCheckedAt(),
  };
}

/** 화제의 공개 제품 조건(publicProduct) 그대로 — X 검색어의 저장소 고르기(x-query-receive.ts)가 쓴다 */
export const talkPublicProduct = () => publicProduct();

/** 이 저장소 열쇠(소문자 owner/repo) 중 공개 제품의 저장소인 것 — 여러 저장소를 가리킨 X 글을 어느 제품에 붙일지(x-posts-receive.ts) */
export async function publicRepositoryKeys(tx: ProductTransaction, keys: readonly string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await tx.select({ key: sql<string>`substring(${PRODUCT_IDENTITY} from '^https://github[.]com/(.+)$')` }).from(products)
    .where(and(sql`${PRODUCT_IDENTITY} in (${sql.join(keys.map(key => sql`${"https://github.com/" + key}`), sql`, `)})`, publicProduct()));
  return new Set(rows.map(row => row.key));
}

async function lastCheckedAt(): Promise<Date | null> {
  const [checked] = await db.select({ at: sql<string | null>`max(${socialPosts.lastSeenAt})::text` }).from(socialPosts);
  return checked?.at ? new Date(checked.at) : null;
}

/**
 * 홈 첫 화면 대표 구획(C안) — 1위 자리는 관리자가 허용한(approved) 저장소만. 허용 전이면 다음 순위가 올라선다.
 * talk_only 는 /talk 에만 두고 홈에서는 뺀다. 나머지 자리(2~5위)는 허용을 기다리지 않는다.
 */
export function homeTalkLineup(entries: readonly TalkEntry[], size = 5): { lead: TalkEntry | null; rest: TalkEntry[]; waiting: TalkEntry[] } {
  const eligible = entries.filter(entry => entry.homeDecision !== "talk_only");
  const lead = eligible.find(entry => entry.homeDecision === "approved") ?? null;
  const waiting = eligible.filter(entry => entry.homeDecision === null && (!lead || entry.rank < lead.rank));
  return { lead, rest: eligible.filter(entry => entry !== lead).slice(0, Math.max(0, size - 1)), waiting };
}

export type ProductTalk = {
  posts: TalkPost[];
  /** 순위에 셀 자격 글이 있다 — C안 상세 띠는 이때만 크게 */
  qualifies: boolean;
  /** 지금 순위(7일 안의 자격 글이 있을 때만) */
  rank: number | null;
  sources: SocialSource[];
  starGrowth: TalkStarGrowth | null;
  checkedAt: Date | null;
};

/** 상세 화제 기록 — 90일 안의 보이는 글. 글이 없으면 null(구획을 그리지 않는다) */
export async function productTalk(productId: number, repoUrl: string | null, now = new Date()): Promise<ProductTalk | null> {
  const key = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/i.exec(repoUrl ?? "")?.[1]?.toLowerCase();
  if (!key) return null;
  const since = new Date(now.getTime() - TALK_DETAIL_MS);
  const rows = await db.select(postFields).from(socialPosts)
    .where(and(eq(socialPosts.repositoryKey, key), eq(socialPosts.state, "visible"), gte(socialPosts.postedAt, since), notExcluded, freshX(now)));
  if (!rows.length) return null;
  const posts = orderPosts(rows.map(row => post(row as Row)));
  const ranked = posts.filter(item => RANKED_TARGETS.includes(item.linkTarget));
  const qualifies = ranked.some(talkQualifies);
  const board = qualifies && ranked.some(item => item.postedAt.getTime() >= now.getTime() - TALK_VISIBLE_MS)
    ? await listTalk({ mode: "now", now }) : null;
  const firstPostedAt = new Date(Math.min(...posts.map(item => item.postedAt.getTime())));
  const growth = await starGrowths([{ productId, firstPostedAt }]);
  return {
    posts, qualifies,
    rank: board?.entries.find(entry => entry.product.id === productId)?.rank ?? null,
    sources: [...new Set(posts.map(item => item.source))],
    starGrowth: growth.get(productId) ?? null,
    checkedAt: board?.checkedAt ?? await lastCheckedAt(),
  };
}
