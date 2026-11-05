import { createHash } from "node:crypto";
import type { RequestKind } from "./admin-request-workspace";

export const REQUEST_FEED_LIMIT = 30;
export type RequestFeedFilter = { tab: "open" | "correction" | "contact" | "posts"; kinds: RequestKind[]; kind: RequestKind | ""; state: string; q: string };
export type RequestFeedRow = { key: string; kind: RequestKind; name: string; type: string; status: string; at: string; waitHours: number; next: string; slug: string | null; excerpt: string | null };
export type RequestFeedPage = { items: RequestFeedRow[]; nextCursor: string | null; count: number | null; failed: RequestKind[]; takedown: { pending: number; overdue: number } | null };
const kinds = ["takedown", "intro", "contact", "feedback", "replies", "reactions"] as const;
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : "";
export function requestFeedFilter(params: Record<string, string | string[] | undefined>): RequestFeedFilter {
  const tab = ["correction", "contact", "posts"].includes(one(params.tab)) ? one(params.tab) as RequestFeedFilter["tab"] : "open";
  const allowed: RequestKind[] = tab === "correction" ? ["takedown", "intro"] : tab === "contact" ? ["contact"] : tab === "posts" ? ["feedback", "replies", "reactions"] : [...kinds];
  const kind = allowed.includes(one(params.kind) as RequestKind) ? one(params.kind) as RequestKind : "";
  const requestedState = one(params.state);
  const state = tab === "posts" ? kind === "reactions" ? "held" : ["held", "accepted", "rejected", "all"].includes(requestedState) ? requestedState : "held"
    : ["open", "all", "new", "in_progress", "waiting", "resolved", "spam"].includes(requestedState) ? requestedState : "open";
  return { tab, kind, kinds: (kind ? [kind] : allowed).filter(value => !(tab === "posts" && !kind && ["accepted", "rejected"].includes(state) && value === "reactions")), state, q: one(params.q).trim().slice(0, 120) };
}
export function requestFeedFingerprint(filter: RequestFeedFilter): string {
  return createHash("sha256").update(JSON.stringify([filter.tab, [...filter.kinds].sort(), filter.state, filter.q])).digest("hex").slice(0, 24);
}
export function requestFeedCursor(at: string, key: string, filter: RequestFeedFilter): string {
  return Buffer.from(JSON.stringify([at, key, requestFeedFingerprint(filter)])).toString("base64url");
}
export function parseRequestFeedCursor(value: string | undefined, filter: RequestFeedFilter): { at: string; key: string } | null {
  if (!value) return null;
  try {
    if (value.length > 600 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const [at, key, fingerprint] = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(at)
      || !Number.isFinite(Date.parse(at)) || new Date(at).getUTCFullYear() < 1 || new Date(at).toISOString().slice(0, 19) !== at.slice(0, 19)
      || typeof key !== "string" || key.length > 180 || /[\x00-\x1f]/.test(key)
      || !filter.kinds.some(kind => key.startsWith(`${kind}:`)) || fingerprint !== requestFeedFingerprint(filter)) throw new Error();
    return { at, key };
  } catch { throw new Error("request_feed_cursor_invalid"); }
}
/** Stable DB-microsecond ordering across source types; do not round through JavaScript Date. */
export function requestFeedWindow(rows: Array<RequestFeedRow & { cursorAt: string }>, filter: RequestFeedFilter) {
  const sorted = [...rows].sort((a, b) => a.cursorAt === b.cursorAt ? a.key < b.key ? 1 : a.key > b.key ? -1 : 0 : a.cursorAt < b.cursorAt ? 1 : -1);
  const selected = sorted.slice(0, REQUEST_FEED_LIMIT), last = selected.at(-1);
  return { items: selected.map(row => ({ key: row.key, kind: row.kind, name: row.name, type: row.type, status: row.status, at: row.at, waitHours: row.waitHours, next: row.next, slug: row.slug, excerpt: row.kind === "contact" ? null : row.excerpt })), nextCursor: sorted.length > REQUEST_FEED_LIMIT && last ? requestFeedCursor(last.cursorAt, last.key, filter) : null };
}
