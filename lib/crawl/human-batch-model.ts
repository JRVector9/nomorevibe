import { HOLD_LABELS } from "@/lib/operations/conveyor-model";
import { DELEGATE_CONFIDENCE_THRESHOLD_TEXT, delegateGroupHref, type DelegateGroup } from "./delegate-groups";
import type { HumanQueueOverview } from "./human-queue";

/**
 * 사람 확인 · 묶음(2026-11-12 운영 콘솔 개편 조각 3b, 최종 시안 「화면 3 사람 확인」·「흐름 5 사람 확인을 묶어서 끝내기」)의 순수 모델.
 *
 * 운영자는 혼자다. 직접 판단 수천 건을 하나씩 보게 하지 않고 묶음으로 보여 주고, 묶음마다 한 번에 끝낼 수 있는지와 그 조치를 적는다.
 * 한 번에 끝내는 동작은 늘 운영자가 표본을 보고 누를 때만 일어난다 — 표본 관문(gateView)이 5건 모두 「맞음」일 때만 일괄 단추를 켠다.
 * DB 를 읽지 않는다(읽기는 lib/operations/human-batches-read.ts, 쓰기는 human-batch-run.ts). 화면 구성 요소(클라이언트 포함)도 이 파일을 부른다.
 */

/** 한 번에 끝낼 수 있는 묶음 — 표본 관문을 거쳐 기존 건별 결정(overrideCandidate)을 부른다 */
export const HUMAN_BATCH_KEYS = ["agreed_approve", "agreed_reject", "repo_deleted"] as const;
export type HumanBatchKey = (typeof HUMAN_BATCH_KEYS)[number];
export const isHumanBatchKey = (value: unknown): value is HumanBatchKey => (HUMAN_BATCH_KEYS as readonly unknown[]).includes(value);
export type HumanBatchVerdict = "ok" | "wrong";
export const isHumanBatchVerdict = (value: unknown): value is HumanBatchVerdict => value === "ok" || value === "wrong";
/** 표본 수 — 묶음이 이보다 작으면 묶음 전부가 표본이다 */
export const HUMAN_BATCH_SAMPLE_SIZE = 5;
/** 한 묶음에서 한 번에 결정하는 최대 건수 — 심사 큐 일괄 결정의 상한(review/contract.ts MAX_BULK_DECISIONS)과 같다(시험이 둘이 같은지 본다) */
export const HUMAN_BATCH_MAX = 50;

/** 표본을 뽑을 때 고정한 대상 하나 — 결정은 이 판(입력·원본·후보 해시)으로만 한다. 그 사이 바뀐 후보는 overrideCandidate 가 거절한다 */
export type HumanBatchMember = { id: number; repo: string; inputHash: string; sourceRevisionHash: string; candidateRevisionHash: string };
export type HumanBatchDecided = { id: number; repo: string; attemptId: number };
export type HumanBatchResult = {
  decision: "approve" | "reject"; reason: string; note: string;
  /** 결정한 건 — 묶음째 되돌리기가 이 목록을 그대로 되돌린다(undoAdminDecision) */
  decided: HumanBatchDecided[];
  /** overrideCandidate 가 거절한 건(그 사이 바뀜·이미 발행 등) */
  failures: { id: number; repo: string; message: string }[];
  /** 실행 직전 검사로 남긴 건(저장소가 살아 있음·확인 못 함) */
  skipped: { id: number; repo: string; why: string }[];
  /** 표본을 뽑은 뒤 묶음에 들어와 이번 일괄에서 뺀 수 */
  excludedNew: number;
  /** 고정한 대상 중 실행 때 묶음에 없던(이미 처리된) 수 */
  excludedGone: number;
};
export type HumanBatchUndoResult = { restored: number; failures: { id: number; repo: string; message: string }[] };

