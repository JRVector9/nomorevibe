/**
 * PR13c 고정 사례 — 시각은 '지금으로부터 몇 분 전'. 측정 도구 pure report(단위)와 실제 PostgreSQL(통합)이 같은 사례·기대값을 쓴다.
 * 운영처럼 id 가 시작·생성 시각 순서를 따르도록 배열 순서대로 넣는다. 모든 행은 24시간+1시간 스캔 여유 안에 둔다.
 */
export type Ai1Case = { key: string; candidate: string; kind: 'automatic' | 'admin_override';
  state: 'running' | 'succeeded' | 'failed' | 'superseded'; provider: string; reused: boolean; errorCode: string | null;
  decision: 'approve' | 'reject' | 'needs_review' | null; startedAgo: number; completedAgo: number | null; retryAfterAgo?: number };
const ai1 = (key: string, candidate: string, state: Ai1Case['state'], startedAgo: number, completedAgo: number | null,
  extra: Partial<Ai1Case> = {}): Ai1Case => ({ key, candidate, kind: 'automatic', state, provider: 'abcllm', reused: false, errorCode: null,
  decision: state === 'succeeded' ? 'approve' : null, startedAgo, completedAgo, ...extra });
export const AI1_CASES: Ai1Case[] = [
  ai1('old-success', 'c10', 'succeeded', 1476, 1475),
  ai1('margin-call', 'c11', 'succeeded', 1450, 1430),
  ai1('reject-3h', 'c2', 'succeeded', 181, 180, { decision: 'reject' }),
  ai1('re-review', 'c10', 'succeeded', 121, 120),
  ai1('superseded', 'c8', 'superseded', 52, 50, { errorCode: 'owner_changed' }),
  ai1('deferred', 'c5b', 'failed', 41, 40, { errorCode: 'deferred' }),
  ai1('cancelled', 'c5', 'failed', 31, 30, { errorCode: 'cancelled' }),
  ai1('rules', 'c6', 'succeeded', 26, 25, { provider: 'rules', decision: 'reject' }),
  ai1('handoff', 'c3', 'succeeded', 21, 20, { decision: 'needs_review' }),
  ai1('timeout', 'c4', 'failed', 16, 15, { errorCode: 'timeout', retryAfterAgo: -15 }),
  ai1('reused', 'c7', 'succeeded', 13, 12, { reused: true }),
  ai1('first-c1', 'c1', 'succeeded', 11, 10),
  ai1('admin', 'c12', 'succeeded', 9, 8, { kind: 'admin_override', provider: 'admin' }),
  ai1('c13-fail', 'c13', 'failed', 8, 7, { errorCode: 'timeout', retryAfterAgo: -20 }),
  ai1('repeat-c1', 'c1', 'succeeded', 6, 5),
  ai1('c13-ok', 'c13', 'succeeded', 4, 2, { decision: 'reject' }),
  ai1('running', 'c9', 'running', 3, null),
];
/** SQL 원시 집계 기대값(ai1.windows) */
export const AI1_EXPECTED = {
  '1h': { calls: 6, failed: 2, cancelled: 2, rules: 1, reuse: 1, superseded: 1, succeeded: 4, handoff: 1, unique: 3, uniqueNew: 3 },
  '24h': { calls: 9, failed: 2, cancelled: 2, rules: 1, reuse: 1, superseded: 1, succeeded: 7, handoff: 1, unique: 6, uniqueNew: 5 },
} as const;
/** 재시도 유예 중인 마지막 실패가 남은 후보(c4). c13 은 뒤에 새 시도가 있어 빠진다 */
export const AI1_BACKOFF = 1;

export type Ai2Case = { key: string; candidate: string; fallbackOf?: string; createdAgo: number; status: 'pending' | 'agreed' | 'needs_human' | 'failed';
  failureCount: number; reviewedAgo: number | null; decision: 'approve' | 'reject' | null; errorCode?: string };
export const AI2_CASES: Ai2Case[] = [
  { key: 'D0', candidate: 'd', createdAgo: 1470, status: 'failed', failureCount: 1, reviewedAgo: 1465, decision: null, errorCode: 'timeout' },
  { key: 'E0', candidate: 'e', createdAgo: 120, status: 'needs_human', failureCount: 2, reviewedAgo: 90, decision: 'reject' },
  { key: 'G0', candidate: 'g', createdAgo: 110, status: 'failed', failureCount: 1, reviewedAgo: 100, decision: null, errorCode: 'timeout' },
  { key: 'C0', candidate: 'c', createdAgo: 100, status: 'pending', failureCount: 0, reviewedAgo: null, decision: null },
  { key: 'B0', candidate: 'b', createdAgo: 40, status: 'failed', failureCount: 1, reviewedAgo: 35, decision: null, errorCode: 'timeout' },
  { key: 'G1', candidate: 'g', fallbackOf: 'G0', createdAgo: 30, status: 'agreed', failureCount: 0, reviewedAgo: 25, decision: 'approve' },
  { key: 'A0', candidate: 'a', createdAgo: 29, status: 'agreed', failureCount: 0, reviewedAgo: 25, decision: 'approve' },
  { key: 'B1', candidate: 'b', fallbackOf: 'B0', createdAgo: 28, status: 'agreed', failureCount: 0, reviewedAgo: 20, decision: 'approve' },
  { key: 'D1', candidate: 'd', fallbackOf: 'D0', createdAgo: 20, status: 'agreed', failureCount: 0, reviewedAgo: 15, decision: 'approve' },
  { key: 'H0', candidate: 'h', createdAgo: 10, status: 'pending', failureCount: 0, reviewedAgo: null, decision: null },
];
/** collectLiveCapacityWindow 의 ai2Calls 경계: 창 안에서 만든 사슬만 확정(G·D 는 창 밖 시작 → 미귀속) */
export const AI2_EXPECTED = {
  '1h': { chains: 3, calls: 3, failed: 1, votes: 2, votedCandidates: 2, unattributed: 2 },
  '24h': { chains: 6, calls: 8, failed: 4, votes: 4, votedCandidates: 4, unattributed: 1 },
} as const;
export const AI2_NOW = { ready: 2, backoff: 3, human: 1, humanCandidates: 1 } as const;
