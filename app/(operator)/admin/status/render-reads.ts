import { cache } from "react";
import { hourlyThroughput } from "@/lib/operations/dashboard";
import { pipelineFlow } from "@/lib/operations/pipeline";
import { readPipelineCompletions } from "@/lib/operations/pipeline-completions";
import { readPipelineControlStatus } from "@/lib/operations/pipeline-control-status";

/**
 * 운영센터의 지금 숫자 — 같은 렌더 안에서는 한 번만 읽는다(React cache, 운영센터 개편 v8 PR5 · 검토 N1·N7).
 *
 * 페이지는 탭과 상관없이 모든 조각을 만든다. 레일·흐름 상세가 pipelineFlow 를, 장부·설정 전환 칸이 제어 상태를,
 * 처리 지표 카드·흐름 상세 노드가 처리 지표를 함께 쓰므로, 각자 부르면 주 DB·복제본을 두 번 훑는다.
 * React cache 는 요청마다 따로다 — 다음 렌더(자동 갱신 10초)는 지금처럼 새로 읽는다. 시간 캐시를 걸지 않는다.
 */
export const flowOnce = cache(() => pipelineFlow());
export const controlStatusOnce = cache(() => readPipelineControlStatus());
export const completionsOnce = cache(() => readPipelineCompletions());
/**
 * 시간별 타일은 60초 캐시다(웹 여러 대가 Valkey 로 나눠 쓴다) — 같은 렌더의 타일·흐름 상세 막대가 한 번 받게.
 * fresh(수동 새로고침)면 그 캐시를 건너뛴다(분당 상한, dashboard.ts). 같은 렌더는 늘 같은 fresh 로 부른다
 */
export const hourlyOnce = cache((fresh: boolean = false) => hourlyThroughput(undefined, { fresh }));
