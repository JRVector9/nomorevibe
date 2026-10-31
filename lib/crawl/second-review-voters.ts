import type { ModelAssignmentRow } from "@/lib/llm/capacity-helpers";
import { stageTableRows, votersForItem } from "@/lib/llm/stage-assignments";
import { stageAssignmentRows } from "@/lib/llm/stage-assignment-snapshot";
import { canonicalReviewModel } from "./review-model-identity";
import type { CrawlSettings } from "./settings-schema";

/**
 * 2차 투표자·대체 목록의 한 길목(PR 3b-B). 2차의 모든 읽기(올리기·입력 검증·정리·공개 관문 SQL·보류 재심사·대체 고르기·발견 관문)가
 * `settings.secondReview.voters`/`fallbacks` 대신 이 두 함수를 읽어, 출처가 바뀌어도 올리는 쪽과 세는 쪽이 같은 목록을 본다.
 *
 * - 스위치(MODEL_ASSIGNMENT_TABLE)가 꺼졌거나 ai2 표에 투표자(rank 1 · vote · live)가 없으면 예전 설정 그대로(같은 배열 객체).
 * - 'table' 이면 투표자 = votersForItem 의 집합(rank 1 · vote · live, rank → assignment_id 순), 대체 = rank ≥ 2 행(rank 순). rank 1 인데 vote 가 아닌 행은
 *   어느 쪽에도 들지 않는다. 같은 모델(canonicalReviewModel)은 한 번 — 2차 기록의 유일 색인이 (후보, 입력, 모델)이다. 투표자와 같은 모델의 대체는 뺀다.
 * - 항목마다 1차와 같은 가중치를 빼는 규칙(sameUnderlyingModel)은 부르는 쪽이 지금처럼 건다.
 * - 객체는 { provider, model } 두 칸뿐이다 — 2차 행 insert 가 그대로 펼친다.
 * - AI2 정책 hash(secondReviewPolicyHash)는 저장된 설정을 그대로 hash 한다 — 배정 표가 바뀌어도 진행 중 2차 receipt 가 hash 로 깨지지 않고,
 *   목록에서 빠진 모델은 입력 검증(secondReviewInputMatches)이 거른다(1차 추가 심사자와 같은 규칙).
 */
export type SecondReviewVoter = CrawlSettings["secondReview"]["voters"][number];
export type SecondReviewTableRow = Pick<ModelAssignmentRow, "assignmentId" | "stage" | "rank" | "role" | "mode" | "model" | "provider" | "vote">;

const voter = (row: Pick<SecondReviewTableRow, "provider" | "model">): SecondReviewVoter =>
  ({ provider: row.provider as SecondReviewVoter["provider"], model: row.model });
function distinct(rows: readonly SecondReviewTableRow[], taken: Set<string>): SecondReviewVoter[] {
  const out: SecondReviewVoter[] = [];
  for (const row of rows) {
    const key = canonicalReviewModel(row.model);
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(voter(row));
  }
  return out;
}

/** 배정 표 행 → 2차 투표자·대체(순수). */
export function tableSecondReviewVoters(rows: readonly SecondReviewTableRow[]): { voters: SecondReviewVoter[]; fallbacks: SecondReviewVoter[] } {
  const own = stageTableRows("ai2", rows), taken = new Set<string>();
  const voters = distinct(votersForItem(own, 1, null), taken);
  const fallbacks = distinct(own.filter(row => row.rank >= 2), taken);
  return { voters, fallbacks };
}

/** 지금 고르기의 투표자·대체와 출처. */
export function secondReviewVoterSets(settings: Pick<CrawlSettings, "secondReview">):
  { voters: SecondReviewVoter[]; fallbacks: SecondReviewVoter[]; source: "table" | "settings" } {
  const rows = stageAssignmentRows("ai2");
  if (!rows) return { voters: settings.secondReview.voters, fallbacks: settings.secondReview.fallbacks ?? [], source: "settings" };
  return { ...tableSecondReviewVoters(rows), source: "table" };
}

/** 2차 투표자(rank 1 · vote) — `settings.secondReview.voters` 대신. */
export const secondReviewVoters = (settings: Pick<CrawlSettings, "secondReview">): SecondReviewVoter[] => secondReviewVoterSets(settings).voters;
/** 2차 대체(rank ≥ 2) — `settings.secondReview.fallbacks ?? []` 대신. */
export const secondReviewFallbacks = (settings: Pick<CrawlSettings, "secondReview">): SecondReviewVoter[] => secondReviewVoterSets(settings).fallbacks;
