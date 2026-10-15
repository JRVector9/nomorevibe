import { z } from "zod";
import { getTableColumns, type Table } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type { Ai2ItemBinding } from "@/lib/jobs/items/types";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { reviewSemanticNow } from "@/lib/crawl/review-replay-context";
import { secondReviewInputMatches } from "@/lib/crawl/second-review-input";
import { secondReviewBinding } from "@/lib/crawl/second-review-ownership";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { repositoryUrl } from "@/lib/domain/products/access";
import { applyReplayChanges, ReplayReadinessProjectionSchema, type ReplayReadinessProjection } from "./pipeline-replay-readiness";
import { canonicalReplayItemState, ReplayItemStateSchema } from "./pipeline-replay-item-state";

export type ReplayAi2TargetAssessment =
  | { kind: "eligible"; targetId: number; binding: Ai2ItemBinding; inputMembership: "included" | "outside" }
  | { kind: "ineligible"; targetId: number; reason: "stage_inactive" | "not_pending" | "running" | "input_changed" }
  | { kind: "unknown"; targetId: number; reason: "ambiguous_settings" | "implicit_first_reviewer" | "missing_stored_readme" };

const combinedStateSchema = z.object({ kind: z.literal("pipeline-replay-combined-state"), version: z.literal(1),
  domain: ReplayReadinessProjectionSchema, items: ReplayItemStateSchema }).strict();
const targetSchema = z.number().int().positive().safe();
const wallSchema = z.string().datetime().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.slice(0, 23) + "Z",
    "invalid_replay_wall_time");
type RawRow = ReplayReadinessProjection["tables"]["jobs"][number];
function hydrate<T>(table: Table, row: RawRow): T {
  return Object.fromEntries(Object.entries(getTableColumns(table)).map(([property, column]) => [property,
    row[column.name] === null ? null : column.dataType === "date" ? new Date(String(row[column.name]))
      : column.mapFromDriverValue(row[column.name])])) as T;
}
function microseconds(value: string): bigint {
  return BigInt(Date.parse(value)) * BigInt(1_000) + BigInt(value.slice(20, -1).slice(3).padEnd(3, "0") || "0");
}

