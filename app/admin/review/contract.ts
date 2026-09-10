/**
 * 심사 화면과 서버 액션이 함께 쓰는 값.
 *
 * "use server" 모듈은 async 함수만 내보낼 수 있어 상수를 그 안에 둘 수 없다.
 * 그렇다고 화면에 따로 적으면 상한이 두 곳에 생긴다.
 */

/** 한 번에 처리할 최대 건수. 실수로 큐 전체를 뒤집는 것을 막는다 */
export const MAX_BULK_DECISIONS = 50;

export type BulkReviewState =
  | { error?: string; ok?: number; failures?: { repo: string; message: string }[] }
  | null;

export type RequeueState =
  | { error?: string; ok?: number; scanned?: number; byReason?: { reason: string; count: number }[] }
  | null;
