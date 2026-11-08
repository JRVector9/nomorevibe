/**
 * 「LLM 운영」 화면 사이 주소 — 의존 없는 작은 모듈이라 클라이언트 구성 요소(LiveModels 등)도 가져다 쓴다.
 * 결과 미확정 행을 다시 대기열에 넣거나 닫는 곳은 기록 › 재실행 대기 한 곳이다(2026-11-07 승인 시안 PR 3).
 */
export const LLM_RETRY_HREF = "/admin/models/history#retry";
export const llmRetryRowHref = (requestId: string) => `/admin/models/history#rv-${requestId}`;
export const LLM_FAILURES_HREF = "/admin/models/history#failures";
/** 모델 연결(계약) — 닫힌·맞지 않는 계약을 보고 다시 저장하거나 끄는 곳 */
export const LLM_CONTRACTS_HREF = "/admin/models/contracts";

/**
 * LLM 운영 연결 폼에서 바로 고칠 칸(?fix=). 그 칸으로 내려가 초점을 두고 눈에 띄게 한다.
 * limit = 동시 실행 한도 · key = API 키 · address = 주소(저장하면 모델 목록도 다시 읽는다) · version = CLI 버전 · enabled = 켜짐/꺼짐.
 */
export const LLM_FIX_FIELDS = ["limit", "key", "address", "version", "enabled"] as const;
export type LlmFixField = typeof LLM_FIX_FIELDS[number];
export const llmFixField = (value: string | null | undefined): LlmFixField | null =>
  (LLM_FIX_FIELDS as readonly string[]).includes(value ?? "") ? value as LlmFixField : null;
/** 연결 폼 칸의 id — 주소의 #조각과 화면이 같은 값을 쓴다. */
export const llmFieldAnchor = (connectionId: string, field: LlmFixField) => `conn-${connectionId}-${field}`;
/** 연결 행을 펼친 주소. 칸을 주면 그 칸으로 간다(없으면 행 머리). */
export const llmEditHref = (connectionId: string, field: LlmFixField | null = null) =>
  `/admin/models/llm?edit=${connectionId}${field ? `&fix=${field}#${llmFieldAnchor(connectionId, field)}` : `#conn-${connectionId}`}`;

/**
 * 칸 배분(step 3) — 장비 칸을 작업 영역(경로)마다 보장·상한으로 나누는 화면. 장비를 주면 그 열 머리(#alloc-<장비>)로 간다.
 * 앵커는 글자·숫자·_·- 만 남긴다(장비 id 의 다른 글자는 _) — 화면의 열 머리가 같은 함수로 id 를 단다.
 */
export const LLM_ALLOCATION_HREF = "/admin/models/allocation";
export const llmAllocationAnchor = (deviceId: string) => `alloc-${deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
export const llmAllocationHref = (deviceId: string | null = null) => deviceId ? `${LLM_ALLOCATION_HREF}#${llmAllocationAnchor(deviceId)}` : `${LLM_ALLOCATION_HREF}#allocation`;
