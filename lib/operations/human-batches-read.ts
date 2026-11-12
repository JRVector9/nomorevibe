import { asc, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import type { HumanQueueOverview } from "@/lib/crawl/human-queue";
import { listAdminReviewEntries, type AdminReviewEntry } from "@/lib/crawl/admin-review";
import { delegateOpinionText } from "@/lib/crawl/delegate-groups";
import { openBacklogStats } from "@/lib/crawl/audit-policy";
import { latestHumanBatchGates, recentHumanBatchRuns, type HumanBatchGate } from "@/lib/crawl/human-batch-store";
import { readRepoDeletedIds } from "@/lib/crawl/human-batch-run";
import { HUMAN_BATCH_KEYS, humanBatchMembers, type HumanBatchKey } from "@/lib/crawl/human-batch-model";
import { logger } from "@/lib/observability/logger";
import { readHoldCounts } from "./conveyor";
import { readHumanDelegateSummary, type HumanDelegateSummary } from "./human-delegate-summary";
import { readHumanAssistProgress, type HumanAssistProgress } from "./human-assist-progress";
import { sharedInbox, type InboxSnapshot } from "./inbox";
import { readDelegateThresholdPreview, type DelegateThresholdPreview } from "./delegate-threshold-preview";
import { readDelegateRejectSamples, type DelegateRejectSamples } from "./delegate-threshold-samples";
import { aiModelNameOfServed, type AiConnectionView } from "./admin-ai-tasks";
import { listAiConnections } from "./admin-ai-tasks-repository";

/**
 * 사람 확인 · 묶음 화면(/admin/review/batches, 운영 콘솔 개편 조각 3b)의 읽기 — 기존 읽기를 모은다. 칸마다 따로 실패한다(그 칸만 「셀 수 없음」).
 * 사람 몫 집계(humanQueueOverview)는 심사 큐처럼 주 DB 에서 새로 센다 — 이 화면은 결정하는 화면이라 결정한 뒤 수와 표본 관문이 바로 맞아야 한다.
 * 쓰지 않는다(쓰기는 lib/crawl/human-batch-run.ts 와 서버 동작).
 */

/** 표본 한 건을 판정하는 데 필요한 것 — 기존 상세(하나씩 보기)의 요약. 클라이언트로 넘기므로 작게 */
export type HumanBatchSampleCard = {
  id: number; repo: string; name: string; productUrl: string | null; intro: string | null;
  /** 지금 후보 상태 — 표본을 뽑은 뒤 다른 곳에서 처리됐으면 needs_review 가 아니다 */
  state: string; reason: string | null;
  first: { decision: string | null; confidence: number | null; reason: string | null } | null;
  seconds: { model: string | null; decision: string | null; reason: string | null }[];
  delegate: { leaning: string; cause: string; confidence: number | null } | null;
  /** 저장소가 없어짐 — 수집·확인이 멈춘 곳 */
  stopped: string | null;
};
export type HumanBatchPreview = { id: number; repo: string; since: string | null };
export type HumanBatchPanel = {
  key: HumanBatchKey;
  /** 지금 묶음 후보 id(주 DB). 못 읽으면 null */
  members: number[] | null;
  preview: HumanBatchPreview[];
  gate: HumanBatchGate | null;
  cards: HumanBatchSampleCard[];
};
export type HumanBatchesRead = {
  measuredAt: string;
  overview: HumanQueueOverview | null;
  holds: { reason: string; count: number; recent24h: number }[] | null;
  delegate: HumanDelegateSummary | null;
  assist: HumanAssistProgress | null;
  inbox: InboxSnapshot | null;
  audit: { open: number; overdue: number; oldestWaitDays: number | null } | null;
  panels: HumanBatchPanel[];
  runs: HumanBatchGate[] | null;
};

const settle = <T>(name: string, promise: Promise<T>): Promise<T | null> => promise.catch((error: unknown) => {
  logger.warn("human_batches.section_unavailable", { section: name, errorName: error instanceof Error ? error.name : "unknown" });
  return null;
});
const clip = (text: string | null | undefined, size: number) => !text ? null : text.length > size ? `${text.slice(0, size - 1)}…` : text;
const iso = sql<string | null>`to_char(coalesce(${crawlCandidates.judgedAt}, ${crawlCandidates.updatedAt}), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** 묶음 미리보기 — 오래 기다린 것부터 다섯(심사 큐 「오래 기다린 순」과 같은 대기 시각) */
async function batchPreview(ids: readonly number[]): Promise<HumanBatchPreview[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, since: iso }).from(crawlCandidates)
    .where(inArray(crawlCandidates.id, [...ids]))
    .orderBy(sql`coalesce(${crawlCandidates.judgedAt}, ${crawlCandidates.updatedAt}) asc nulls last`, asc(crawlCandidates.id)).limit(5);
  return rows.map(row => ({ id: row.id, repo: row.repo, since: row.since }));
}

export function humanBatchSampleCard(entry: AdminReviewEntry): HumanBatchSampleCard {
  const stopped = entry.candidate.signals?.stoppedAt;
  const delegate = entry.delegate ? { ...delegateOpinionText(entry.delegate), confidence: entry.delegate.confidence } : null;
  return {
    id: entry.candidate.id, repo: entry.candidate.repo, name: entry.name, productUrl: entry.candidate.productUrl ?? null,
    intro: clip(entry.tagline?.text || entry.description, 280), state: entry.candidate.state, reason: entry.candidate.reason ?? null,
    first: entry.review ? { decision: entry.review.decision, confidence: entry.review.confidence, reason: clip(entry.review.reason, 240) } : null,
    seconds: entry.seconds.filter(vote => !vote.echo).map(vote => ({ model: vote.model, decision: vote.decision, reason: clip(vote.reason, 240) })),
    delegate: delegate && { leaning: delegate.leaning, cause: delegate.cause, confidence: delegate.confidence },
    stopped: stopped && typeof stopped === "object" && "detail" in stopped && typeof stopped.detail === "string" ? clip(stopped.detail, 200) : null,
  };
}

/**
 * 표본 카드의 2차 투표 모델을 사용자가 정한 이름으로(운영 콘솔 통합 — 서버가 알려 준 모델 이름을 따로 적지 않는다).
 * 그 이름을 내놓는 연결이 하나로 정해지지 않으면(지운 연결의 옛 투표 등) 기록 그대로 둔다.
 */
export function humanBatchCardNames(cards: readonly HumanBatchSampleCard[], connections: readonly AiConnectionView[] | null): HumanBatchSampleCard[] {
  if (!connections) return [...cards];
  return cards.map(card => ({ ...card, seconds: card.seconds.map(vote => ({ ...vote, model: aiModelNameOfServed(connections, vote.model) ?? vote.model })) }));
}

/** 표본 카드 — 기존 상세와 같은 읽기(listAdminReviewEntries). 다른 곳에서 처리됐어도 보이게 모든 상태에서 */
async function sampleCards(settings: CrawlSettings, ids: readonly number[]): Promise<HumanBatchSampleCard[]> {
  if (!ids.length) return [];
  const { entries } = await listAdminReviewEntries(settings, { state: "all", ids: [...ids], limit: ids.length });
  const byId = new Map(entries.map(entry => [entry.candidate.id, humanBatchSampleCard(entry)]));
  return ids.flatMap(id => byId.get(id) ?? []);
}

export async function readHumanBatches(actor: string): Promise<HumanBatchesRead> {
  const measuredAt = new Date().toISOString();
  const settings = await getSettings();
  const overviewRead = settle("overview", humanQueueOverview(settings));
  const repoDeletedRead = settle("repo_deleted", readRepoDeletedIds());
  const [overview, repoDeleted, holds, delegate, assist, inbox, audit, gates, runs, connections] = await Promise.all([
    overviewRead, repoDeletedRead, settle("holds", readHoldCounts()), settle("delegate", readHumanDelegateSummary()), settle("assist", readHumanAssistProgress()),
    settle("inbox", sharedInbox()), settle("audit", openBacklogStats()), settle("gates", latestHumanBatchGates(actor)),
    settle("runs", recentHumanBatchRuns(10)), settle("connections", listAiConnections()),
  ]);
  const members = overview && repoDeleted ? humanBatchMembers(overview, repoDeleted) : null;
  const panels = await Promise.all(HUMAN_BATCH_KEYS.map(async (key): Promise<HumanBatchPanel> => {
    const ids = members?.[key] ?? (key === "repo_deleted" ? repoDeleted : null);
    const gate = gates?.[key] ?? null;
    const [preview, cards] = await Promise.all([
      settle(`preview:${key}`, batchPreview(ids ?? [])),
      gate && !gate.executedAt ? settle(`cards:${key}`, sampleCards(settings, gate.sampleIds)) : Promise.resolve([]),
    ]);
    return { key, members: ids, preview: preview ?? [], gate, cards: humanBatchCardNames(cards ?? [], connections) };
  }));
  return { measuredAt, overview, holds: holds?.holds ?? null, delegate, assist, inbox, panels, runs,
    audit: audit ? { open: audit.open, overdue: audit.overdue, oldestWaitDays: audit.oldestWaitDays } : null };
}

/** 문턱 보기 — 24시간 미리보기와(문턱을 고르면) 그 구간의 거절 표본. 화면이 따로 흘려 받는다(5초 상한 복제본 읽기 둘) */
export async function readHumanThreshold(rejectsAt: number | null): Promise<{ preview: DelegateThresholdPreview | null; samples: DelegateRejectSamples | null }> {
  const [preview, samples] = await Promise.all([
    settle("threshold", readDelegateThresholdPreview(24)),
    rejectsAt === null ? Promise.resolve(null) : settle("threshold_samples", readDelegateRejectSamples(rejectsAt)),
  ]);
  return { preview, samples };
}
