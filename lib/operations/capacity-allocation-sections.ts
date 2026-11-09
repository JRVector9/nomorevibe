/**
 * 「칸 배분」 줄 갈래(2026-11-09 승인 시안 #alloc) — 화면 모형(capacity-allocation-view)과 클라이언트 배분표(AllocationMatrix)가 함께 쓰는 이름표.
 * 아무것도 import 하지 않는 상수 모듈이다(클라이언트 묶음에 서버 모듈을 끌어오지 않게). 이 순서로 줄을 늘어놓고, 보조 작업은 접힌 한 묶음이다.
 */
export type AllocationSection = "review" | "audit" | "text" | "other" | "helper";
export const ALLOCATION_SECTIONS: readonly Readonly<{ id: AllocationSection; label: string }>[] = Object.freeze([
  { id: "review", label: "검수" }, { id: "audit", label: "분류 · 감사" }, { id: "text", label: "글 · 번역 · 검색" }, { id: "other", label: "기타" }, { id: "helper", label: "보조 작업" }]);
