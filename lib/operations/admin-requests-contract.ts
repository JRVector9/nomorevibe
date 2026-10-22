import { z } from "zod";

export class AdminRequestError extends Error {
  constructor(public readonly code: "invalid" | "conflict" | "not_found") { super(code); }
}
export const reviewStates = ["held", "accepted", "rejected"] as const;
export const contactStates = ["new", "in_progress", "waiting", "resolved", "spam"] as const;
export const contactLabels = { new: "미처리", in_progress: "처리 중", waiting: "회신 대기", resolved: "처리 완료", spam: "스팸" };
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000]/.test(value));
export const contactInput = z.object({
  senderEmail: z.email().max(254), subject: text(200), body: text(10000),
  receivedAt: z.iso.datetime({ offset: true }).transform(value => new Date(value)),
}).strict();
export const contactUpdateInput = z.object({
  id: z.uuid(), version: z.number().int().positive(), status: z.enum(contactStates), handlingNote: text(2000),
}).strict();
export const replyReviewInput = z.object({
  id: z.uuid(), version: z.number().int().positive(), expectedState: z.enum(reviewStates), decision: z.enum(["accepted", "rejected"]),
}).strict().refine(value => value.expectedState !== value.decision);
export function parseAdminRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AdminRequestError("invalid");
  return parsed.data;
}
export function assertAdminActor(actor: string) {
  if (!actor.trim() || actor.length > 120) throw new AdminRequestError("invalid");
}
