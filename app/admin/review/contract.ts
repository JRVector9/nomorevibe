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

/**
 * 일괄 처리에 실을 후보 하나.
 *
 * 검사는 한 건씩 그대로 받으므로 후보마다 입력·원본·후보 해시를 함께 실어야 한다.
 * 만드는 쪽과 읽는 쪽이 갈라지면 모든 건이 "화면이 오래됐습니다"로 거절되므로
 * 한 곳에서 만들고 한 곳에서 읽는다.
 *
 * 구분자는 공백이다 — 레포 이름은 [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+ 이고 해시는 16진수라
 * 공백이 들어갈 수 없다. NUL 은 폼 인코딩을 타면서 사라질 수 있다.
 */
const SEPARATOR = " ";
export function packSelection(parts: {
  repo: string; inputHash: string | null; sourceRevisionHash: string | null; candidateRevisionHash: string;
}): string {
  return [parts.repo, parts.inputHash ?? "", parts.sourceRevisionHash ?? "", parts.candidateRevisionHash].join(SEPARATOR);
}
export function parseSelection(value: string): {
  repo: string; inputHash: string; sourceRevisionHash: string; candidateRevisionHash: string;
} | null {
  const [repo, inputHash, sourceRevisionHash, candidateRevisionHash] = value.split(SEPARATOR);
  if (!repo || !inputHash || !sourceRevisionHash || !candidateRevisionHash) return null;
  return { repo, inputHash, sourceRevisionHash, candidateRevisionHash };
}
