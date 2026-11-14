import { sql, type SQL } from "drizzle-orm";
import { agentCoverageRevisionSql } from "@/lib/domain/evidence/agents/coverage";
import { agentLimitedSettledSql } from "@/lib/domain/evidence/agents/refresh-policy";
import { reviewHash, type ReviewInput, type ReviewSnapshot, type ReviewSource } from "./agent-review-contract";

/**
 * 1차 심사는 AI 제작 근거 스캔(agent_repository_scans)이 자리 잡은 뒤에 돈다 — 2026-11-14 실측(운영 읽기 전용).
 *
 * 30시간 동안 1차 모델 호출 12,347건 중 3,225건(26%)이 스캔이 아직 없을 때(scanState pending) 먼저 심사하고, 스캔이 complete 된 뒤
 * 원본(README·메타·판정 시각)이 그대로인 채 같은 후보를 처음부터 다시 심사했다. 이른 승인은 발행에도 못 쓴다 — 발행 관문(publication-guard.ts
 * guardPublication)은 complete 스캔과 그 입력의 승인만 받는다.
 *
 * 그 3,097개 원본에서 원본 수집 뒤 스캔 완료까지: p50 78분 · p90 159분 · p95 206분 · p99 470분, 2시간 안 76% · 4시간 안 96.9% ·
 * 6시간 안 98.4% · 8시간 안 99.2%. 상한 6시간은 이른 심사의 98%를 없애면서, 스캔이 끝내 안 끝나는 후보(같은 기간 177건)가 원본을 본 뒤
 * 최대 6시간만 기다리게 한다. 상한이 지나면 근거가 모자란 채로 그대로 심사한다(예전과 같다) — 1차가 굶지 않는다.
 */
export const FIRST_REVIEW_EVIDENCE_WAIT_MS = 6 * 3600_000;

/**
 * 「근거가 자리 잡았다」 — 지금 가장 최근 스캔(LATERAL 별칭 scan)으로 지은 입력이 더 기다려도 바뀌지 않을 상태다.
 *  - complete: 오류 없음·완료 시각 있음·지금 탐지기 버전·남은 범위 없음(effectiveAgentScanState 가 complete)
 *  - 범위 제한으로 끝난 partial(agentLimitedSettledSql): 같은 머리 커밋이면 다시 돌려도 complete 가 되지 못한다
 *  - failed: 그 스캔은 근거를 더 내지 않는다(재시도 간격이 15분~7일로 늘어난다)
 * 스캔 행이 아예 없거나, partial 이 이어 볼 범위(pendingTrees·Blobs·Commits)를 남겼거나, 옛 탐지기 버전이면 아직이다.
 */
export function firstReviewEvidenceSettledSql(scan: SQL, detectorVersion: string): SQL {
  return sql`(${scan}.id IS NOT NULL AND ((${scan}.state = 'complete' AND ${scan}.last_error_code IS NULL
      AND ${scan}.completed_at IS NOT NULL AND ${scan}.detector_version = ${detectorVersion}
      AND ${agentCoverageRevisionSql(sql`${scan}.coverage`, sql`${scan}.cursor`)} = '{}'::jsonb)
    OR ${agentLimitedSettledSql(scan)} OR ${scan}.state = 'failed'))`;
}

/**
 * 1차 대기열의 「아직 근거를 기다린다」 — 이 조건이 참인 후보는 준비된 1차 대상(readyOnly)에서 잠시 빠진다.
 *
 * 스캔 대기열(agent_repository_claims, state active)에 오른 저장소만 기다린다: 스캔할 주체가 없으면 기다려도 근거가 오지 않는다.
 * 운영(agent_scan_control items)에서는 이른 심사 후보 1,532건이 모두 이 대기열에 있었다(2026-11-14 실측).
 * 기다림은 그 원본을 본 시각 — 판정 시각(judged_at, 원본이 바뀌어 다시 판정할 때만 새로 적힌다)과 지금 원본의 수집 시각 중 늦은 것 — 에서
 * FIRST_REVIEW_EVIDENCE_WAIT_MS 까지다. 원본 수집은 하루 한 번 이상이고 입력 유효기간(24시간)이 이보다 길어, 상한이 지난 뒤 늘 심사할 수 있다.
 */