export type HumanBatchGuide = {
  title: string; decision: "approve" | "reject"; verb: "승인" | "거절";
  /** 저장 전 확인의 「다음 단계」 */
  next: string;
  /** 메모를 비웠을 때 남길 사유 */
  note: string;
  /** 실행 직전 GitHub 에 저장소를 다시 묻는가(저장소가 없어짐) */
  repoCheck: boolean;
};
export const HUMAN_BATCH_GUIDE: Record<HumanBatchKey, HumanBatchGuide> = {
  agreed_approve: { title: "두 모델이 모두 승인한 것", decision: "approve", verb: "승인", repoCheck: false,
    next: "승인 → 발행 워커가 중복·차단·소개를 다시 확인한 뒤 공개합니다", note: "AI·2차 일치 승인" },
  agreed_reject: { title: "두 모델이 모두 거절한 것", decision: "reject", verb: "거절", repoCheck: false,
    next: "거절로 닫습니다 — 공개 목록에 오르지 않습니다", note: "두 모델 모두 거절" },
  repo_deleted: { title: "저장소가 없어짐", decision: "reject", verb: "거절", repoCheck: true,
    next: "실행 직전에 GitHub 에 저장소를 한 건씩 다시 묻고, 정말 없는(404) 것만 거절합니다. 살아 있거나 확인하지 못한 것은 그대로 둡니다",
    note: "레포 삭제됨 — 제품을 확인할 수 없음" },
};
/** 저장 전 확인의 「되돌리기」 — 건별 되돌리기(undoAdminDecision)를 묶음째 부른다 */
export const HUMAN_BATCH_UNDO_TEXT = "「일괄 결정 기록」에서 묶음째 되돌립니다. 결정 뒤 발행·판정이 손대지 않은 건만 결정 앞 상태로 돌아가고, 이미 공개된 건은 제품 관리에서 내립니다.";

/** 사람 확인 · 묶음 화면 주소 — 메뉴 「사람 확인」의 기본 화면 */
export const HUMAN_BATCHES_HREF = "/admin/review/batches";
export const humanBatchAnchor = (key: HumanBatchKey) => `batch-${key}`;
export const HUMAN_BATCH_LOG_ANCHOR = "batch-log";
export const HUMAN_BATCH_THRESHOLD_ANCHOR = "threshold";
/** 기존 목록(하나씩 보기)에서 한 보류 사유만 — 심사 큐의 ?reason= 거르기(가볍다. ?cause= 는 보류 전부를 다시 판정한다) */
export const holdListHref = (reason: string) => `/admin/review?tab=all&state=needs_review&reason=${encodeURIComponent(reason)}#review-list`;
/** 후보 한 건을 기존 상세로 연다 */
export const candidateHref = (id: number) => `/admin/review?tab=all&focus=${id}`;
/** 지금 사람 확인 목록(하나씩 보기) */
export const ONE_BY_ONE_HREF = "/admin/review?tab=human";

/** 작업 로그의 일괄 결정 줄 → 되돌리는 곳(작업 로그 「그 뒤」 칸). 다른 줄은 null */
export function humanBatchUndo(action: string, target: string): { text: string; href: string } | null {
  if (action !== "human-batch-run" || !/^batch:\d+$/.test(target)) return null;
  return { text: `사람 확인 › 일괄 결정 기록에서 묶음째 되돌립니다(${target.slice(6)}번 묶음)`, href: `${HUMAN_BATCHES_HREF}#${HUMAN_BATCH_LOG_ANCHOR}` };
}

const count = (value: number) => value.toLocaleString("ko-KR");

// ─────────────────────────── 머리줄 ───────────────────────────

export type HumanStripItem = { key: "direct" | "stalled" | "in24h" | "human" | "ai"; label: string; value: number | null };

/** 머리줄 — 직접 판단 · 2주 넘음 · 24시간 들어옴 · 사람이 끝냄 · AI가 대신 끝냄. 못 읽은 칸은 null(셀 수 없음) */
export function humanBatchStrip(input: {
  overview: Pick<HumanQueueOverview, "stages" | "wait" | "decided24h"> | null;
  /** 사람 몫 위임 검수의 24시간 결과(human-assist-progress.ts) — 승인·반려가 AI가 대신 끝낸 것 */
  assistDay: { approve: number; reject: number } | null;
}): HumanStripItem[] {
  const { overview, assistDay } = input;
  return [
    { key: "direct", label: "직접 판단", value: overview ? overview.stages.human : null },
    { key: "stalled", label: "2주 넘음", value: overview?.wait ? overview.wait.stalled : null },
    { key: "in24h", label: "24시간 들어옴", value: overview?.wait ? overview.wait.in24h : null },
    { key: "human", label: "사람이 끝냄", value: overview?.decided24h ? overview.decided24h.approve + overview.decided24h.reject : null },
    { key: "ai", label: "AI가 대신 끝냄", value: assistDay ? assistDay.approve + assistDay.reject : null },
  ];
}

