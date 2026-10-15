import { z } from "zod";
import { reviewHash } from "@/lib/crawl/agent-review-contract";

export const ITEM_STAGES = ["fetch", "ai1", "ai2"] as const;
export const itemStageSchema = z.enum(ITEM_STAGES);
export const itemStageModeSchema = z.enum(["legacy", "draining", "items"]);
export type ItemStage = z.infer<typeof itemStageSchema>;
export type ItemStageMode = z.infer<typeof itemStageModeSchema>;

const positive = z.number().int().positive().safe();
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);
const identity = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "invalid_identity");
const isoMilliseconds = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "invalid_timestamp");

export const itemOwnerSchema = z.object({ instanceId: identity(120), bootId: z.uuid() }).strict();
export type ItemOwner = Readonly<z.infer<typeof itemOwnerSchema>>;
const reviewer = z.object({ provider: identity(80), model: identity(160) }).strict();
const reviewBinding = { inputHash: sha64, sourceRevisionHash: sha64, policyHash: sha64,
  promptVersion: identity(40), rulesVersion: identity(40), reviewer };
const fetchBinding = z.object({ stage: z.literal("fetch"), frontierId: positive,
  repo: identity(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  claim: z.object({ attempts: positive, nextAttemptAt: isoMilliseconds }).strict() }).strict();
const firstBinding = z.object({ stage: z.literal("ai1"), candidateId: positive, ...reviewBinding }).strict();
const secondBinding = z.object({ stage: z.literal("ai2"), secondReviewId: positive, candidateId: positive,
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("first_attempt"), firstAttemptId: positive }).strict(),
    z.object({ kind: z.literal("published"), slug: identity(80) }).strict(),
  ]), ...reviewBinding, generationKey: sha64, vote: positive, fallbackForId: positive.nullable() }).strict();

/** Structural identity only: current source, human decisions and model independence remain domain checks (PR03/04). */
export const itemBindingSchema = z.discriminatedUnion("stage", [fetchBinding, firstBinding, secondBinding])
  .refine(binding => binding.stage !== "ai2" || (binding.vote === (binding.fallbackForId ?? binding.secondReviewId)
    && binding.fallbackForId !== binding.secondReviewId), "invalid_vote_binding");
export type ItemBinding = z.infer<typeof itemBindingSchema>;
export type FetchItemBinding = Extract<ItemBinding, { stage: "fetch" }>;
export type Ai1ItemBinding = Extract<ItemBinding, { stage: "ai1" }>;
export type Ai2ItemBinding = Extract<ItemBinding, { stage: "ai2" }>;
/** leaseUntil is returned observation; a heartbeat can extend it while the same token remains authoritative. */
export type ItemLease = Readonly<{ stage: ItemStage; workKey: string; binding: ItemBinding; bindingHash: string; owner: ItemOwner;
  token: string; stageEpoch: number; itemEpoch: number; leaseUntil: Date }>;

export function parseItemBinding(value: unknown): ItemBinding { return itemBindingSchema.parse(value); }
/** A new input or claim replaces the binding without creating a second lease slot for the same logical work. */
export function itemWorkKey(binding: ItemBinding): string {
  const parsed = parseItemBinding(binding);
  return `${parsed.stage}:${parsed.stage === "fetch" ? parsed.frontierId : parsed.stage === "ai1" ? parsed.candidateId : parsed.secondReviewId}`;
}
export function itemBindingHash(binding: ItemBinding): string { return reviewHash(parseItemBinding(binding)); }
