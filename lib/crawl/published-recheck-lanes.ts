/**
 * 공개분 변경 재판정의 두 묻기 줄(2026-11-09) — 「발행분 감사 · 변경 재판정」 순위의 CLI 순위(OpenCode·Claude)는 감사 잡(product-audit)이, API 순위는
 * Qwen 직접 감사 잡(audit-qwen)이 묻는다. 장부 binding 이 잡 이름을 정해서다: 감사 경로 CLI(product_audit_cli)는 job product-audit 이고,
 * 감사 직접 경로(local_model_direct · direct:audit:<항목>:audit)는 job audit-qwen 이다(새 binding·CHECK 가지 없이 두 길을 그대로 쓴다).
 *
 * 순위 차례는 두 잡이 이 프로세스의 같은 기록으로 맞춘다 — 둘 다 reviewer 역할이라 역할 lease 로 한 프로세스에서만 돈다(qwen-endpoint-backoff.ts 와 같은 전제).
 *  - 항목마다 「지금 차례인 순위」 = 쉬지 않는 가장 앞 순위다. 그 순위가 자기 줄이면 묻고, 다른 줄이면 그 줄에 맡긴다(이 줄은 건너뛴다).
 *  - 자기 줄의 순위가 이 틱에 열리지 않으면(장부 미룸·심사자 쪽 탈) 다음 순위로 가고, 그 순위를 RECHECK_RANK_PAUSE_MS 동안 쉼으로 적어 다른 줄도 그동안
 *    그 다음 순위로 넘어가게 한다. 자기 줄은 그 기록을 보지 않는다 — 자기 순위는 틱마다 다시 물어본다(예전 CLI 동작 그대로). 답을 받으면 쉼을 지운다.
 *  - 감사 직접 경로의 도메인 증명이 한 항목을 거절하면(원본 짝이 맞지 않음 등) 그 항목에서만 그 순위를 RECHECK_ITEM_SKIP_MS 동안 건너뛴다 — 다른 줄이 그 항목을
 *    다음 순위로 묻는다(줄 맨 앞의 한 항목이 재판정 줄을 막지 않게).
 *  - 같은 항목을 두 줄이 동시에 묻지 않게 묻는 동안 항목을 잡아 둔다.
 * 프로세스가 다시 뜨면 기록이 비어 처음부터 1순위다(쉼은 짧은 신호일 뿐이다). 이 모듈은 DB 를 읽지 않는다.
 */

export type RecheckLane = "cli" | "api";
type RankLike = Readonly<{ rank: number; provider: string; connectionId: string; model: string }>;

/** 한 순위의 쉼 — 다른 줄의 틱(60초)이 두 번은 보게 */
export const RECHECK_RANK_PAUSE_MS = 150_000;
/**
 * 한 항목에서 한 순위를 건너뛰는 시간 — 감사 직접 경로의 도메인 증명이 그 항목을 거절했다(원본 짝이 맞지 않음 등). 그동안 두 줄 모두 그 항목에는 다음 순위를 쓴다
 * (줄 맨 앞의 한 항목이 매 틱 같은 순위에서 거절되며 재판정 줄을 막지 않게, 장부에 거절 행이 매분 쌓이지 않게)
 */
export const RECHECK_ITEM_SKIP_MS = 30 * 60_000;

const pausedUntil = new Map<string, { until: number; reason: string }>();
const itemSkips = new Map<string, number>();
const claimed = new Set<number>();

/** 그 순위를 묻는 줄 — API 연결(local-direct)은 audit-qwen, 나머지(CLI)는 product-audit */
export const recheckLaneOf = (reviewer: Pick<RankLike, "provider">): RecheckLane => reviewer.provider === "local-direct" ? "api" : "cli";
const keyOf = (reviewer: RankLike) => `${reviewer.rank}:${reviewer.provider}:${reviewer.connectionId}:${reviewer.model}`;

/** 그 순위를 쉼으로 적는다(다른 줄이 그동안 다음 순위로 넘어간다) */
export function noteRecheckRankPaused(reviewer: RankLike, reason: string, now = Date.now()): void {
  pausedUntil.set(keyOf(reviewer), { until: now + RECHECK_RANK_PAUSE_MS, reason: reason.slice(0, 80) });
}

/** 그 순위가 답했다 — 쉼을 지운다 */
export function clearRecheckRankPause(reviewer: RankLike): void {
  pausedUntil.delete(keyOf(reviewer));
}

/** 다른 줄이 그 순위를 쉼으로 적었는가 */
export function recheckRankPaused(reviewer: RankLike, now = Date.now()): boolean {
  const entry = pausedUntil.get(keyOf(reviewer));
  if (!entry) return false;
  if (entry.until > now) return true;
  pausedUntil.delete(keyOf(reviewer));
  return false;
}

/** 그 항목에서 그 순위를 RECHECK_ITEM_SKIP_MS 동안 건너뛴다(감사 직접 경로의 도메인 증명이 그 항목을 거절했다) */
export function noteRecheckItemRankRefused(itemId: number, reviewer: RankLike, now = Date.now()): void {
  if (itemSkips.size > 1_000) for (const [key, until] of itemSkips) if (until <= now) itemSkips.delete(key);
  itemSkips.set(`${itemId}|${keyOf(reviewer)}`, now + RECHECK_ITEM_SKIP_MS);
}

/** 그 항목에서 그 순위를 건너뛰는 중인가 */
export function recheckItemRankRefused(itemId: number, reviewer: RankLike, now = Date.now()): boolean {
  const key = `${itemId}|${keyOf(reviewer)}`, until = itemSkips.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  itemSkips.delete(key);
  return false;
}

/**
 * 이 줄(lane)에서 본 「지금 차례인 순위」 — 자기 줄의 순위는 이 틱에 멈춘 것(pausedHere)만, 다른 줄의 순위는 쉼 기록만 건너뛴다. 항목을 주면 그 항목에서 건너뛰는
 * 순위(recheckItemRankRefused)도 건너뛴다. 모두 건너뛰면 null
 */
export function recheckTurn<T extends RankLike>(reviewers: readonly T[], lane: RecheckLane, pausedHere: ReadonlySet<number>, now = Date.now(),
  itemId?: number): T | null {
  return reviewers.find((reviewer) => recheckSkips(reviewer, lane, pausedHere, now, itemId) === false) ?? null;
}

/** 이 줄에서 그 순위를 지금 건너뛰는가(recheckTurn 과 같은 규칙 — 두 줄의 안쪽 순위 반복도 이것을 쓴다) */
export function recheckSkips(reviewer: RankLike, lane: RecheckLane, pausedHere: ReadonlySet<number>, now = Date.now(), itemId?: number): boolean {
  if (itemId !== undefined && recheckItemRankRefused(itemId, reviewer, now)) return true;
  return recheckLaneOf(reviewer) === lane ? pausedHere.has(reviewer.rank) : recheckRankPaused(reviewer, now);
}

/** 묻는 동안 항목을 잡는다 — 다른 줄이 이미 묻고 있으면 false */
export function claimRecheckItem(itemId: number): boolean {
  if (claimed.has(itemId)) return false;
  claimed.add(itemId);
  return true;
}

export function releaseRecheckItem(itemId: number): void {
  claimed.delete(itemId);
}

/** 시험 — 기록을 비운다 */
export function resetRecheckLanes(): void {
  pausedUntil.clear();
  itemSkips.clear();
  claimed.clear();
}