// ─────────────────────────── 보류 묶음 ───────────────────────────

export type HoldAction =
  /** 표본 관문을 거치는 일괄 결정 — 같은 화면의 묶음 칸으로 간다 */
  | { kind: "batch"; label: string; key: HumanBatchKey }
  /** AI 가 이미 다시 보고 있다 — 건수와 함께 보이고 문턱 보기로 잇는다 */
  | { kind: "auto"; label: string; detail: string | null; href: string }
  /** 기존 화면으로 */
  | { kind: "link"; label: string; href: string; note?: string };
export type HoldRow = { reason: string; label: string; count: number; recent24h: number; action: HoldAction };

/**
 * 보류 사유 → 묶음 이름과 조치. 조치는 사유에 맞는 기존 동작으로만 잇는다(2026-11-12 조각 3b 지시):
 *  - 저장소가 없어짐: 「한 번에 거절」 — 2026-10-13 운영자 결정(저장소가 정말 사라졌으면 내린다). 실행 직전 GitHub 확인을 유지한다
 *  - 소개 문구 없음: 「소개 넣기」 — 상세의 「소개 적고 승인」(approveWithTagline)이 있는 기존 목록
 *  - 승인 근거가 바뀜: 다시 심사로 보내는 기존 동작이 없다(보류 되돌리기 requeueResolved 는 사람만 가르는 사유를 일부러 뺀다) → 하나씩 보기
 *  - 원본을 다시 못 받음: 일괄 「다시 받기」가 없다. 상세의 「추가 원본·근거 수집 요청」(건마다 사유·같은 입력 2회까지) → 하나씩 보기
 *  - 2차 심사가 갈림: AI 판가름·재확인이 이미 다시 본다 → 건수와 「문턱 보기」
 */
const HOLD_GUIDE: Readonly<Record<string, { label: string; action: "batch" | "auto" | "tagline" | "list"; note?: string }>> = {
  second_review_split: { label: "2차 심사가 갈림", action: "auto" },
  ambiguous: { label: "규칙으로 못 가름", action: "list" },
  no_description: { label: "소개 문구 없음", action: "tagline" },
  repo_deleted: { label: "저장소가 없어짐", action: "batch" },
  review_approval_changed: { label: "승인 근거가 바뀜", action: "list" },
  source_refresh_failed: { label: "원본을 다시 못 받음", action: "list", note: "상세의 추가 수집 요청" },
  suspected_spam: { label: "스팸 의심", action: "list" },
  ai_review_exhausted: { label: "1차 재시도 소진", action: "list" },
};

/**
 * 보류 묶음 표 — 사유별 건수(많은 순)·24시간 증가·조치. autoRecheck 는 2차 갈림을 AI 가 다시 본 24시간 수(판가름·재확인), 못 읽으면 null.
 */
export function humanHoldRows(holds: readonly { reason: string; count: number; recent24h: number }[],
  autoRecheck: { seen: number; rejected: number } | null): HoldRow[] {
  return [...holds].filter(row => row.count > 0).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).map(row => {
    const guide = HOLD_GUIDE[row.reason];
    const label = guide?.label ?? HOLD_LABELS[row.reason] ?? row.reason;
    const href = holdListHref(row.reason);
    const action: HoldAction = guide?.action === "batch" ? { kind: "batch", label: "한 번에 거절", key: "repo_deleted" }
      : guide?.action === "auto" ? { kind: "auto", label: "AI 재확인이 처리 중", href: `#${HUMAN_BATCH_THRESHOLD_ANCHOR}`,
        detail: autoRecheck ? `24시간 ${count(autoRecheck.seen)}건 다시 봄 · 거절 ${count(autoRecheck.rejected)}건` : null }
      : guide?.action === "tagline" ? { kind: "link", label: "소개 넣기", href }
      : { kind: "link", label: "하나씩 보기", href, ...(guide?.note ? { note: guide.note } : {}) };
    return { reason: row.reason, label, count: row.count, recent24h: row.recent24h, action };
  });
}

// ─────────────────────────── 사람에게 남은 까닭 ───────────────────────────

