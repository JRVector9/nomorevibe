import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { HelperAssignmentRow, HelperGateState, HelperMode, HelperStatusSnapshot, SupervisorControlPatch } from "./capacity-helpers";

/**
 * 도우미 배정·감시자 control 의 DB 읽기·저장(PR 2a WP-2a-A). **day 0 의 고정 서명** — 본문은 WP-2a-A 가 채운다.
 * 그때까지 모든 함수는 `capacity_helpers_not_implemented` 를 던진다. 서명·오류 문자열·감사 action 은 바뀌지 않는다.
 *
 * 저장 한 트랜잭션(호출자의 tx 안에서, 장비 저장과 같은 순서): replay 거부 → DR writer fence(SHARE; fenced 면 DrWriterFencedError("site_fenced"))
 * → model_capacity_control id=1 FOR UPDATE(입장 TX 와 같은 잠금 순서 fence → control) → 검증 → 행 FOR UPDATE → version compare-and-set
 * → 쓰기(version + 1) → operations_audit 한 줄. 감싸는 쪽(lib/operations/admin-model-helpers.ts)은 감사 줄을 **또 쓰지 않는다**.
 *
 * 오류 문자열: `model_helper_invalid:<path>` · `model_helper_version_mismatch:<current|none>` · `model_helper_refused:<HelperSaveRefusal>`
 * · `model_supervisor_invalid:<path>` · `model_supervisor_control_missing` · `model_capacity_replay_unsupported` · `model_capacity_control_missing`.
 */

const notImplemented = (...args: unknown[]): never => {
  void args;
  throw new Error("capacity_helpers_not_implemented");
};

/**
 * 배정 저장(upsert). `expectedVersion`: 현재 행의 version(새 배정은 null) — 다르면 `model_helper_version_mismatch:<current|none>`.
 * 저장이 evidence_key 를 계산한다(helperEvidenceKey). 임계값·이력 설정만 바뀌면 version 만 올라가고(그 판의 자동 정지가 풀린다) evidence 는 유지,
 * 모델·프롬프트판·규칙판·wire 변형·계약이 바뀌면 evidence_key 가 바뀌고 같은 저장에서 mode 'live' 는 'shadow' 로 내려간다.
 * 거절: `helper_route_is_primary`(장비 순위에서 도우미 경로가 rank 1) · `helper_route_unmapped`(정책에 경로 없음) ·
 * `helper_ai2_voter_not_in_fallbacks` · `helper_device_unconfigured`(장비 행 없음) · `helper_live_requires_promotion`(승격 없이 live).
 * 감사 action `model-helper-save`, target = assignment_id.
 */
export async function saveHelperAssignment(tx: ProductTransaction, input: unknown, expectedVersion: number | null, actor: string):
  Promise<{ before: HelperAssignmentRow | null; after: HelperAssignmentRow }> {
  return notImplemented(tx, input, expectedVersion, actor);
}

/**
 * 배정의 mode 만 바꾼다(관리자 버튼: 섀도 시작·섀도로 내리기·끄기). 'live' 승격은 PR 2c 의 promote 경로만 한다.
 * version 을 올린다(그 판의 자동 정지가 풀린다 = 「자동 정지 해제」). 감사 action `model-helper-mode`.
 */
export async function setHelperMode(tx: ProductTransaction, assignmentId: string, mode: Exclude<HelperMode, "live">, expectedVersion: number, actor: string):
  Promise<{ before: HelperAssignmentRow; after: HelperAssignmentRow }> {
  return notImplemented(tx, assignmentId, mode, expectedVersion, actor);
}

/** 모든 배정(device_id, stage 순). tx 가 없으면 primary 에서 잠그지 않고 읽는다. */
export async function listHelperAssignments(tx?: ProductTransaction): Promise<HelperAssignmentRow[]> {
  return notImplemented(tx);
}

/** 도우미 경로 상태(helperGateStatesSql). deviceId 가 없으면 배정이 있는 모든 장비(한 문장, LATERAL). primary 에서 잠그지 않고 읽는다. */
export async function readHelperGateStates(deviceId?: string): Promise<HelperGateState[]> {
  return notImplemented(deviceId);
}

/**
 * 관리자 쪽 control 변경(enabled·signal_ttl_ms·loop_ms). 합친 값이 loop_ms × 2 ≤ signal_ttl_ms 를 지켜야 한다(`model_supervisor_invalid:loopMs`).
 * lease 열은 건드리지 않는다. 끄면 다음 입장 TX 부터 새 도우미 grant 가 없다 — 돌고 있는 호출은 끝까지 간다. 감사 action `model-supervisor-toggle`.
 */
export async function setSupervisorControl(tx: ProductTransaction, patch: SupervisorControlPatch, actor: string): Promise<void> {
  return notImplemented(tx, patch, actor);
}

/** 관리자 화면·pipeline-control status 의 한 번 읽기(REPEATABLE READ READ ONLY 한 TX 또는 주어진 tx). control 행이 없으면 `model_supervisor_control_missing`. */
export async function readHelperStatusSnapshot(tx?: ProductTransaction): Promise<HelperStatusSnapshot> {
  return notImplemented(tx);
}
