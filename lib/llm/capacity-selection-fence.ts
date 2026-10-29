import { sql, type SQL } from "drizzle-orm";

/**
 * 대기열 선택에서 뺄 대상 — 이미 보냈는데 결과를 모르는 요청(dispatched·indeterminate)에 묶인 대상.
 *
 * requestSlot 의 member·logical fence(capacity-repository.ts)는 그런 대상이 든 새 요청을 늘 deferred 로 돌려보낸다.
 * 선택이 매 틱 같은 머리(최신 사유·새 제품)를 고르면 잡 전체가 ModelCapacityDeferredError 로 끝나 기록이 하나도 남지 않고,
 * 운영 경보는 무진척(no_progress)이 된다. unknown 은 운영 회수 전까지 풀리지 않으므로 그 대상만 건너뛰고 뒤의 일을 한다.
 * 같은 대상을 다시 보내지 않으므로 중복 호출 방지는 그대로다. 대기·예약 행은 TTL 로 풀리고 자기 것은 재개 경로가 이어받아 여기서 빼지 않는다.
 */
// 별칭을 고정한다 — drizzle 은 단일 테이블 select 에서 열 참조의 테이블 이름을 떼어 바깥 열과 섞일 수 있다(search-profiles.ts REVIEWER_NOTE).
const UNSETTLED = sql`mcr_unsettled.state in ('dispatched','indeterminate')`;

/** memberKey(예: 'ko:<hash>', 'product-tagline-ko:<id>')가 결과 모를 요청의 구성원이면 참 */
export function unsettledMemberFence(memberKey: SQL): SQL {
  return sql`exists (select 1 from model_capacity_requests mcr_unsettled where ${UNSETTLED}
    and ${memberKey} = any(mcr_unsettled.logical_member_keys))`;
}

/** logicalKey(예: 'text:profile:<id>')가 결과 모를 요청의 논리 키이면 참 */
export function unsettledLogicalFence(logicalKey: SQL): SQL {
  return sql`exists (select 1 from model_capacity_requests mcr_unsettled where ${UNSETTLED}
    and mcr_unsettled.logical_work_key = ${logicalKey})`;
}
