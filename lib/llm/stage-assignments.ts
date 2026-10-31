import type { ProductTransaction } from "@/lib/domain/products/generation";
import { sameUnderlyingModel } from "@/lib/crawl/review-model-identity";
import type { AssignmentRole, AssignmentStage, HelperMode, ModelAssignmentRow } from "./capacity-helpers";

/**
 * 단계별 배정 표 읽기와 고르기(PR 3b-A). 고르기는 순수 함수다(DB 없이 시험한다). 이 PR 에서는 hot path 가 부르지 않는다 —
 * 3b-B 가 flag 뒤에서 1차 심사자 고르기(lib/crawl/first-reviewers.ts selectFirstReviewer)와 2차 투표자 목록을 이것으로 바꾼다.
 *
 * - 순서: rank 오름차순, 같은 rank 안에서는 assignment_id 순(안정). 1차 오늘 풀의 순서(주 심사자 → 추가 심사자)를 그대로 옮기려면
 *   3b-B 가 그 순서대로 정렬되는 assignment_id 를 준다.
 * - 고르기는 role 'primary' · mode 'live' 행만 본다(도우미 행은 감시자 관문이 따로 연다).
 */

export type StageAssignmentQuery = Readonly<{ mode?: HelperMode }>;
/** 고르기가 읽는 칸(ModelAssignmentRow 의 부분). 도우미 행이 섞여 와도 role 로 거른다. */
export type StageAssignmentCandidate = Readonly<{ assignmentId: string; rank: number; role: AssignmentRole; mode: HelperMode; model: string; vote: boolean }>;

/** rank 오름차순 → assignment_id 순. 새 배열(입력은 바꾸지 않는다). */
export function orderStageAssignments<T extends Pick<StageAssignmentCandidate, "rank" | "assignmentId">>(rows: readonly T[]): T[] {
  return rows.toSorted((a, b) => a.rank - b.rank || (a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0));
}

/** 한 단계의 배정 표 행(기본 mode 'live'), rank → assignment_id 순. tx 가 없으면 primary 에서 잠그지 않고 읽는다. */
export async function assignmentsForStage(stage: AssignmentStage, query: StageAssignmentQuery = { mode: "live" }, tx?: ProductTransaction):
  Promise<ModelAssignmentRow[]> {
  const { readModelAssignments } = await import("./capacity-helpers-repository");
  return orderStageAssignments(await readModelAssignments({ stage, mode: query.mode ?? "live" }, tx));
}

const usable = (row: Pick<StageAssignmentCandidate, "role" | "mode">) => row.role === "primary" && row.mode === "live";
const itemOk = (itemKey: number) => Number.isSafeInteger(itemKey) && itemKey >= 1;
/** first-reviewers.ts selectFirstReviewer 와 같은 칸: (itemKey − 1) mod n 에서 시작해 차례로 돈다. */
const rotate = <T>(rows: readonly T[], itemKey: number): T[] => {
  const start = (itemKey - 1) % rows.length;
  return [...rows.slice(start), ...rows.slice(0, start)];
};

export type ChooseModelOptions = Readonly<{
  /** 건너뛸 wire 모델(막힌 모델·이미 시도한 모델). 정확히 같은 이름만 건너뛴다. */
  excludeModels?: Iterable<string>;
}>;

/**
 * 한 항목(1차는 후보 id)의 배정을 고른다 — 결정적이다. 가장 낮은 rank 의 live 행들에서 selectFirstReviewer 와 같은 규칙으로
 * (itemKey − 1) mod n 칸에서 시작해 제외되지 않은 첫 행. 그 rank 가 모두 제외되면 다음 rank 에서 같은 규칙으로. 없으면 null.
 * (오늘 1차는 막힌 모델을 「손대지 않은 후보」만 비켜 간다 — 그 조건은 호출자가 excludeModels 를 줄지로 정한다.)
 */
export function chooseModelForItem<T extends Omit<StageAssignmentCandidate, "vote">>(rows: readonly T[], itemKey: number,
  options: ChooseModelOptions = {}): T | null {
  if (!itemOk(itemKey)) return null;
  const excluded = new Set(options.excludeModels ?? []);
  const live = orderStageAssignments(rows.filter(usable));
  for (const rank of [...new Set(live.map(row => row.rank))]) {
    const tier = live.filter(row => row.rank === rank);
    const pick = rotate(tier, itemKey).find(row => !excluded.has(row.model));
    if (pick) return pick;
  }
  return null;
}

/**
 * 2차(ai2) 한 항목의 투표자: rank 1 · vote · live 행에서 1차 모델과 같은 가중치(sameUnderlyingModel)인 행을 뺀다 — 오늘 2차가 1차와 같은
 * 모델의 표를 올리지 않는 규칙(second-review.ts)과 같다. 집합은 항목과 무관하고, 순서만 (itemKey − 1) mod n 칸부터 돈다(첫 dispatch 를 나눈다).
 * `excludeUnderlying` 가 null 이면 빼지 않는다. `sameModel` 은 시험용(기본 sameUnderlyingModel, 등록부를 읽는다).
 */
export function votersForItem<T extends StageAssignmentCandidate>(rows: readonly T[], itemKey: number,
  excludeUnderlying: string | null, sameModel: (a: string, b: string) => boolean = sameUnderlyingModel): T[] {
  if (!itemOk(itemKey)) return [];
  const voters = orderStageAssignments(rows.filter(row => usable(row) && row.rank === 1 && row.vote))
    .filter(row => excludeUnderlying === null || !sameModel(excludeUnderlying, row.model));
  return voters.length ? rotate(voters, itemKey) : [];
}
