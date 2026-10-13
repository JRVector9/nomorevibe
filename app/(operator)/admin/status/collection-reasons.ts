/**
 * 운영센터 머리의 수집 켜기·끄기 사유(ADM-18) — 확인 창의 선택지이자 서버가 받는 값. 작업 로그에 이 값이 남는다.
 */
export const COLLECTION_OFF_REASONS = [
  { value: "incident", label: "장애 대응 — 수집이 문제를 키움" },
  { value: "quality", label: "수집·판정 품질 문제" },
  { value: "quota", label: "GitHub 한도·차단" },
  { value: "maintenance", label: "점검·배포" },
  { value: "other", label: "기타(메모에 적음)" },
] as const;

export const COLLECTION_ON_REASONS = [
  { value: "resolved", label: "문제 해결 — 다시 수집" },
  { value: "maintenance-done", label: "점검·배포 끝남" },
  { value: "other", label: "기타(메모에 적음)" },
] as const;