export type WhyRow = { group: DelegateGroup; label: string; count: number; next: { label: string; href: string | null } };

/** 「사람에게 남은 까닭」 — AI 위임 결과 갈래(delegate-groups.ts) 수. 0건인 갈래는 그리지 않는다(시안) */
export function humanWhyRows(counts: Readonly<Record<DelegateGroup, number>>, aiWaiting: number | null): WhyRow[] {
  const list = (group: DelegateGroup) => ({ label: "하나씩 보기", href: delegateGroupHref(group) });
  const rows: [DelegateGroup, string, WhyRow["next"]][] = [
    ["low_confidence", `AI 확신이 문턱 ${DELEGATE_CONFIDENCE_THRESHOLD_TEXT} 아래`, { label: "문턱 보기", href: `#${HUMAN_BATCH_THRESHOLD_ANCHOR}` }],
    ["unreviewed", "아직 AI가 안 봄", { label: aiWaiting === null ? "AI가 보는 중" : `AI가 보는 중 · 대기 ${count(aiWaiting)}건`, href: null }],
    ["abstained", "AI가 판단을 포기", list("abstained")],
    ["admin", "관리자가 보류해 둠", list("admin")],
    ["human_only", "사람만 볼 것", list("human_only")],
    ["legacy", "옛 기록", list("legacy")],
  ];
  return rows.filter(([group]) => (counts[group] ?? 0) > 0).map(([group, label, next]) => ({ group, label, count: counts[group], next }));
}

// ─────────────────────────── 묶음 구성 ───────────────────────────

/** 확정만 하면 되는 구간(두 모델이 같은 결론)을 승인·거절로 가른다 — 2차 칩(unanimous·agreed)과 겹치는 것만. 승인·거절이 겹치면 거절 쪽 */
export function agreedSplit(overview: Pick<HumanQueueOverview, "ids" | "secondIds">): { approve: number[]; reject: number[] } {
  const reject = new Set([...overview.secondIds.unanimous_reject, ...overview.secondIds.agreed_reject]);
  const approve = new Set([...overview.secondIds.unanimous_approve, ...overview.secondIds.agreed_approve]);
  return { approve: overview.ids.agreed.filter(id => approve.has(id) && !reject.has(id)), reject: overview.ids.agreed.filter(id => reject.has(id)) };
}

/** 묶음별 지금 후보 id — 확정 구간(사람 몫 집계)과 저장소가 없어짐 보류(사유) */
export function humanBatchMembers(overview: Pick<HumanQueueOverview, "ids" | "secondIds">, repoDeleted: readonly number[]): Record<HumanBatchKey, number[]> {
  const split = agreedSplit(overview);
  return { agreed_approve: split.approve, agreed_reject: split.reject, repo_deleted: [...repoDeleted] };
}

/**
 * 표본 — 무작위로 size 건(묶음이 작으면 전부). randomInt(n) 은 0 이상 n 미만의 정수를 낸다(서버는 crypto.randomInt).
 * 앞에서부터 Fisher–Yates 로 섞으므로 같은 id 를 두 번 뽑지 않는다.
 */
export function pickSample(ids: readonly number[], size: number, randomInt: (max: number) => number): number[] {
  const pool = [...new Set(ids)];
  const take = Math.min(size, pool.length);
  for (let index = 0; index < take; index++) {
    const pick = index + randomInt(pool.length - index);
    [pool[index], pool[pick]] = [pool[pick], pool[index]];
  }
  return pool.slice(0, take);
}

// ─────────────────────────── 표본 관문 ───────────────────────────

