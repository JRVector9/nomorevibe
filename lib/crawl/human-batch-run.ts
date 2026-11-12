import { createHash, randomInt } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates } from "@/lib/db/schema";
import { recordAdminActions, type AdminLogEntry } from "@/lib/operations/admin-log";
import type { CrawlSettings } from "./settings-schema";
import { getSettings } from "./settings";
import { listAdminReviewEntries, overrideCandidate, undoAdminDecision } from "./admin-review";
import { humanQueueOverview } from "./review-overview";
import { REVIEW_REJECT_REASONS } from "./review";
import { checkDelegatedRepository, type DelegatedRepoCheck } from "./delegated-repo-check";
import { claimHumanBatchRun, claimHumanBatchUndo, insertHumanBatchGate, latestHumanBatchGates, markHumanBatchVerdict, readHumanBatchGate,
  saveHumanBatchResult, saveHumanBatchUndo } from "./human-batch-store";
import { HUMAN_BATCH_GUIDE, HUMAN_BATCH_MAX, HUMAN_BATCH_SAMPLE_SIZE, humanBatchGateView, humanBatchMembers, pickSample,
  type HumanBatchKey, type HumanBatchMember, type HumanBatchResult, type HumanBatchVerdict } from "./human-batch-model";

/**
 * 사람 확인 묶음의 쓰기 순서(운영 콘솔 개편 조각 3b) — 표본 뽑기 · 표본 판정 · 일괄 결정 · 묶음째 되돌리기.
 *
 * 사람이 판단할 것을 대신 정하지 않는다: 일괄 결정은 운영자가 표본 전부를 「맞음」으로 본 관문(humanBatchGateView.open)에서만 돈다.
 * 결정은 기존 건별 경로 그대로다 — 후보마다 overrideCandidate(입력·원본·후보 해시가 표본을 뽑을 때와 같아야 한다, admin_override 기록)를 부르고,
 * 작업 로그에는 심사 큐의 일괄 결정(decideCrawlCandidates)과 같은 줄(candidate-approve·candidate-reject)에 묶음 id(batchId)를 더해 남긴다.
 * 되돌리기도 건별 undoAdminDecision 을 묶음째 부른다. 이 순서들이 새로 만든 쓰기(관문 줄)는 모두 작업 로그(human-batch-*)를 남긴다.
 */

export type HumanBatchActionResult = { ok: true; message: string } | { ok: false; message: string };

/** 저장소가 없어짐 보류 — 사유 그대로(보류 묶음 표의 수와 같은 조건) */
export async function readRepoDeletedIds(): Promise<number[]> {
  const rows = await db.select({ id: crawlCandidates.id }).from(crawlCandidates)
    .where(and(eq(crawlCandidates.state, "needs_review"), eq(crawlCandidates.reason, "repo_deleted"))).orderBy(asc(crawlCandidates.id));
  return rows.map(row => row.id);
}

/** 지금 묶음별 후보 id — 주 DB 에서 새로 센다(심사 큐와 같은 사람 몫 집계 humanQueueOverview, 결정한 뒤 바로 맞게) */
export async function readHumanBatchMembers(settings: CrawlSettings): Promise<Record<HumanBatchKey, number[]>> {
  const [overview, repoDeleted] = await Promise.all([humanQueueOverview(settings), readRepoDeletedIds()]);
  return humanBatchMembers(overview, repoDeleted);
}

/**
 * 대상을 고정한다 — 앞에서부터 HUMAN_BATCH_MAX 건(심사 큐 일괄 상한과 같다)을 심사 목록과 같은 읽기(listAdminReviewEntries)로 읽어
 * 결정이 기댈 판(입력·원본·후보 해시)을 붙인다. 판을 읽지 못한 후보(원본 없음 등)는 넣지 않는다 — overrideCandidate 가 받지 않는다.
 */
