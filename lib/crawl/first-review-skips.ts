import { z } from "zod";

/**
 * 1차 심사의 건너뜀 상한(2026-11-12 사용자 지시 「최대 재시도 횟수를 정해야 한다」).
 *
 * 실패(failed·superseded)는 시도 행으로 남아 MAX_REVIEW_ATTEMPTS 로 세지만, 건너뜀(crawl.agent_review_skipped)은 시도 행이 없어 끝없이 되풀이됐다 —
 * 2026-11-11 16:00Z~ 주인 잃은 위임 시도에 묶인 두 후보가 매 틱 「running」으로 건너뛰어졌다. 같은 후보가 후보 자체에 묶인 까닭으로
 * 연속해서 건너뛰어진 횟수를 1차 잡 커서(jobs.cursor.firstReviewSkips)의 작은 표에 센다:
 *  - 연속 FIRST_REVIEW_SKIP_STREAK_LIMIT 번이면 그 후보를 FIRST_REVIEW_SKIP_EXCLUDE_MS 동안 쪽에서 뺀다(reviewCandidatePredicate excludeCandidateIds).
 *  - 그렇게 빼기를 FIRST_REVIEW_SKIP_STRIKE_LIMIT 번 거듭하면 사람 확인으로 넘긴다(needs_review · ai_review_skip_exhausted, 멈춘 곳에 건너뛴 까닭).
 *  - 심사로 나아간 후보(claim·스팸 보류)는 표에서 지운다. 모델·틱 쪽 사정(모든 순위 못 씀·포화·틱 마감·stage 등)은 후보 탓이 아니라 세지도 지우지도 않는다.
 * 표는 FIRST_REVIEW_SKIP_TABLE_MAX 칸, 칸의 수명은 FIRST_REVIEW_SKIP_ENTRY_TTL_MS 다 — 커서가 끝없이 자라지 않는다.
 */
export const FIRST_REVIEW_SKIP_STREAK_LIMIT = 5;
export const FIRST_REVIEW_SKIP_EXCLUDE_MS = 30 * 60_000;
export const FIRST_REVIEW_SKIP_STRIKE_LIMIT = 3;
export const FIRST_REVIEW_SKIP_TABLE_MAX = 64;
export const FIRST_REVIEW_SKIP_ENTRY_TTL_MS = 24 * 3600_000;

/**
 * 후보 자체에 묶인 건너뜀 까닭과 사람이 읽을 말 — 이 까닭만 센다. lib/crawl/jobs/agent-review.ts 의 skip 과 claimReview 의 skipped 까닭,
 * 그리고 capacity-deferred.ts 의 작업(work) 범위 미룸 가운데 그 후보의 장부 행에 묶인 것(dispatched·work_busy·ledger_mismatch)이다.
 * 세지 않는 것: all_ranks_unusable·model_paused·model_deferred·tick_window_closed·stage_inactive·disabled(모델·틱·전역 사정),
 * withdrawn·reservation_lost(줄·예약의 흐름 — 포화 쪽), retry_wait(실패 뒤의 정해진 기다림 — 실패는 MAX_REVIEW_ATTEMPTS 가 센다).
 */
export const FIRST_REVIEW_SKIP_REASON_LABELS = {
  running: "다른 검수(1차·위임)가 이 후보를 보는 중",
  item_owned: "다른 1차 작업 항목이 이 후보를 쥐고 있음",
  input_changed: "심사 직전에 후보·원본·설정이 바뀜",
  input_expired: "원본·근거의 유효 기간이 지남",
  input_too_large: "심사 입력이 크기 상한을 넘음",
  document_missing: "수집 원본이 없음",
  not_review_candidate: "1차 심사 대상 상태가 아님",
  reviewer_unassigned: "살아 있는 호출·예약이 이 후보를 순위 밖 모델에 묶음",
  pending_hint_mismatch: "기다리던 예약과 지금 고른 모델이 다름",
  attempts_exhausted: "1차 재시도 횟수를 다 씀",
  infrastructure_interruptions_exhausted: "작업 중단이 24시간 안에 세 번",
  dispatched: "앞선 호출이 아직 보내진 중",
  work_busy: "같은 후보가 다른 요청에 묶임",
  ledger_mismatch: "장부 세대가 맞지 않음",
} as const satisfies Record<string, string>;
export type CandidateBoundSkipReason = keyof typeof FIRST_REVIEW_SKIP_REASON_LABELS;

export function candidateBoundSkip(reason: string): reason is CandidateBoundSkipReason {
  return Object.hasOwn(FIRST_REVIEW_SKIP_REASON_LABELS, reason);
}

export function firstReviewSkipReasonText(reason: string): string {
  return candidateBoundSkip(reason) ? FIRST_REVIEW_SKIP_REASON_LABELS[reason] : reason;
}