export type HumanBatchGateLike = {
  members: readonly Pick<HumanBatchMember, "id">[];
  sampleIds: readonly number[];
  verdicts: Readonly<Record<string, HumanBatchVerdict>>;
  /** 앞선 표본에서 「아님」을 받아 이번 묶음에서 뺀 후보 */
  excluded: readonly number[];
  executedAt: string | Date | null;
};
export type HumanBatchGateView = {
  sampleSize: number;
  /** 판정한 표본 수 */
  judged: number;
  ok: number;
  /** 「아님」을 받은 표본 — 일괄에서 빠지고 따로 보인다 */
  wrongIds: number[];
  /** 아직 판정하지 않은 표본(차례대로) */
  pendingIds: number[];
  /** 일괄 단추를 켤 수 있는가 — 표본 전부 「맞음」이고, 실행 전이고, 결정할 대상이 있을 때만 */
  open: boolean;
  /** 지금 일괄 대상 — 고정한 대상 ∩ 지금 묶음 − 뺀 것(앞선 「아님」·이번 「아님」) */
  targets: number[];
  /** 표본을 뽑은 뒤 묶음에 들어온 수 — 이번 일괄에서 뺀다 */
  added: number;
  /** 고정한 대상 중 지금 묶음에 없는 수(그 사이 다른 곳에서 처리됨) */
  gone: number;
  executed: boolean;
  /** 지금 묶음을 읽지 못했는가 — 그러면 대상은 고정한 그대로이고 단추는 켜지 않는다 */
  unknownCurrent: boolean;
};

/**
 * 표본 관문의 상태. 규칙:
 *  - 표본 전부(보통 5건)가 「맞음」일 때만 open. 하나라도 「아님」이면 꺼지고 그 건은 wrongIds 로 따로 보인다.
 *  - 스냅숏이 바뀌면(표본을 뽑은 뒤 묶음에 새 건이 들어오면) 새 건은 대상에서 뺀다 — targets 는 고정한 대상 안에서만 고른다.
 *  - 지금 묶음을 읽지 못하면(currentIds null) 켜지 않는다.
 */
export function humanBatchGateView(gate: HumanBatchGateLike, currentIds: readonly number[] | null): HumanBatchGateView {
  const pinned = gate.members.map(member => member.id);
  const pinnedSet = new Set(pinned);
  const verdictOf = (id: number) => gate.verdicts[String(id)];
  const wrongIds = gate.sampleIds.filter(id => verdictOf(id) === "wrong");
  const okCount = gate.sampleIds.filter(id => verdictOf(id) === "ok").length;
  const pendingIds = gate.sampleIds.filter(id => !isHumanBatchVerdict(verdictOf(id)));
  const out = new Set([...gate.excluded, ...wrongIds]);
  const current = currentIds ? new Set(currentIds) : null;
  const targets = pinned.filter(id => !out.has(id) && (!current || current.has(id)));
  const added = currentIds ? new Set(currentIds.filter(id => !pinnedSet.has(id) && !gate.excluded.includes(id))).size : 0;
  const gone = current ? pinned.filter(id => !current.has(id)).length : 0;
  const executed = gate.executedAt !== null;
  const allOk = gate.sampleIds.length > 0 && okCount === gate.sampleIds.length;
  return { sampleSize: gate.sampleIds.length, judged: okCount + wrongIds.length, ok: okCount, wrongIds, pendingIds,
    open: !executed && current !== null && allOk && targets.length > 0, targets, added, gone, executed, unknownCurrent: current === null };
}

/** 저장 전 확인 — 몇 건 · 다음 단계 · 되돌리는 방법 */
export function humanBatchConfirmLines(key: HumanBatchKey, view: Pick<HumanBatchGateView, "targets" | "added" | "gone" | "ok" | "sampleSize">): string[] {
  const guide = HUMAN_BATCH_GUIDE[key];
  return [
    `${guide.verb} ${count(view.targets.length)}건 — 표본 ${count(view.sampleSize)}건 중 ${count(view.ok)}건 맞음`,
    `다음 단계 · ${guide.next}`,
    `되돌리기 · ${HUMAN_BATCH_UNDO_TEXT}`,
    ...(view.added ? [`표본을 뽑은 뒤 들어온 ${count(view.added)}건은 이번에 넣지 않습니다(다음 표본에서)`] : []),
    ...(view.gone ? [`고정한 대상 중 ${count(view.gone)}건은 이미 다른 곳에서 처리돼 뺍니다`] : []),
  ];
}

/** 결과 한 줄 — 「승인 25건 · 실패 1건 · 남김 2건」 */
export function humanBatchResultLine(result: Pick<HumanBatchResult, "decision" | "decided" | "failures" | "skipped">): string {
  const verb = result.decision === "approve" ? "승인" : "거절";
  return [`${verb} ${count(result.decided.length)}건`, result.failures.length ? `실패 ${count(result.failures.length)}건` : null,
    result.skipped.length ? `남김 ${count(result.skipped.length)}건` : null].filter(Boolean).join(" · ");
}