export async function pinHumanBatchMembers(settings: CrawlSettings, ids: readonly number[]): Promise<HumanBatchMember[]> {
  const chosen = [...new Set(ids)].sort((a, b) => a - b).slice(0, HUMAN_BATCH_MAX);
  if (!chosen.length) return [];
  const { entries } = await listAdminReviewEntries(settings, { state: "needs_review", ids: chosen, limit: HUMAN_BATCH_MAX });
  return entries.flatMap(entry => entry.inputHash && entry.sourceRevisionHash ? [{ id: entry.candidate.id, repo: entry.candidate.repo,
    inputHash: entry.inputHash, sourceRevisionHash: entry.sourceRevisionHash, candidateRevisionHash: entry.candidateRevisionHash }] : [])
    .sort((a, b) => a.id - b.id);
}

/** 스냅숏 해시 — 고정한 대상(후보 id·후보 판). 같은 묶음이 바뀌었는지 기록에서 견줄 때 쓴다 */
export function humanBatchSnapshotHash(members: readonly HumanBatchMember[]): string {
  return createHash("sha256").update(JSON.stringify([...members].sort((a, b) => a.id - b.id).map(member => [member.id, member.candidateRevisionHash]))).digest("hex");
}

const count = (value: number) => value.toLocaleString("ko-KR");

/**
 * 표본을 뽑는다 — 지금 묶음에서 대상을 고정하고 무작위 HUMAN_BATCH_SAMPLE_SIZE 건을 표본으로 둔다.
 * 앞선 표본에서 「아님」을 받은 후보(와 그 앞에서 뺀 것)는 이번 묶음에도 넣지 않는다 — 그 건은 하나씩 본다.
 */
export async function startHumanBatchSample(actor: string, key: HumanBatchKey): Promise<HumanBatchActionResult & { gateId?: number }> {
  const settings = await getSettings();
  const [members, previous] = await Promise.all([readHumanBatchMembers(settings).then(all => all[key]), latestHumanBatchGates(actor).then(all => all[key])]);
  const present = new Set(members);
  const carried = previous ? [...new Set([...previous.excluded, ...previous.sampleIds.filter(id => previous.verdicts[String(id)] === "wrong")])]
    .filter(id => present.has(id)).sort((a, b) => a - b) : [];
  const skip = new Set(carried);
  const pool = members.filter(id => !skip.has(id));
  if (!pool.length) return { ok: false, message: members.length ? "남은 후보가 모두 앞선 표본에서 「아님」으로 빠졌습니다. 하나씩 보기에서 처리해주세요."
    : "이 묶음에 지금 후보가 없습니다." };
  const pinned = await pinHumanBatchMembers(settings, pool);
  if (!pinned.length) return { ok: false, message: "후보의 심사 판을 읽지 못했습니다. 새로고침해 다시 해주세요." };
  const sampleIds = pickSample(pinned.map(member => member.id), HUMAN_BATCH_SAMPLE_SIZE, randomInt);
  const snapshotHash = humanBatchSnapshotHash(pinned);
  const gate = await insertHumanBatchGate({ key, actor, members: pinned, snapshotHash, sampleIds, excluded: carried });
  await recordAdminActions(actor, [{ action: "human-batch-sample", target: `batch:${gate.id}`,
    detail: { key, members: pinned.length, waiting: members.length, excluded: carried.length, sampleIds, snapshotHash } }]);
  return { ok: true, gateId: gate.id, message: `표본 ${count(sampleIds.length)}건을 뽑았습니다 — 대상 ${count(pinned.length)}건${pool.length > pinned.length
    ? `(남은 ${count(pool.length)}건 중 앞의 ${count(pinned.length)}건)` : ""}.` };
}

/** 표본 하나에 「맞음/아님」 — 실행 전에는 고칠 수 있다 */
export async function markHumanBatchSample(actor: string, gateId: number, candidateId: number, verdict: HumanBatchVerdict): Promise<HumanBatchActionResult> {
  const changed = await markHumanBatchVerdict({ id: gateId, actor, candidateId, verdict });
  await recordAdminActions(actor, [{ action: "human-batch-mark", target: `batch:${gateId}`, detail: { candidateId, verdict },
    ok: changed, error: changed ? null : "이미 실행했거나 표본이 아닌 후보" }]);
  return changed ? { ok: true, message: verdict === "ok" ? "맞음으로 표시했습니다." : "아님으로 표시했습니다 — 이 묶음은 한 번에 끝내지 않습니다." }
    : { ok: false, message: "이미 실행한 묶음이거나 표본이 아닌 후보입니다. 새로고침해주세요." };
}

