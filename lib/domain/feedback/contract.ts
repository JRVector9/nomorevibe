export type FeedbackKind = "bug" | "feature" | "question";
export type FeedbackReviewState = "accepted" | "held" | "rejected";
export type IssueDeliveryState = "local_only" | "queued" | "sending" | "delivered" | "retry_wait" | "uncertain" | "blocked" | "cancelled";
export type FeedbackWrite = {
  requestId: string; kind: FeedbackKind; title: string; body: string;
  serviceDisclosureConsent: boolean; sendToGithub: boolean; githubDisclosureConsent: boolean;
};
export type FeedbackView = {
  id: string; productId: number; slug: string; productName: string; authorUserId: number; authorDisplayName: string;
  kind: FeedbackKind; title: string; body: string; reviewState: FeedbackReviewState; reviewReason: string | null;
  deliveryState: IssueDeliveryState; createdAt: string;
};

export class FeedbackError extends Error {
  constructor(public readonly code: "feedback_invalid" | "feedback_not_found" | "feedback_conflict" | "feedback_rate_limited", public readonly status: number) {
    super(code);
    this.name = "FeedbackError";
  }
}

/** Bounded before buffering; 32 KiB also permits escaped JSON for 5,000 characters. */
export async function readFeedbackJson(request: Request): Promise<unknown> {
  const limit = 32 * 1024;
  if (Number(request.headers.get("content-length")) > limit || !request.body) throw new FeedbackError("feedback_invalid", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new FeedbackError("feedback_invalid", 400); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new FeedbackError("feedback_invalid", 400);
  } finally { reader.releaseLock(); }
}

export function validateFeedbackWrite(input: unknown): FeedbackWrite {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FeedbackError("feedback_invalid", 400);
  const value = input as Record<string, unknown>;
  if (typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
    || !["bug", "feature", "question"].includes(value.kind as string)
    || typeof value.title !== "string" || value.title.length > 120 || !value.title.trim()
    || typeof value.body !== "string" || value.body.length > 5000 || !value.body.trim()
    || value.serviceDisclosureConsent !== true || typeof value.sendToGithub !== "boolean"
    || typeof value.githubDisclosureConsent !== "boolean" || (value.sendToGithub && !value.githubDisclosureConsent)) {
    throw new FeedbackError("feedback_invalid", 400);
  }
  return {
    requestId: value.requestId.toLowerCase(), kind: value.kind as FeedbackKind, title: value.title, body: value.body,
    serviceDisclosureConsent: true, sendToGithub: value.sendToGithub, githubDisclosureConsent: value.githubDisclosureConsent,
  };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizedFeedbackBodyHash(body: string): string {
  return sha256(body.normalize("NFKC").replace(/\s+/g, " ").trim());
}

export function feedbackFingerprint(productId: number, input: FeedbackWrite): string {
  return sha256(JSON.stringify([productId, input.kind, input.title, input.body, input.serviceDisclosureConsent, input.sendToGithub, input.githubDisclosureConsent]));
}

export function initialFeedbackReview(body: string, repeated: boolean, title = ""): { state: FeedbackReviewState; reason: string | null } {
  if ((`${title}\n${body}`.match(/https?:\/\/(?=[^\s<>])/gi)?.length ?? 0) >= 4) return { state: "held", reason: "too_many_urls" };
  if (repeated) return { state: "held", reason: "repeated_body" };
  return { state: "accepted", reason: null };
}
import { createHash } from "node:crypto";
