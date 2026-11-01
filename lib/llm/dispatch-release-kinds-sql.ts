/**
 * 0158(2026-10-31): 종료 근거(process_group_exit·dr_call_drain)로 dispatched/indeterminate → withdrawn 이 되는 길(0096)을
 * publication_classify_cli(발행 분류 CLI, 0125)와 local_model_direct(gpu3090·M3 직접 호출, 0118·0155)에도 연다.
 *
 * 0096 의 회수 가지는 kind 목록을 16개로 못 박았고, 그 뒤에 생긴 두 kind 는 자기 dispatch 가지(0118·0125)로만 통과한다.
 * 그 가지는 state 에 withdrawn 을 두었지만 publication_classify 는 terminal_evidence 를 cli_model_terminal 로만 받으므로
 * (logical·members 가지도 같은 식이다) `lib/operations/dr/reclaim.ts` 가 process_group_exit 근거로 행을 풀면 UPDATE 가
 * 23514 로 깨졌다(2026-10-31 publisher 컨테이너 사망 뒤 고아 행 1건). local_model_direct 는 0118 가지(withdrawn 포함, terminal 조건 없음)로
 * 통과하지만 같은 회수 길에 이름을 올려 binding 재검증(잡 이름 표 등)과 무관하게 풀리게 한다.
 *
 * 두 kind 모두 binding 최상위에 version=1·logicalWorkKey(=logical_work_key)·model(=model) 이 있어(0125 nmv_publication_classify_binding_valid,
 * lib/llm/local-model-capacity-contract.ts localModelBindingSchema) 0096 과 같은 조건을 만족한다 — 그래서 모양은 0096 가지 그대로이고 kind 목록만 다르다.
 * 저장된 술어 가운데를 고칠 수 없으니(live rebuild) 같은 모양의 가지를 OR 로 덧붙인다.
 *
 * lib/db/operations-schema.ts 가 "(앞 술어) OR (이 값)" 으로 맨 끝에 합치고, drizzle/0158_release_branch_kinds.sql 은
 * scripts/ops/generate-release-branch-kinds-sql.ts 가 같은 값을 $ai2_local$ 로 감싸 만든다. 손으로 고치지 않는다.
 * 사람 검토(operator_review, 0151)·게이트웨이 로컬 종료(local_call_ended, 0099)는 이 PR 의 범위가 아니다.
 */

/** 0096 회수 가지가 받는 종료 근거 kind. */
export const dispatchReleaseEvidenceKindsSql = "('process_group_exit','dr_call_drain')";
/** 0158 이 회수 길에 더하는 dispatch kind. */
export const dispatchReleaseAddedKindsSql = "('publication_classify_cli','local_model_direct')";

/** model_capacity_requests_dispatch_check 가지 — 0096 회수 가지에서 kind 목록만 바꾼 것. */
export const releaseKindsDispatchSql = `coalesce(((state='withdrawn' AND dispatch_binding IS NOT NULL AND dispatch_binding_hash IS NOT NULL AND dispatched_at IS NOT NULL) AND (dispatch_binding_hash ~ '^[a-f0-9]{64}$') AND (logical_work_key IS NOT NULL) AND (jsonb_typeof(dispatch_binding)='object') AND (dispatch_binding->'version'='1'::jsonb) AND (dispatch_binding->>'kind' IN ${dispatchReleaseAddedKindsSql}) AND (dispatch_binding->>'logicalWorkKey'=logical_work_key) AND (dispatch_binding->>'model'=model) AND (terminal_evidence IS NOT NULL) AND (terminal_evidence->>'kind' IN ${dispatchReleaseEvidenceKindsSql})),false)`;

/**
 * model_capacity_requests_logical_check·members_check 가지 — 0125 publicationClassifyLogicalSql 의 정체 조건에 withdrawn+종료 근거를 더한 것
 * (0096 이 intro_check_cli 등 CLI 묶음 kind 에 둔 withdrawn 가지와 같은 꼴). local_model_direct 의 logical 가지는 terminal 을 보지 않고
 * member key 가 없어 두 CHECK 를 이미 통과한다.
 */
export const publicationClassifyReleaseLogicalSql = `coalesce(((class='background' AND pool='reviewer' AND route_id='crawl-publish-classify' AND provider IN ('claude-cli','codex-cli')) AND nmv_publication_classify_keys_valid(logical_member_keys) AND (logical_work_key='bg:publication-classify:' || encode(sha256(convert_to(array_to_json(logical_member_keys)::text,'UTF8')),'hex')) AND (dispatch_binding->>'kind'='publication_classify_cli') AND (state='withdrawn' AND terminal_evidence->>'kind' IN ${dispatchReleaseEvidenceKindsSql})),false)`;