export function firstReviewEvidenceWaitingSql(input: {
  repo: SQL; judgedAt: SQL; fetchedAt: SQL; scan: SQL; detectorVersion: string; now: SQL;
}): SQL {
  return sql`(EXISTS (SELECT 1 FROM agent_repository_claims evidence_claim
      WHERE evidence_claim.repository_key = lower(${input.repo}) AND evidence_claim.state = 'active')
    AND NOT ${firstReviewEvidenceSettledSql(input.scan, input.detectorVersion)}
    AND greatest(coalesce(${input.judgedAt}, '-infinity'::timestamp), ${input.fetchedAt})
      > ${input.now} - (${FIRST_REVIEW_EVIDENCE_WAIT_MS / 1000} * interval '1 second'))`;
}

const SCAN_RANK: Record<string, number> = { pending: 0, partial: 1, complete: 2 };

/** 스캔 결과에서 나온 칸 — 이것만 다르면 「근거만 늘었다」의 후보다 */
function withoutScanResult(snapshot: ReviewSnapshot): Partial<ReviewSnapshot> {
  return { ...snapshot, evidence: undefined, evidenceSummary: undefined, scanState: undefined, evidenceTruncated: undefined };
}

/**
 * 「근거만 늘었다」 — 이미 승인한 1차 시도의 입력(previous)과 지금 입력(current)이 AI 제작 근거 스캔 결과에서만 다르고, 그 근거는 줄지 않고 늘기만 했다.
 *
 * 모두 참이어야 한다:
 *  1. 원본이 같다 — 판정 시각(candidateJudgedAt)·제품 주소가 같고, 스냅숏에서 스캔 결과 칸(evidence·evidenceSummary·scanState·evidenceTruncated)을
 *     뺀 나머지(제품 본문·README·설명·토픽·저장소 메타(스타·푸시·생성일)·규칙 멈춤·정책·관계·관리자 재심사 표시)가 한 글자도 다르지 않다.
 *     원본 수집 시각·스캔 id·시각처럼 내용이 아닌 출처 칸은 보지 않는다.
 *  2. 스캔 상태가 뒤로 가지 않았다 — pending < partial < complete. 지금이 failed 이거나 이전이 failed 면 아니다.
 *  3. 이전 근거 관측이 모두 지금 근거에 그대로 있다(관측 내용의 해시로 맞춘다 — 스캔 행이 바뀌어 id 가 달라져도 같은 관측이다).
 *  4. 실제로 늘었다 — 관측 수가 늘었거나 스캔 상태가 앞으로 갔다.
 */
export function evidenceOnlyGrew(previous: { snapshot: ReviewSnapshot; source: ReviewSource }, current: Pick<ReviewInput, "snapshot" | "source">): boolean {
  const before = previous.snapshot, after = current.snapshot;
  if (!before || !after || !Array.isArray(before.evidence) || !Array.isArray(after.evidence)) return false;
  if ((previous.source?.candidateJudgedAt ?? null) !== (current.source.candidateJudgedAt ?? null)
    || (previous.source?.productUrl ?? null) !== (current.source.productUrl ?? null)) return false;
  if (reviewHash(withoutScanResult(before)) !== reviewHash(withoutScanResult(after))) return false;
  const beforeRank = SCAN_RANK[before.scanState], afterRank = SCAN_RANK[after.scanState];
  if (beforeRank === undefined || afterRank === undefined || afterRank < beforeRank) return false;
  const now = new Set(after.evidence.map(item => reviewHash(item.observation)));
  if (!before.evidence.every(item => now.has(reviewHash(item.observation)))) return false;
  return after.evidence.length > before.evidence.length || afterRank > beforeRank;
}
