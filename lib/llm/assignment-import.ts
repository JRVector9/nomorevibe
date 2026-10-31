import type { z } from "zod";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { ModelCapacityPolicy } from "./capacity";
import type { ModelAssignmentRow, modelAssignmentInputSchema } from "./capacity-helpers";
import type { ModelRegistry } from "./model-registry";

/**
 * 「현재 설정 → 배정 표 가져오기」 계획 — **3b-B 가 이 파일을 실제 구현으로 바꾼다(PR 3b-D 의 자리표).**
 *
 * 3b-D(관리자 배정 화면 /admin/models/assignments)는 이 모듈의 이름·형만 쓴다: `planAssignmentImport(sources)` 가 돌려주는 행을 하나씩
 * `saveModelAssignment`(PR 3b-A)로 저장하고 행마다 결과를 보인다. 계획은 순수 함수다 — 설정(firstReview·firstReviewAdditional·secondReview.voters·
 * fallbacks·stageModelPools)·등록부·정책·장비·지금 배정 표 행을 받아 만들기(create)·고치기(update)·그대로(unchanged) 행과 경고를 낸다.
 * 화면은 계획의 hash 를 보여 준 계획과 적용 때 다시 만든 계획이 같을 때만 적용한다(그 사이 설정·표가 바뀌면 거절).
 *
 * 이 자리표는 빈 계획과 경고 「3b-B 미반영」만 돌려준다 — 적용해도 아무 행도 쓰지 않는다.
 */

/** saveModelAssignment 의 입력(zod 입력형). update 는 expectedVersion = 지금 행의 판, create 는 null. */
export type AssignmentImportInput = z.input<typeof modelAssignmentInputSchema>;
export type AssignmentImportAction = "create" | "update" | "unchanged";
export type AssignmentImportRow = Readonly<{
  action: AssignmentImportAction;
  input: AssignmentImportInput;
  /** 설정의 어디서 왔나(예: "firstReview", "secondReview.voters[0]", "stageModelPools.reason-translate[1]") — 화면에 그대로 보인다 */
  origin: string;
  /** 사람이 읽는 바뀐 칸(update 만, 예: "순위 2 → 1") */
  changes?: readonly string[];
}>;
export type AssignmentImportPlan = Readonly<{ rows: readonly AssignmentImportRow[]; warnings: readonly string[] }>;
/** 계획이 읽는 것(화면이 모아서 넘긴다). 3b-B 가 칸을 더하면 화면 쪽 readAssignmentImportSources 만 맞춘다. */
export type AssignmentImportSources = Readonly<{
  settings: CrawlSettings;
  registry: ModelRegistry;
  policy: ModelCapacityPolicy | null;
  devices: readonly Readonly<{ deviceId: string; enabled: boolean; roles: readonly Readonly<{ routeId: string; rank: number }>[] }>[];
  assignments: readonly ModelAssignmentRow[];
}>;

export const ASSIGNMENT_IMPORT_STUB_WARNING = "3b-B 미반영";

/** 자리표: 빈 계획 + 경고. 3b-B 의 실제 구현이 같은 이름·형으로 들어온다(동기·비동기 모두 화면이 await 한다). */
export function planAssignmentImport(sources: AssignmentImportSources): AssignmentImportPlan | Promise<AssignmentImportPlan> {
  void sources;
  return Object.freeze({ rows: Object.freeze([]), warnings: Object.freeze([ASSIGNMENT_IMPORT_STUB_WARNING]) });
}
