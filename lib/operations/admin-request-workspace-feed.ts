import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { readRequestSection, readRequestWorkspaceQueues, type RequestKind, type WorkspaceRequest } from "./admin-request-workspace";
import { parseRequestFeedCursor, requestFeedWindow, REQUEST_FEED_LIMIT, type RequestFeedFilter, type RequestFeedPage, type RequestFeedRow } from "./admin-request-workspace-feed-model";

type Source = { from: SQL; at: SQL; key: SQL; name: SQL; slug: SQL; excerpt: SQL; status: SQL; where: SQL; search: SQL[]; type: string; next: string };
function source(kind: RequestKind, state: string): Source {
  const held = ["held", "accepted", "rejected", "all"].includes(state) ? state : "held";
  const review = (column: SQL) => held === "all" ? sql`true` : sql`${column} = ${held}`;
  if (kind === "takedown") return { from: sql`takedown_requests r left join products p on p.slug = r.slug`, at: sql`r.requested_at at time zone 'UTC'`, key: sql`'takedown:' || r.slug`, name: sql`coalesce(p.name, r.slug)`, slug: sql`r.slug`, excerpt: sql`null::text`, status: sql`'접수'::text`, where: sql`r.handled_at is null`, search: [sql`p.name`, sql`r.slug`, sql`r.reason`], type: "내림 요청", next: "공개 중단·유지 검토" };
  if (kind === "intro") return { from: sql`intro_correction_requests r left join products p on p.id = r.product_id`, at: sql`r.created_at at time zone 'UTC'`, key: sql`'intro:' || r.id::text`, name: sql`coalesce(p.name, r.slug)`, slug: sql`r.slug`, excerpt: sql`null::text`, status: sql`'접수'::text`, where: sql`r.handled_at is null`, search: [sql`p.name`, sql`r.slug`, sql`r.message`], type: "소개 수정", next: "현재 소개와 대조" };
  if (kind === "contact") return { from: sql`admin_contact_requests r`, at: sql`r.received_at`, key: sql`'contact:' || r.id::text`, name: sql`r.subject`, slug: sql`null::text`, excerpt: sql`null::text`, status: sql`case r.status when 'new' then '접수' when 'in_progress' then '처리 중' when 'waiting' then '상대방 대기' when 'resolved' then '해결' else '스팸' end`, where: state === "all" ? sql`true` : ["new", "in_progress", "waiting", "resolved", "spam"].includes(state) ? sql`r.status = ${state}` : sql`r.status in ('new', 'in_progress', 'waiting')`, search: [sql`r.subject`, sql`r.body`], type: "문의", next: "메일함 회신·처리 기록" };
  if (kind === "feedback") return { from: sql`product_feedback r join products p on p.id = r.product_id join public_users u on u.id = r.author_user_id`, at: sql`r.created_at`, key: sql`'feedback:' || r.id::text`, name: sql`p.name`, slug: sql`p.slug`, excerpt: sql`left(r.body, 100)`, status: sql`case r.review_state when 'held' then '보류' when 'accepted' then '공개' else '숨김' end`, where: review(sql`r.review_state`), search: [sql`p.name`, sql`p.slug`, sql`r.title`, sql`r.body`], type: "피드백", next: "공개·숨김·복원" };
  if (kind === "replies") return { from: sql`maker_replies r join products p on p.id = r.product_id join public_users u on u.id = r.author_user_id`, at: sql`r.created_at`, key: sql`'replies:' || r.id::text`, name: sql`p.name`, slug: sql`p.slug`, excerpt: sql`left(r.body, 100)`, status: sql`case r.review_state when 'held' then '보류' when 'accepted' then '공개' else '숨김' end`, where: review(sql`r.review_state`), search: [sql`p.name`, sql`p.slug`, sql`r.body`], type: "메이커 답장", next: "원문 대조·공개 검토" };
  return { from: sql`product_reactions r join products p on p.id = r.product_id`, at: sql`r.created_at`, key: sql`'reactions:' || r.id::text`, name: sql`p.name`, slug: sql`p.slug`, excerpt: sql`left(coalesce(r.comment, ''), 100)`, status: sql`'보류'::text`, where: sql`r.comment_state = 'held'`, search: [sql`p.name`, sql`p.slug`, sql`r.comment`], type: "써봤어요", next: "한 줄 공개 검토" };
}
/** Each source returns at most 31 thin rows. Search and cursor apply before LIMIT, never to an already sliced list. */
export async function readRequestWorkspaceFeed(filter: RequestFeedFilter, cursorValue?: string): Promise<RequestFeedPage> {
  const cursor = parseRequestFeedCursor(cursorValue, filter), pattern = filter.q ? `%${filter.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const results = await Promise.all(filter.kinds.map(async kind => ({ kind, result: await readRequestSection(`feed-${kind}`, () => onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '4s'`);
    const s = source(kind, filter.state);
    const search = pattern ? sql`and (${sql.join([...s.search, s.key, sql`${s.type}::text`].map(column => sql`${column} ilike ${pattern}`), sql` or `)})` : sql``;
    const before = cursor ? sql`and (${s.at} < ${cursor.at}::timestamptz or (${s.at} = ${cursor.at}::timestamptz and (${s.key}) collate "C" < ${cursor.key} collate "C"))` : sql``;
    const [rows, totals] = await Promise.all([
      tx.execute<RequestFeedRow & { cursorAt: string }>(sql`select ${s.key} as key, ${kind}::text as kind, ${s.name} as name, ${s.type}::text as type,
        ${s.status} as status, to_char(${s.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
        to_char(${s.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
        greatest(0, extract(epoch from (clock_timestamp() - (${s.at}))) / 3600)::float8 as "waitHours",
        ${s.next}::text as next, ${s.slug} as slug, ${s.excerpt} as excerpt
        from ${s.from} where ${s.where} ${search} ${before} order by ${s.at} desc, (${s.key}) collate "C" desc limit ${REQUEST_FEED_LIMIT + 1}`),
      tx.execute<{ count: number }>(sql`select count(*)::int as count from ${s.from} where ${s.where} ${search}`),
    ]);
    return { items: Array.from(rows), count: totals[0]?.count ?? 0 };
  }, { isolationLevel: "repeatable read", accessMode: "read only" }))) })));
  const failed = results.filter(row => !row.result.ok).map(row => row.kind);
  const window = requestFeedWindow(results.flatMap(row => row.result.ok ? row.result.data.items : []), filter);
  const summary = !cursor && filter.kinds.includes("takedown") ? await readRequestSection("feed-takedown-summary", takedownSummary) : null;
  return { ...window, nextCursor: failed.length ? null : window.nextCursor,
    count: failed.length === results.length ? null : results.reduce((total, row) => total + (row.result.ok ? row.result.data.count : 0), 0), failed,
    takedown: summary?.ok ? { pending: summary.data.pending, overdue: summary.data.overdue } : null };
}
/** The action record is server-only and resolved by ID even when it is outside the first 30 rows. */
export async function readSelectedWorkspaceRequest(key: string | undefined, filter: RequestFeedFilter): Promise<WorkspaceRequest | null> {
  if (!key) return null;
  const colon = key.indexOf(":"), kind = key.slice(0, colon) as RequestKind, id = key.slice(colon + 1);
  if (colon < 1 || !filter.kinds.includes(kind) || !id || id.length > 80 || /[\x00-\x1f]/.test(id)) return null;
  if (kind === "intro" && !/^[1-9]\d{0,9}$/.test(id)) return null;
  if (["contact", "feedback", "replies", "reactions"].includes(kind) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const result = await readRequestWorkspaceQueues([kind], filter.state, 0, undefined, key);
  if (result.failed.length) throw new Error("request_detail_unavailable");
  return result.items.find(row => row.key === key) ?? null;
}
