import type { HumanBatchGate } from "@/lib/crawl/human-batch-store";
import type { HumanBatchesRead, HumanBatchSampleCard } from "@/lib/operations/human-batches-read";
import type { DelegateThresholdPreview } from "@/lib/operations/delegate-threshold-preview";
import type { DelegateRejectSamples } from "@/lib/operations/delegate-threshold-samples";

/**
 * 사람 확인 · 묶음 화면의 고정 자료 — 2026-11-12 운영 실측(조각 3b 지시·시안 probe.json)의 수.
 * 직접 판단 4,440 · 2주 넘음 79 · 24시간 들어옴 101 · 사람이 끝냄 0 · AI가 대신 끝냄 217(승인 199·반려 18), 두 모델 모두 승인 27건(거절 0).
 */
const H = (c: string) => c.repeat(64);
export const AGREED_IDS = [607832, 620876, 631659, 632241, 644577, ...Array.from({ length: 22 }, (_, index) => 650000 + index)];
const AGREED_NAMES = ["bitbitsouvenir-arch/shelf-care", "onestoptechsolutions2-jpg/chama", "hayama369/uchinokoto", "LORPerfume/LORPER", "elandopando8892/rateware"];
const repoOf = (id: number) => { const index = AGREED_IDS.indexOf(id); return index >= 0 && index < 5 ? AGREED_NAMES[index] : `sample-owner/app-${id}`; };
export const REPO_DELETED_IDS = Array.from({ length: 30 }, (_, index) => 700000 + index);
const at = (iso: string) => new Date(iso);

const empty = { approve: 0, reject: 0, forward: 0, held: 0, refresh: 0, ineligible: 0, failed: 0 };

export function batchGate(over: Partial<HumanBatchGate> = {}): HumanBatchGate {
  return { id: 41, batchKey: "agreed_approve", actor: "jr", snapshotHash: H("e"),
    members: AGREED_IDS.map(id => ({ id, repo: repoOf(id), inputHash: H("a"), sourceRevisionHash: H("b"), candidateRevisionHash: H("c") })),
    sampleIds: [631659, 650003, 607832, 650017, 644577], verdicts: { 631659: "ok", 650003: "ok", 607832: "ok" }, excluded: [],
    createdAt: at("2026-11-12T01:10:00Z"), updatedAt: at("2026-11-12T01:14:00Z"), executedAt: null, decision: null, result: null,
    undoneAt: null, undoneBy: null, undoResult: null, ...over };
}

export const SAMPLE_CARDS: HumanBatchSampleCard[] = [631659, 650003, 607832, 650017, 644577].map((id, index) => ({
  id, repo: repoOf(id), name: index === 0 ? "うちのこと" : repoOf(id).split("/")[1], productUrl: `https://example.com/${id}`,
  intro: index === 0 ? "반려동물 일상을 기록하고 가족과 나누는 웹앱" : "작은 가게를 위한 재고·주문 관리 도구",
  state: "needs_review", reason: "second_review_split",
  first: { decision: "approve", confidence: 0.86, reason: "가입 후 쓰는 웹앱이 배포돼 있고 README 에 기능 설명이 있다." },
  seconds: [{ model: "qwen3.8-32b", decision: "approve", reason: "실제로 쓸 수 있는 앱 페이지다." }],
  delegate: null, stopped: null,
}));

