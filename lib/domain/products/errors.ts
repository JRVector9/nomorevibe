/** 유스케이스 결과 — HTTP를 모르는 도메인 수준의 실패 사유 */
export type DomainError =
  | { kind: "invalid"; message: string }
  | { kind: "unreachable"; message: string }
  | { kind: "duplicate"; slug?: string; status?: string }
  | { kind: "not_found" }
  | { kind: "forbidden"; message: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "verification_failed"; expected: unknown };

export type Result<T> = { ok: true; value: T } | { ok: false; error: DomainError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: DomainError): Result<T> => ({ ok: false, error });