const REPO_CHECK_WHY: Record<Exclude<DelegatedRepoCheck, "gone">, string> = {
  present: "저장소가 살아 있음 — 거절하지 않음",
  changed: "저장소 이름이 바뀌었거나 보관·비공개로 바뀜 — 하나씩 보기",
  deferred: "GitHub 확인을 못 함(한도·자격·연결) — 다시 시도",
};
/** 실행 직전 저장소 확인 — 사람 몫 위임 검수의 발행 전 확인(checkDelegatedRepository)을 그대로 쓴다. 실패는 모르는 것(deferred) */
async function repoCheck(repo: string): Promise<DelegatedRepoCheck> {
  try { return (await checkDelegatedRepository(repo, AbortSignal.timeout(10_000))).check; }
  catch { return "deferred"; }
}
/** 다섯 개씩 나란히 묻는다 — 30건이 한 줄로 서면 화면이 오래 기다린다 */
async function repoChecks(repos: readonly string[]): Promise<Map<string, DelegatedRepoCheck>> {
  const out = new Map<string, DelegatedRepoCheck>();
  for (let index = 0; index < repos.length; index += 5) {
    const chunk = repos.slice(index, index + 5);
    const checks = await Promise.all(chunk.map(repoCheck));
    chunk.forEach((repo, position) => out.set(repo, checks[position]));
  }
  return out;
}

/**
 * 일괄 결정 — 관문이 열렸을 때만(표본 전부 맞음). 대상은 표본을 뽑을 때 고정한 것 중 지금도 묶음에 있는 것이다(새로 들어온 건은 넣지 않는다).
 * 실행은 한 번만 잡는다. 결과(결정 기록 id)는 관문 줄에 남겨 묶음째 되돌리기가 쓴다. 도중에 멈춰도 그때까지의 결과와 작업 로그를 남긴다.
 */
