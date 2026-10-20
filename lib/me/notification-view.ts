import { CATEGORIES, type Category } from "@/lib/domain/products/categories";
import type { Locale } from "@/lib/i18n/locales";
import type { MessageKey, Translator } from "@/lib/i18n/messages";
import { localePath } from "@/lib/i18n/routing";
import { formatDay } from "@/lib/format/time";
import { ME_TAB_PATHS, type NotificationKind } from "./contract";
import { categoryKey, categoryOfKey } from "./follow-keys";

/** 알림 한 줄 — 서버가 그 언어로 지어 보낸다. 굵게 둘 이름만 strong 조각으로 나눈다 */
export type NotificationPart = { text: string; strong?: boolean };
export type NotificationView = {
  id: number; kind: NotificationKind; label: string; parts: NotificationPart[]; quote: string | null; href: string;
  tile: { name: string; ogImage: string | null; category: string | null } | null; createdAt: string; read: boolean;
};

export type NotificationSource = {
  id: number; kind: NotificationKind; payload: Record<string, unknown>; createdAt: Date; readAt: Date | null;
  product: { slug: string; name: string; ogImage: string | null; category: string } | null;
};

const text = (value: unknown, max = 80): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
const uuid = (value: unknown): string | null => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;

/** 굵게 둘 값은 표시 글자로 바꿔 넣고 번역문을 그 자리에서 자른다 — 언어마다 어순이 달라도 이름이 제자리에 굵게 남는다 */
function rich(message: string, bold: string[]): NotificationPart[] {
  return message.split(/(\u0001\d+\u0002)/).filter(Boolean).map((piece) => {
    const match = /^\u0001(\d+)\u0002$/.exec(piece);
    return match ? { text: bold[Number(match[1])], strong: true } : { text: piece };
  });
}

type Line = { key: MessageKey<"me">; plain?: Record<string, string | number>; bold: Record<string, string> };

function line(t: Translator<"me">, { key, plain = {}, bold }: Line): NotificationPart[] {
  const names = Object.keys(bold);
  const marked = Object.fromEntries(names.map((name, index) => [name, `\u0001${index}\u0002`]));
  const translate = t as unknown as (key: string, params: Record<string, string | number>) => string;
  return rich(translate(key, { ...plain, ...marked }), names.map((name) => bold[name]));
}

/** 종류마다 한 줄과 누르면 갈 곳. payload 가 비거나 깨져도 그릴 수 있게 기본값을 둔다 */
export function renderNotification(row: NotificationSource, t: Translator<"me">, labels: (category: Category) => string, locale: Locale): NotificationView {
  const payload = row.payload ?? {};
  const name = row.product?.name ?? text(payload.name) ?? t("alerts.removedProduct");
  const productPath = row.product ? `/p/${row.product.slug}` : ME_TAB_PATHS.alerts;
  let parts: NotificationPart[];
  let path = productPath;
  let quote: string | null = null;
  let tile: NotificationView["tile"] = row.product ? { name: row.product.name, ogImage: row.product.ogImage, category: row.product.category } : null;
  switch (row.kind) {
    case "maker_reply": {
      const maker = text(payload.maker, 40);
      parts = maker ? line(t, { key: "alerts.line.makerReply", bold: { maker, name } }) : line(t, { key: "alerts.line.makerReplyAnonymous", bold: { name } });
      quote = text(payload.excerpt, 120);
      const feedbackId = uuid(payload.feedbackId);
      if (feedbackId) path = `/feedback/${feedbackId}`;
      break;
    }
    case "followed_release":
      parts = line(t, { key: "alerts.line.release", plain: { title: text(payload.title) ?? "" }, bold: { name } });
      break;
    case "followed_delisted":
      parts = line(t, { key: payload.reason === "down" ? "alerts.line.delistedDown" : "alerts.line.delistedRemoved", bold: { name } });
      break;
    case "maker_new_project":
      parts = line(t, { key: "alerts.line.makerProject", bold: { maker: `@${text(payload.maker, 40) ?? "?"}`, name } });
      break;
    case "category_new": {
      const listed = (Array.isArray(payload.categories) ? payload.categories : []).flatMap((item) => {
        const category = item && typeof item === "object" ? categoryOfKey(String((item as Record<string, unknown>).category)) : null;
        return category ? [category] : [];
      });
      const first = listed[0] ?? CATEGORIES[CATEGORIES.length - 1];
      const total = count(payload.total);
      const others = count(payload.others) || Math.max(listed.length - 1, 0);
      parts = others > 0
        ? line(t, { key: "alerts.line.categoryMany", plain: { count: total, others }, bold: { category: labels(first) } })
        : line(t, { key: "alerts.line.categoryOne", plain: { count: total }, bold: { category: labels(first) } });
      path = others > 0 || !listed.length ? ME_TAB_PATHS.following : `/c/${categoryKey(first)}?sort=recent`;
      tile = { name: labels(first), ogImage: null, category: first };
      break;
    }
    case "comment_reviewed": {
      const accepted = payload.decision === "accepted";
      parts = line(t, { key: accepted ? "alerts.line.reviewAccepted" : "alerts.line.reviewRejected", bold: { name } });
      const feedbackId = uuid(payload.feedbackId);
      path = accepted && feedbackId ? `/feedback/${feedbackId}` : ME_TAB_PATHS.opinions;
      break;
    }
    case "new_listing_mine":
      parts = line(t, { key: "alerts.line.listingMine", bold: { repo: text(payload.repo, 140) ?? name } });
      path = ME_TAB_PATHS.projects;
      break;
    case "inbox_new":
      parts = line(t, { key: "alerts.line.inbox", plain: { count: count(payload.count) || 1 }, bold: { name } });
      path = ME_TAB_PATHS.projects;
      break;
    default:
      parts = line(t, { key: "alerts.line.fallback", bold: { name } });
  }
  return {
    id: row.id, kind: row.kind, label: t(`alerts.kind.${row.kind}`), parts, quote, href: localePath(locale, path),
    tile, createdAt: row.createdAt.toISOString(), read: row.readAt !== null,
  };
}

export type NotificationGroup = "today" | "week" | "earlier";

/**
 * 오늘 · 이번 주 · 이전 — 한국 날짜로 가른다. '이번 주'는 오늘을 뺀 지난 6일이다(월요일에도 지난 주말 알림이 '이전'으로 밀리지 않게).
 * 순서는 받은 그대로(최근 것부터) 둔다.
 */
export function groupByDay<T extends { createdAt: string }>(items: T[], now: Date | string): Array<{ group: NotificationGroup; items: T[] }> {
  const today = formatDay(now);
  const weekStart = formatDay(new Date(new Date(now).getTime() - 6 * 86_400_000));
  const groups: Array<{ group: NotificationGroup; items: T[] }> = [];
  for (const item of items) {
    const day = formatDay(item.createdAt);
    const group: NotificationGroup = day >= today ? "today" : day >= weekStart ? "week" : "earlier";
    const last = groups[groups.length - 1];
    if (last?.group === group) last.items.push(item);
    else groups.push({ group, items: [item] });
  }
  return groups;
}