export function humanBatchesFixture(over: Partial<HumanBatchesRead> = {}): HumanBatchesRead {
  return {
    measuredAt: "2026-11-12T02:00:00.000Z",
    overview: {
      held: 4792, ids: { ai: [], second: [], agreed: AGREED_IDS, human: [] },
      stages: { ai: 238, second: 87, agreed: 27, human: 4440 }, agreed: { reject: 0, approve: 27 }, person: 4467,
      secondIds: { unanimous_reject: [], unanimous_approve: AGREED_IDS, agreed_reject: [], agreed_approve: [], needs_human: [] },
      second: { unanimous_reject: 0, unanimous_approve: 27, agreed_reject: 0, agreed_approve: 0, needs_human: 0 }, secondPublished: 0,
      wait: { oldestDays: 15, stalled: 79, in24h: 101 }, decided24h: { approve: 0, reject: 0 },
      aiDecisions: { counts: { reject: 0, approve: 0, needs_review: 0, none: 0 }, ids: new Map() },
    },
    holds: [
      { reason: "ai_review_exhausted", count: 1, recent24h: 0 }, { reason: "ambiguous", count: 325, recent24h: 323 },
      { reason: "no_description", count: 133, recent24h: 2 }, { reason: "repo_deleted", count: 30, recent24h: 7 },
      { reason: "review_approval_changed", count: 8, recent24h: 8 }, { reason: "second_review_split", count: 4283, recent24h: 101 },
      { reason: "source_refresh_failed", count: 7, recent24h: 0 }, { reason: "suspected_spam", count: 5, recent24h: 0 },
    ],
    delegate: { counts: { abstained: 313, low_confidence: 2897, human_only: 30, legacy: 2, unreviewed: 1103, admin: 122 } },
    assist: { measuredAt: "2026-11-11T23:59:45.231Z", decidedDay: 241, tasks: {
      "human-review": { five: empty, hour: empty, day: { ...empty, approve: 199, reject: 18, held: 4454, refresh: 515, failed: 29 }, waiting: 602 },
      "split-confirm": { five: empty, hour: empty, day: { ...empty, reject: 4, held: 9 }, waiting: 0 },
      "split-tiebreak": { five: empty, hour: empty, day: { ...empty, forward: 13, held: 68, ineligible: 1102 }, waiting: null },
      "held-review-retry": { five: empty, hour: empty, day: { ...empty, reject: 15, forward: 5, held: 123 }, waiting: null },
    } },
    inbox: { fetchedAt: "2026-11-12T02:00:00.000Z", done: [0, 0], results: Object.fromEntries(
      ["takedown", "introRequest", "feedback", "makerReply", "contact", "human", "agreed", "audit", "down", "intro", "translations", "repoGone", "repoAutoBanned", "spam"]
        .map(key => [key, { ok: true, data: { count: 0, items: [] } }])) as unknown as NonNullable<HumanBatchesRead["inbox"]>["results"] },
    audit: { open: 563, overdue: 553, oldestWaitDays: 27 },
    panels: [
      { key: "agreed_approve", members: AGREED_IDS, gate: batchGate(), cards: SAMPLE_CARDS,
        preview: AGREED_IDS.slice(0, 5).map((id, index) => ({ id, repo: repoOf(id), since: `2026-11-03T0${index}:27:59.644Z` })) },
      { key: "agreed_reject", members: [], gate: null, cards: [], preview: [] },
      { key: "repo_deleted", members: REPO_DELETED_IDS, gate: null, cards: [],
        preview: REPO_DELETED_IDS.slice(0, 5).map((id, index) => ({ id, repo: `gone-owner/project-${index + 1}`, since: `2026-11-0${index + 4}T10:00:00.000Z` })) },
    ],
    runs: [
      batchGate({ id: 38, executedAt: at("2026-11-11T23:40:00Z"), decision: "approve", result: { decision: "approve", reason: "passed", note: "AI·2차 일치 승인",
        decided: [{ id: 1, repo: "a/one", attemptId: 11 }, { id: 2, repo: "a/two", attemptId: 12 }, { id: 3, repo: "a/three", attemptId: 13 }],
        failures: [{ id: 4, repo: "a/four", message: "후보 또는 근거가 변경되었습니다." }], skipped: [], excludedNew: 2, excludedGone: 0 } }),
      batchGate({ id: 35, batchKey: "repo_deleted", executedAt: at("2026-11-11T09:10:00Z"), decision: "reject",
        result: { decision: "reject", reason: "not_a_product", note: "레포 삭제됨 — 제품을 확인할 수 없음",
          decided: [{ id: 5, repo: "b/five", attemptId: 21 }], failures: [], skipped: [{ id: 6, repo: "b/six", why: "저장소가 살아 있음 — 거절하지 않음" }], excludedNew: 0, excludedGone: 0 },
        undoneAt: at("2026-11-11T09:20:00Z"), undoneBy: "jr", undoResult: { restored: 1, failures: [] } }),
    ],
    ...over,
  };
}

export const THRESHOLD_PREVIEW: DelegateThresholdPreview = {
  measuredAt: "2026-11-12T01:58:00.000Z", hours: 24, currentThreshold: 0.9, total: 1620, ignored: 0,
  ending: { applied: 88, model_abstained: 280, low_confidence: 1180, cannot_approve: 30, stale_evidence: 40, repo_changed: 1, repo_gone: 1 },
  byDecision: {} as never, byDecisionEnding: {} as never,
  thresholds: [
    { threshold: 0.9, approve: 42, approveRepoCheck: 5, approveStale: 0, reject: 46, held: 1532 },
    { threshold: 0.85, approve: 120, approveRepoCheck: 14, approveStale: 3, reject: 410, held: 1090 },
    { threshold: 0.8, approve: 260, approveRepoCheck: 30, approveStale: 9, reject: 820, held: 540 },
    { threshold: 0.75, approve: 300, approveRepoCheck: 33, approveStale: 11, reject: 960, held: 360 },
    { threshold: 0.7, approve: 310, approveRepoCheck: 34, approveStale: 12, reject: 990, held: 320 },
  ],
};
export const REJECT_SAMPLES: DelegateRejectSamples = { lower: 0.85, upper: 0.9, hours: 24, total: 364, samples: [
  { candidateId: 812345, repo: "someone/portfolio-site", confidence: 0.88, reason: "개인 포트폴리오로 설치하거나 쓸 제품이 없다.", at: "2026-11-12T01:00:00.000Z", state: "needs_review" },
  { candidateId: 812399, repo: "team/agency-landing", confidence: 0.86, reason: "회사 소개 페이지다.", at: "2026-11-12T00:40:00.000Z", state: "needs_review" },
] };