export async function runHumanBatch(actor: string, gateId: number, input: { reason?: string; note?: string }): Promise<HumanBatchActionResult & { result?: HumanBatchResult }> {
  const gate = await readHumanBatchGate(gateId);
  if (!gate || gate.actor !== actor) return { ok: false, message: "표본을 찾지 못했습니다. 새로고침해주세요." };
  if (gate.executedAt) return { ok: false, message: "이미 실행한 묶음입니다." };
  const guide = HUMAN_BATCH_GUIDE[gate.batchKey];
  const reason = guide.decision === "reject" ? String(input.reason ?? "") : "";
  const reasonCode = guide.decision === "approve" ? "passed" as const : REVIEW_REJECT_REASONS.find(row => row.value === reason)?.value;
  if (!reasonCode) return { ok: false, message: "거절 사유를 골라주세요." };
  const note = String(input.note ?? "").trim().slice(0, 2000) || guide.note;

  const settings = await getSettings();
  const current = (await readHumanBatchMembers(settings))[gate.batchKey];
  const view = humanBatchGateView(gate, current);
  if (!view.open) return { ok: false, message: view.pendingIds.length ? "표본을 모두 보지 않았습니다." : view.wrongIds.length
    ? "「아님」인 표본이 있어 한 번에 끝낼 수 없습니다." : "지금 결정할 대상이 없습니다. 새로고침해주세요." };
  const claimed = await claimHumanBatchRun({ id: gate.id, actor, decision: guide.decision });
  if (!claimed) return { ok: false, message: "이미 실행한 묶음입니다." };

  const byId = new Map(gate.members.map(member => [member.id, member]));
  const targets = view.targets.flatMap(id => byId.get(id) ?? []);
  const result: HumanBatchResult = { decision: guide.decision, reason: reasonCode, note, decided: [], failures: [], skipped: [],
    excludedNew: view.added, excludedGone: view.gone };
  const entries: AdminLogEntry[] = [];
  try {
    const checks = guide.repoCheck ? await repoChecks(targets.map(member => member.repo)) : null;
    for (const member of targets) {
      const check = checks?.get(member.repo);
      if (check && check !== "gone") { result.skipped.push({ id: member.id, repo: member.repo, why: REPO_CHECK_WHY[check] }); continue; }
      const outcome = await overrideCandidate({ repo: member.repo, actor, decision: guide.decision, reasonCode, reason: note,
        inputHash: member.inputHash, sourceRevisionHash: member.sourceRevisionHash, candidateRevisionHash: member.candidateRevisionHash });
      if (outcome.ok) result.decided.push({ id: member.id, repo: member.repo, attemptId: outcome.attemptId });
      else result.failures.push({ id: member.id, repo: member.repo, message: outcome.message });
      entries.push({ action: `candidate-${guide.decision}`, target: member.repo,
        detail: { reason, note, bulk: targets.length, batchId: gate.id, ...(outcome.ok ? { attemptId: outcome.attemptId } : {}) },
        ok: outcome.ok, error: outcome.ok ? null : outcome.message });
    }
  } finally {
    await saveHumanBatchResult(gate.id, result);
    entries.push({ action: "human-batch-run", target: `batch:${gate.id}`,
      detail: { key: gate.batchKey, decision: guide.decision, reason, note, decided: result.decided.length, failed: result.failures.length,
        skipped: result.skipped.map(row => `${row.repo}: ${row.why}`), excludedNew: view.added, excludedGone: view.gone,
        sample: { size: view.sampleSize, ok: view.ok }, snapshotHash: gate.snapshotHash },
      ok: result.failures.length === 0 || result.decided.length > 0,
      error: result.decided.length === 0 && result.failures.length ? result.failures[0].message : null });
    await recordAdminActions(actor, entries);
  }
  return { ok: true, result, message: `${guide.verb} ${count(result.decided.length)}건${result.failures.length ? ` · 실패 ${count(result.failures.length)}건` : ""}${
    result.skipped.length ? ` · 남김 ${count(result.skipped.length)}건` : ""}` };
}

/** 묶음째 되돌리기 — 결정한 건마다 기존 되돌리기(undoAdminDecision, 결정 뒤 아무 일도 없을 때만)를 부른다. 한 번만 잡는다 */
export async function undoHumanBatch(actor: string, gateId: number): Promise<HumanBatchActionResult> {
  const gate = await claimHumanBatchUndo({ id: gateId, actor });
  if (!gate?.result) return { ok: false, message: "되돌릴 수 있는 묶음이 아닙니다(실행 전이거나 이미 되돌림). 새로고침해주세요." };
  let restored = 0;
  const failures: { id: number; repo: string; attemptId: number; message: string }[] = [];
  try {
    for (const decided of gate.result.decided) {
      const outcome = await undoAdminDecision({ repo: decided.repo, attemptId: decided.attemptId, actor });
      if (outcome.ok) restored++;
      else failures.push({ ...decided, message: outcome.message });
    }
  } finally {
    await saveHumanBatchUndo(gate.id, { restored, failures: failures.map(({ id, repo, message }) => ({ id, repo, message })) });
    // 되돌린 건은 undoAdminDecision 이 같은 트랜잭션에서 candidate-undo 줄을 남긴다. 못 한 것과 묶음 요약만 여기서
    await recordAdminActions(actor, [
      ...failures.map(failure => ({ action: "candidate-undo", target: failure.repo, detail: { attemptId: failure.attemptId, batchId: gate.id },
        ok: false, error: failure.message })),
      { action: "human-batch-undo", target: `batch:${gate.id}`, detail: { key: gate.batchKey, restored, failed: failures.length },
        ok: failures.length === 0 || restored > 0, error: restored === 0 && failures.length ? failures[0].message : null },
    ]);
  }
  if (!failures.length) return { ok: true, message: `${count(restored)}건을 결정 앞 상태로 되돌렸습니다.` };
  return { ok: restored > 0, message: `${count(failures.length)}건은 되돌리지 못했습니다(${count(restored)}건은 되돌림) — ${failures[0].repo}: ${failures[0].message}` };
}