const entrySchema = z.object({
  /** 마지막으로 센 까닭 */
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  /** 그 까닭으로 연속해 건너뛴 수(상한에 닿으면 0 으로 돌린다) */
  streak: z.number().int().min(0).max(1_000),
  /** 상한에 닿아 쪽에서 뺀 횟수 */
  strikes: z.number().int().min(0).max(1_000),
  /** 처음 상한에 닿은 때(ms) — 사람에게 넘기기 전에 그 뒤로 다른 후보가 나아갔는지 본다 */
  firstCappedAt: z.number().int().positive().nullable(),
  /** 이 시각(ms)까지 쪽에서 뺀다 */
  excludedUntil: z.number().int().positive().nullable(),
  lastAt: z.number().int().positive(),
}).strict();
export type FirstReviewSkipEntry = z.infer<typeof entrySchema>;
/** 후보 id(문자열) → 칸 */
export type FirstReviewSkipTable = Record<string, FirstReviewSkipEntry>;

/** 커서의 표를 읽는다 — 모양이 어긋난 칸·수명이 다한 칸은 버린다(커서가 깨져도 심사는 멈추지 않는다) */
export function readFirstReviewSkips(value: unknown, now: number): FirstReviewSkipTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const table: FirstReviewSkipTable = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[1-9][0-9]{0,15}$/.test(key) || !Number.isSafeInteger(Number(key))) continue;
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success || expired(parsed.data, now)) continue;
    table[key] = parsed.data;
  }
  return boundFirstReviewSkips(table, now);
}

const excluded = (entry: FirstReviewSkipEntry, now: number) => entry.excludedUntil !== null && entry.excludedUntil > now;
const expired = (entry: FirstReviewSkipEntry, now: number) => !excluded(entry, now) && now - entry.lastAt > FIRST_REVIEW_SKIP_ENTRY_TTL_MS;

/** 지금 쪽에서 뺄 후보 */
export function excludedFirstReviewCandidates(table: FirstReviewSkipTable, now: number): number[] {
  return Object.entries(table).filter(([, entry]) => excluded(entry, now)).map(([key]) => Number(key)).sort((a, b) => a - b);
}

/** 한 틱에서 후보 하나가 끝난 꼴 — skipped(까닭)·progressed(claim·스팸 보류)·neutral(모델·틱 쪽 사정) */
export type FirstReviewTickOutcome = { kind: "skipped"; reason: string } | { kind: "progressed" } | { kind: "neutral" };
export type FirstReviewSkipCap = { candidateId: number; reason: string; strikes: number; firstCappedAt: number; handOff: boolean };

/**
 * 틱의 결과를 표에 반영한다(새 표를 돌려준다 — 받은 표는 바꾸지 않는다).
 * capped — 이번 틱에 상한에 닿아 쪽에서 뺀 후보. handOff 이면 사람 확인으로 넘길 차례다(넘기기는 부르는 쪽이 DB 에서 다시 재고 한다).
 */
export function applyFirstReviewTick(previous: FirstReviewSkipTable, outcomes: ReadonlyMap<number, FirstReviewTickOutcome>, now: number):
  { table: FirstReviewSkipTable; capped: FirstReviewSkipCap[] } {
  const table: FirstReviewSkipTable = Object.fromEntries(Object.entries(previous).map(([key, entry]) => [key, { ...entry }]));
  const capped: FirstReviewSkipCap[] = [];
  for (const [candidateId, outcome] of outcomes) {
    const key = String(candidateId);
    if (outcome.kind === "progressed") { delete table[key]; continue; }
    if (outcome.kind !== "skipped" || !candidateBoundSkip(outcome.reason)) continue;
    const before = table[key];
    const entry: FirstReviewSkipEntry = before && before.reason === outcome.reason
      ? { ...before, streak: before.streak + 1, lastAt: now }
      : { reason: outcome.reason, streak: 1, strikes: before?.strikes ?? 0, firstCappedAt: before?.firstCappedAt ?? null,
        excludedUntil: before?.excludedUntil ?? null, lastAt: now };
    if (entry.streak >= FIRST_REVIEW_SKIP_STREAK_LIMIT) {
      entry.streak = 0;
      entry.strikes += 1;
      entry.firstCappedAt ??= now;
      entry.excludedUntil = now + FIRST_REVIEW_SKIP_EXCLUDE_MS;
      capped.push({ candidateId, reason: entry.reason, strikes: entry.strikes, firstCappedAt: entry.firstCappedAt,
        handOff: entry.strikes >= FIRST_REVIEW_SKIP_STRIKE_LIMIT });
    }
    table[key] = entry;
  }
  return { table: boundFirstReviewSkips(table, now), capped };
}

/** 사람 확인으로 넘긴 후보를 표에서 지운다 */
export function forgetFirstReviewSkips(table: FirstReviewSkipTable, candidateIds: Iterable<number>): FirstReviewSkipTable {
  const next = { ...table };
  for (const id of candidateIds) delete next[String(id)];
  return next;
}

/** 크기 상한 — 수명이 다한 칸을 먼저, 그다음 빼지 않은 칸 중 오래된 것부터 버린다. 빼 둔 칸은 마지막에 버린다 */
export function boundFirstReviewSkips(table: FirstReviewSkipTable, now: number): FirstReviewSkipTable {
  const live = Object.entries(table).filter(([, entry]) => !expired(entry, now));
  if (live.length <= FIRST_REVIEW_SKIP_TABLE_MAX) return Object.fromEntries(live);
  live.sort(([, a], [, b]) => Number(excluded(b, now)) - Number(excluded(a, now)) || b.lastAt - a.lastAt);
  return Object.fromEntries(live.slice(0, FIRST_REVIEW_SKIP_TABLE_MAX));
}
