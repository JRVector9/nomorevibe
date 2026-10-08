import { formatDetailTime } from "@/lib/format/time";

/**
 * 내려달라는 요청 — 화면이 쓰는 규칙(서버·화면 공용, DB 를 부르지 않는다).
 *
 * 색은 건수가 아니라 기다린 시간으로 정한다. 상세 페이지가 "원치 않으시면 내려드립니다"라고 약속했으니
 * 오래 둔 것이 문제다 — 24시간을 넘기면 빨강, 그 절반을 넘기면 주황.
 */
export const TAKEDOWN_OVERDUE_HOURS = 24;
export const TAKEDOWN_LATE_HOURS = 12;
/** 1시간에 이만큼 넘게 들어오면 "몰려 들어옴" — 평소는 하루 0~1건이다 */
export const TAKEDOWN_BURST_PER_HOUR = 10;

export const DISMISS_REASONS = {
  test_spam: "테스트·장난",
  not_owner: "주인이 아닌 것 같음",
  already_removed: "이미 내려가 있음",
  other: "기타",
} as const;
export type DismissReason = keyof typeof DISMISS_REASONS;
export const isDismissReason = (value: unknown): value is DismissReason =>
  typeof value === "string" && Object.hasOwn(DISMISS_REASONS, value);

/** 처리 화면 한 줄 — 서버가 만들어 화면으로 넘긴다(시각은 ISO 문자열) */
export type TakedownEntry = {
  slug: string;
  reason: string | null;
  requestedAt: string;
  ageHours: number;
  requesterHash: string | null;
  requestCount: number;
  previousOutcome: string | null;
  product: { name: string; url: string; repoUrl: string | null; category: string; listedAt: string; status: string; stars: number | null } | null;
  /** 저장소 계정(소문자) — GitHub 저장소가 있을 때만 */
  owner: string | null;
  /** 그 계정의 공개 제품 수 */
  ownerPublic: number;
  /** 그 계정 제품에 걸린 대기 요청 수 */
  ownerPending: number;
  /** 같은 보낸이의 대기 요청 수 */
  senderPending: number;
  visits7d: number;
};

export type TakedownSummary = {
  pending: number;
  overdue: number;
  oldestHours: number | null;
  handled24h: { removed: number; dismissed: number };
  last30d: { removed: number; dismissed: number };
  lastHour: { requests: number; owners: number; senders: number; noReason: number; topReason: { text: string; count: number } | null };
};

export function waitTone(hours: number): "bad" | "warn" | "soft" {
  return hours >= TAKEDOWN_OVERDUE_HOURS ? "bad" : hours >= TAKEDOWN_LATE_HOURS ? "warn" : "soft";
}

export function formatWait(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}분`;
  if (hours < 24) return `${Math.floor(hours)}시간`;
  const days = Math.floor(hours / 24);
  const rest = Math.floor(hours - days * 24);
  return rest ? `${days}일 ${rest}시간` : `${days}일`;
}

/** 보낸이 표기 — 해시 앞 네 자리. 해시만으로는 누구인지 알 수 없고, 같은 보낸이끼리 묶이는 것만 보인다 */
export function senderLabel(hash: string | null): string {
  return hash ? `보낸이 ${hash.slice(0, 4)}` : "보낸이 미상";
}

/** 메뉴 배지·심사 큐 띠·운영센터 조치가 함께 쓰는 한 줄 상태 */
export function takedownSignal(summary: Pick<TakedownSummary, "pending" | "overdue">): { label: string; tone: "warn" | "bad" } | null {
  if (summary.pending === 0) return null;
  return { label: `요청 ${summary.pending}`, tone: summary.overdue > 0 ? "bad" : "warn" };
}

export const isBurst = (summary: Pick<TakedownSummary, "lastHour">) => summary.lastHour.requests >= TAKEDOWN_BURST_PER_HOUR;

export type GroupMode = "none" | "owner" | "sender" | "time";
export type TakedownGroup = { key: string; title: string; detail: string; entries: TakedownEntry[]; together: boolean };

/** 들어온 시각대 "10-05 14시" — 한국 시각("2026-10-05 14:40:00 KST")에서 월·일·시만 */
const hourLabel = (iso: string) => {
  const at = formatDetailTime(iso);
  return `${at.slice(5, 10)} ${at.slice(11, 13)}시`;
};
const distinct = (values: (string | null)[]) => new Set(values.filter(Boolean)).size;

/**
 * 묶기 — 같은 계정·같은 보낸이·같은 시각대끼리 모아 묶음 머리에서 한 번에 처리하게.
 *
 * 둘 이상 모인 것만 묶음이 되고(together), 나머지는 맨 뒤 "한 건씩"에 모은다. 묶지 않으면 한 묶음이다.
 * 들어온 순서는 묶음 안에서 그대로다(받은 entries 의 순서).
 */
export function groupTakedowns(entries: TakedownEntry[], mode: GroupMode): TakedownGroup[] {
  if (mode === "none" || entries.length === 0) return [{ key: "all", title: "", detail: "", entries, together: false }];
  const keyOf = (entry: TakedownEntry): string | null =>
    mode === "owner" ? entry.owner : mode === "sender" ? entry.requesterHash : hourLabel(entry.requestedAt);
  const buckets = new Map<string, TakedownEntry[]>();
  const singles: TakedownEntry[] = [];
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!key) { singles.push(entry); continue; }
    buckets.set(key, [...(buckets.get(key) ?? []), entry]);
  }
  const groups: TakedownGroup[] = [];
  const ordered = [...buckets].sort((a, b) => mode === "time" ? b[0].localeCompare(a[0]) : b[1].length - a[1].length);
  for (const [key, list] of ordered) {
    if (list.length < 2) { singles.push(...list); continue; }
    const owners = distinct(list.map((entry) => entry.owner));
    groups.push({
      key, together: true, entries: list,
      title: mode === "owner" ? key : mode === "sender" ? senderLabel(key) : key,
      detail: mode === "owner"
        ? `요청 ${list.length}건 · 이 계정의 공개 제품 ${list[0].ownerPublic.toLocaleString("ko-KR")}개`
        : `요청 ${list.length}건 · 서로 다른 계정 ${owners}곳`,
    });
  }
  if (singles.length) {
    groups.push({
      key: "singles", title: "한 건씩", entries: singles, together: false,
      detail: mode === "owner" ? "계정마다 요청 1건" : mode === "sender" ? "보낸이마다 요청 1건(또는 보낸이 미상)" : "시각대마다 요청 1건",
    });
  }
  return groups;
}