/** Snapshot logic only: no claim, lock availability or execution authority. */
export function assessReplayAi2Target(value: unknown, targetId: number, wallTime: string): ReplayAi2TargetAssessment {
  const state = combinedStateSchema.parse(value);
  targetSchema.parse(targetId); wallSchema.parse(wallTime);
  const domain = applyReplayChanges(state.domain, []), items = canonicalReplayItemState(state.items);
  const reference = new Date(domain.referenceTime);
  if (+reviewSemanticNow(reference) !== +reference) throw new Error("replay_clock_scope_conflict");
  const stage = items.tables.pipeline_stage_modes.find(row => row.stage === "ai2")!;
  if (stage.mode !== "items" || stage.writer_contract_version < 1)
    return { kind: "ineligible", targetId, reason: "stage_inactive" };
  const row = domain.tables.second_reviews.find(row => row.id === targetId);
  if (!row || row.status !== "pending") return { kind: "ineligible", targetId, reason: "not_pending" };
  const vote = row.fallback_for_id ?? row.id;
  // The actual claim protects this root/child chain, not every generation for
  // the candidate. A snapshot cannot observe row/advisory lock availability.
  const chainKeys = new Set(domain.tables.second_reviews.filter(item => item.id === row.id || item.id === vote
    || item.fallback_for_id === vote).map(item => `ai2:${item.id}`));
  const wall = microseconds(wallTime);
  if (items.tables.pipeline_item_leases.some(item => item.stage === "ai2" && chainKeys.has(item.work_key)
    && item.token !== null && microseconds(item.lease_until!) > wall))
    return { kind: "ineligible", targetId, reason: "running" };

  const saved = domain.tables.crawl_settings;
  if (saved.length > 1) return { kind: "unknown", targetId, reason: "ambiguous_settings" };
  const settings = mergeWithDefaults(saved[0]?.values);
  if (!settings.firstReview) return { kind: "unknown", targetId, reason: "implicit_first_reviewer" };
  const candidateRow = domain.tables.crawl_candidates.find(item => item.id === row.candidate_id);
  const documentRow = domain.tables.crawl_documents.find(item => item.repo === row.repo);
  if (!candidateRow || !documentRow) return { kind: "ineligible", targetId, reason: "input_changed" };
  const candidate = hydrate<schema.CrawlCandidate>(schema.crawlCandidates, candidateRow);
  const document = hydrate<schema.CrawlDocument>(schema.crawlDocuments, documentRow);
  if (typeof document.pageMeta?.readmeSample !== "string" || document.pageMeta.readmeSampleVersion !== README_SAMPLE_VERSION)
    return { kind: "unknown", targetId, reason: "missing_stored_readme" };

  // This is the loader's storage selection only. Factory/predicate/builder
  // retain all source, policy, gate, independence and freshness decisions.
  const scanRow = domain.tables.agent_repository_scans.filter(item => item.repository_key === candidate.repo.toLowerCase()
    && item.scope === "").sort((a, b) => {
      const left = microseconds(a.started_at as string), right = microseconds(b.started_at as string);
      return left === right ? (b.id as number) - (a.id as number) : left > right ? -1 : 1;
    })[0];
  const scan = scanRow ? hydrate<schema.AgentRepositoryScan>(schema.agentRepositoryScans, scanRow) : null;
  const observations = scan ? domain.tables.agent_repository_observations.filter(item => item.scan_id === scan.id)
    .sort((a, b) => (a.id as number) - (b.id as number))
    .map(item => hydrate<typeof schema.agentRepositoryObservations.$inferSelect>(schema.agentRepositoryObservations, item)) : [];
  const input = createReviewInput(candidate, document, settings, { scan,
    observations: observations.map(item => ({ id: `observation:${item.id}`, observation: item.facts })) }, reference);
  const current = hydrate<schema.SecondReview>(schema.secondReviews, row);
  const rootRow = current.fallbackForId ? domain.tables.second_reviews.find(item => item.id === current.fallbackForId) : row;
  const root = rootRow ? hydrate<schema.SecondReview>(schema.secondReviews, rootRow) : null;
  let first: schema.CrawlReviewAttempt | null = null;
  if (!current.publishedSlug) {
    const gateFirst = current.trigger === "ai_approved" && current.firstAttemptId
      ? domain.tables.crawl_review_attempts.find(item => item.id === current.firstAttemptId && item.candidate_id === current.candidateId) : undefined;
    const firstRow = domain.tables.crawl_review_attempts.filter(item => item.candidate_id === current.candidateId
      && item.kind === "automatic" && item.state === "succeeded"
      && (["claude-cli", "abcllm"].includes(item.provider as string) || settings.firstReview!.provider === "grok-cli"
        && item.provider === settings.firstReview!.provider && item.model === settings.firstReview!.model)
      && (!gateFirst || item.provider === gateFirst.provider && item.model === gateFirst.model))
      .sort((a, b) => (b.id as number) - (a.id as number))[0];
    if (firstRow) first = hydrate<schema.CrawlReviewAttempt>(schema.crawlReviewAttempts, firstRow);
  }
  if (!secondReviewInputMatches(current, { candidate, document, settings, input, first, root }, reference))
    return { kind: "ineligible", targetId, reason: "input_changed" };
  let publishedProductId: number | null = null;
  if (current.publishedSlug) {
    const products = domain.tables.products.map(item => hydrate<schema.Product>(schema.products, item));
    const published = products.find(item => item.slug === current.publishedSlug);
    const canonical = repositoryUrl(current.repo)?.toLowerCase();
    const selected = products.filter(item => candidate.productUrl && item.url === candidate.productUrl
      || canonical && (item.url === canonical || item.repoUrl?.replace(/\/+$/, "").toLowerCase()
        .replace(/^https?:\/\/(www[.])?/, "https://").replace(/[.]git$/, "") === canonical))
      .sort((a, b) => Number(b.status === "banned") - Number(a.status === "banned") || a.id - b.id)[0];
    if (!published || selected?.id !== published.id) return { kind: "ineligible", targetId, reason: "input_changed" };
    publishedProductId = published.id;
  }
  const binding = secondReviewBinding({ row: current, candidate, document, settings, input, first, root: root ?? current,
    publishedProductId });
  if (items.tables.pipeline_item_leases.some(item => item.stage === "ai2" && item.work_key === `ai2:${targetId}`
    && item.item_epoch === Number.MAX_SAFE_INTEGER)) return { kind: "ineligible", targetId, reason: "running" };
  const inputMembership = domain.universe.some(item => item.candidateId === candidate.id && item.inputHash === input.inputHash
    && item.sourceRevisionHash === input.sourceRevisionHash) ? "included" : "outside";
  return { kind: "eligible", targetId, binding, inputMembership };
}
