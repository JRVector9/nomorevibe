/**
 * 계약 읽기 세대 표지(2026-11-21 abcllm 이름표 정리 2단계) — 이 판 이상의 코드는 서비스 관측(observeService)마다 이 값을 싣는다.
 *
 * 세대 1 = 엔진 직접 총량 상한 계약(openai-chat-total-bound-v1, provider local-direct)을 읽고 부르는 판(1단계 #1012 와 그 뒤의 2단계).
 * 표지가 없는 관측(1단계보다 옛 판, 또는 표지를 싣기 전 판)은 새 모양 계약을 「계약 없음」으로 읽을 수 있다고 본다 — 새 모양 저장·전환은
 * 그런 프로세스가 하나라도 보이면 닫힌다(lib/operations/contract-reader-gate.ts).
 *
 * 다음 세대(예: 새 모양의 wire 를 또 바꾸는 판)가 옛 세대 프로세스와 함께 돌면 안 될 때만 이 값을 올리고 CONTRACT_READER_REQUIRED 도 함께 올린다.
 * 이 파일은 아무것도 import 하지 않는다(관측 쓰기·관리 화면·운영 스크립트가 함께 읽는다).
 */
export const CONTRACT_READER_FIELD = "contractReader";
export const CONTRACT_READER_GENERATION = 1;
/** 새 모양 저장·전환이 모든 프로세스에 요구하는 세대 */
export const CONTRACT_READER_REQUIRED = 1;
