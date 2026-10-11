import { createHash } from "node:crypto";
import type { GithubRepository } from "@/lib/github/repositories";
import { isGithubNumericId } from "@/lib/github/repositories";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type FeedbackIssuePayload = { title: string; body: string };
export type DeliveredIssue = { id: number; number: number; url: string; state: "open" | "closed" };

export function feedbackIssueMarker(feedbackId: string, dispatchId: string): string {
  if (!UUID.test(feedbackId) || !UUID.test(dispatchId)) throw new Error("feedback_marker_invalid");
  return `<!-- nmv:feedback:${feedbackId}:dispatch:${dispatchId} -->`;
}

export function buildFeedbackIssuePayload(feedback: { id: string; title: string; body: string; kind: "bug" | "feature" | "question" }, nickname: string, origin: string, dispatchId: string): FeedbackIssuePayload {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("feedback_site_origin_invalid"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error("feedback_site_origin_invalid");
  const safeNickname = nickname.replace(/\s+/g, " ").replace(/[\\`*_{}[\]()#+.!>|]/g, "\\$&").slice(0, 240);
  const longestFence = Math.max(2, ...(feedback.body.match(/`+/g) ?? []).map((value) => value.length));
  const fence = "`".repeat(longestFence + 1);
  const kinds = { bug: "오류", feature: "기능 제안", question: "질문" };
  return {
    title: feedback.title.replace(/\s+/g, " ").trim(),
    body: `NoMoreVibe 앱 봇이 작성자의 GitHub 공개 동의를 받아 전달한 피드백입니다.\n\n작성자: ${safeNickname}\n종류: ${kinds[feedback.kind]}\n원문: ${origin}/feedback/${feedback.id}\n\n${fence}text\n${feedback.body}\n${fence}\n\n${feedbackIssueMarker(feedback.id, dispatchId)}`,
  };
}

export function feedbackPayloadHash(payload: FeedbackIssuePayload): string {
  return createHash("sha256").update(JSON.stringify([payload.title, payload.body])).digest("hex");
}

/** A numeric repository was read immediately before dispatch; every returned URL must refer to it. */
export function parseDeliveredIssue(value: unknown, repository: GithubRepository, expectedMarker?: string): DeliveredIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const issue = value as Record<string, unknown>;
  if (!isGithubNumericId(issue.id) || !isGithubNumericId(issue.number) || issue.number > 2_147_483_647
    || !["open", "closed"].includes(issue.state as string) || issue.pull_request !== undefined) return null;
  const expectedApi = `https://api.github.com/repos/${repository.fullName}`;
  if (typeof issue.repository_url !== "string" || issue.repository_url.toLowerCase() !== expectedApi.toLowerCase()
    || typeof issue.url !== "string" || issue.url.toLowerCase() !== `${expectedApi}/issues/${issue.number}`.toLowerCase()
    || typeof issue.html_url !== "string" || issue.html_url.toLowerCase() !== `${repository.htmlUrl}/issues/${issue.number}`.toLowerCase()) return null;
  if (issue.repository !== undefined && (!issue.repository || typeof issue.repository !== "object" || (issue.repository as Record<string, unknown>).id !== repository.id)) return null;
  if (expectedMarker && (typeof issue.body !== "string" || !issue.body.includes(expectedMarker))) return null;
  return { id: issue.id, number: issue.number, url: issue.html_url, state: issue.state as "open" | "closed" };
}
