import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { PublicAuthError } from "@/lib/domain/accounts/errors";
import { isGithubNumericId } from "@/lib/github/repositories";

export class GithubWebhookError extends PublicAuthError {}
export type GithubWebhookApp = "star" | "feedback";
export type GithubWebhookEvent = "github_app_authorization" | "installation" | "installation_repositories" | "issues";
export type GithubWebhookEnvelope = {
  app: GithubWebhookApp; deliveryId: string; event: GithubWebhookEvent; action: string;
  installationId: number | null; repositoryId: number | null; githubUserId: number | null;
  issueId: number | null; issueNumber: number | null; removedRepositoryIds: number[];
  issuesPermission: string | null; repositorySelection: string | null; suspended: boolean | null; payloadHash: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 512 * 1024;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function invalid(): never { throw new GithubWebhookError(400, "github_webhook_payload_invalid"); }
function numeric(value: unknown): number { if (!isGithubNumericId(value)) invalid(); return value; }

export function githubWebhookConfig(app: GithubWebhookApp) {
  const prefix = app === "star" ? "GITHUB_STAR_APP" : "GITHUB_FEEDBACK_APP";
  const id = process.env[`${prefix}_ID`], secret = process.env[`${prefix}_WEBHOOK_SECRET`];
  const other = process.env[app === "star" ? "GITHUB_FEEDBACK_APP_WEBHOOK_SECRET" : "GITHUB_STAR_APP_WEBHOOK_SECRET"];
  if (!id || !/^[1-9]\d*$/.test(id) || !isGithubNumericId(Number(id)) || !secret || secret.length < 32 || secret === other) throw new GithubWebhookError(503, "github_webhook_unconfigured");
  return { id: Number(id), secret };
}

async function rawBody(request: Request, timeoutMs: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new GithubWebhookError(413, "github_webhook_body_too_large");
  const reader = request.body?.getReader();
  if (!reader) invalid();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => { timedOut = true; reject(new GithubWebhookError(408, "github_webhook_body_timeout")); void reader.cancel().catch(() => {}); };
    timer = setTimeout(abort, Math.max(1, Math.min(5_000, timeoutMs)));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel().catch(() => {}); throw new GithubWebhookError(413, "github_webhook_body_too_large"); }
      chunks.push(value);
    }
    if (timedOut || request.signal.aborted) throw new GithubWebhookError(408, "github_webhook_body_timeout");
    return Buffer.concat(chunks, size);
  } finally { clearTimeout(timer); if (abort) request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** GitHub signs bytes, not parsed JSON; no raw body or credential is persisted. */
export async function readGithubWebhook(request: Request, app: GithubWebhookApp, options: { timeoutMs?: number } = {}): Promise<GithubWebhookEnvelope | null> {
  const config = githubWebhookConfig(app);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new GithubWebhookError(415, "github_webhook_json_required");
  const deliveryId = request.headers.get("x-github-delivery") ?? "", event = request.headers.get("x-github-event") ?? "";
  if (!UUID.test(deliveryId) || !/^[a-z_]{1,50}$/.test(event)) throw new GithubWebhookError(400, "github_webhook_headers_invalid");
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) throw new GithubWebhookError(401, "github_webhook_signature_invalid");
  const raw = await rawBody(request, options.timeoutMs ?? 5_000);
  const expected = createHmac("sha256", config.secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))) throw new GithubWebhookError(401, "github_webhook_signature_invalid");
  const target = request.headers.get("x-github-hook-installation-target-id");
  if (target !== null && target !== String(config.id)) throw new GithubWebhookError(403, "github_webhook_app_mismatch");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { invalid(); }
  if (!record(value)) invalid();
  if (!["github_app_authorization", "installation", "installation_repositories", "issues"].includes(event)) return null;
  const action = value.action;
  if (typeof action !== "string" || !/^[a-z_]{1,64}$/.test(action)) invalid();
  const envelope: GithubWebhookEnvelope = { app, deliveryId: deliveryId.toLowerCase(), event: event as GithubWebhookEvent, action, installationId: null, repositoryId: null, githubUserId: null,
    issueId: null, issueNumber: null, removedRepositoryIds: [], issuesPermission: null, repositorySelection: null, suspended: null, payloadHash: createHash("sha256").update(raw).digest("hex") };
  if (value.installation !== undefined) {
    if (!record(value.installation)) invalid();
    envelope.installationId = numeric(value.installation.id);
    if (value.installation.app_id !== undefined && value.installation.app_id !== config.id) throw new GithubWebhookError(403, "github_webhook_app_mismatch");
    if (event === "installation" && value.installation.app_id !== config.id) throw new GithubWebhookError(403, "github_webhook_app_mismatch");
    if (value.installation.repository_selection !== undefined) {
      if (!["selected", "all"].includes(value.installation.repository_selection as string)) invalid();
      envelope.repositorySelection = value.installation.repository_selection as string;
    }
    if (value.installation.suspended_at !== undefined) envelope.suspended = value.installation.suspended_at !== null;
    if (value.installation.permissions !== undefined) {
      if (!record(value.installation.permissions)) invalid();
      const issues = value.installation.permissions.issues;
      if (issues !== undefined && !["read", "write", "none"].includes(issues as string)) invalid();
      envelope.issuesPermission = issues === undefined ? "none" : issues as string;
    }
  }
  if (event === "github_app_authorization") {
    if (action !== "revoked" || !record(value.sender)) invalid();
    envelope.githubUserId = numeric(value.sender.id);
  } else if (!envelope.installationId) invalid();
  if (event === "installation_repositories" && action === "removed") {
    if (!Array.isArray(value.repositories_removed) || value.repositories_removed.length > 2_000) invalid();
    envelope.removedRepositoryIds = [...new Set(value.repositories_removed.map(repo => record(repo) ? numeric(repo.id) : invalid()))];
  }
  if (event === "issues") {
    if (!record(value.repository) || !record(value.issue)) invalid();
    envelope.repositoryId = numeric(value.repository.id); envelope.issueId = numeric(value.issue.id); envelope.issueNumber = numeric(value.issue.number);
    if (envelope.issueNumber > 2_147_483_647) invalid();
  }
  return envelope;
}
