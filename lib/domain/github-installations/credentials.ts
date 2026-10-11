import { PublicAuthError } from "@/lib/domain/accounts/errors";
import type { GithubProductBinding } from "@/lib/db/github-binding-schema";
import type { GithubRepository } from "@/lib/github/repositories";
import { isGithubNumericId, parseGithubRepositoryResponse } from "@/lib/github/repositories";
import { appJwt } from "@/lib/github/app-jwt";
import { githubRequest, type GithubErrorCode, type GithubRequestOptions, type GithubResult } from "@/lib/github/client";

export class GithubInstallationError extends PublicAuthError {
  readonly providerCode: GithubErrorCode | null;
  readonly retryAt: number | null;
  constructor(status: number, code: string, details: { providerCode?: GithubErrorCode | null; retryAt?: number | null } = {}) {
    super(status, code);
    this.providerCode = details.providerCode ?? null;
    this.retryAt = details.retryAt ?? null;
  }
}
export type FeedbackInstallationCredential = { token: string; expiresAt: number };
export type GithubInstallationOptions = { deadlineAt?: number; signal?: AbortSignal };

async function requestWithinDeadline<T>(request: GithubRequestOptions, options: GithubInstallationOptions): Promise<GithubResult<T>> {
  const remaining = options.deadlineAt === undefined ? 10_000 : options.deadlineAt - Date.now();
  const timeout = () => new GithubInstallationError(503, "github_installation_timeout", { providerCode: "github_timeout" });
  if (!Number.isFinite(remaining) || remaining <= 0 || options.signal?.aborted) throw timeout();
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(timeout());
    timer = setTimeout(abort, Math.min(10_000, remaining));
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([githubRequest<T>({ ...request, timeoutMs: Math.min(10_000, remaining) }), expired]);
    if (options.signal?.aborted || (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)) throw timeout();
    return result;
  } finally { clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort); }
}

export function feedbackAppSigningConfig() {
  const id = process.env.GITHUB_FEEDBACK_APP_ID, privateKey = process.env.GITHUB_FEEDBACK_APP_PRIVATE_KEY;
  if (!id || !/^[1-9]\d*$/.test(id) || !isGithubNumericId(Number(id)) || !privateKey) {
    throw new GithubInstallationError(503, "github_feedback_unconfigured");
  }
  return { id: Number(id), privateKey };
}

export function feedbackAppConfig() {
  const slug = process.env.GITHUB_FEEDBACK_APP_SLUG;
  if (!slug || !/^[A-Za-z0-9-]{1,100}$/.test(slug)) throw new GithubInstallationError(503, "github_feedback_unconfigured");
  return { ...feedbackAppSigningConfig(), slug };
}

function data<T>(result: GithubResult<T>): T {
  if (result.outcome === "confirmed_success") {
    if (!result.data) throw new GithubInstallationError(503, "github_installation_invalid_response");
    return result.data;
  }
  const details = { providerCode: result.code, retryAt: result.retryAt };
  if (result.outcome === "unknown") throw new GithubInstallationError(503, "github_installation_unknown", details);
  if (result.code === "github_rate_limited") throw new GithubInstallationError(503, "github_installation_rate_limited", details);
  if (result.status === 404) throw new GithubInstallationError(409, "github_installation_missing", details);
  throw new GithubInstallationError(result.status === 401 || result.status === 403 ? 403 : 503, "github_installation_unavailable", details);
}

export async function getFeedbackInstallationToken(input: { installationId: number; repositoryId: number }, options: GithubInstallationOptions = {}): Promise<FeedbackInstallationCredential> {
  if (!isGithubNumericId(input.installationId) || !isGithubNumericId(input.repositoryId)) throw new GithubInstallationError(400, "github_invalid_request");
  const config = feedbackAppSigningConfig();
  let jwt: string;
  try { jwt = appJwt(config.id, config.privateKey); } catch { throw new GithubInstallationError(503, "github_feedback_unconfigured"); }
  const installation = data(await requestWithinDeadline<{ id?: unknown; app_id?: unknown; suspended_at?: unknown; repository_selection?: unknown; permissions?: { issues?: unknown; metadata?: unknown } }>({
    path: `/app/installations/${input.installationId}`, token: jwt, auth: "app",
  }, options));
  if (installation.id !== input.installationId || installation.app_id !== config.id) throw new GithubInstallationError(403, "github_installation_mismatch");
  if (installation.suspended_at !== null) throw new GithubInstallationError(409, "github_installation_suspended");
  if (installation.repository_selection !== "selected") throw new GithubInstallationError(409, "github_installation_selection_required");
  if (installation.permissions?.issues !== "write" || installation.permissions?.metadata !== "read") throw new GithubInstallationError(409, "github_installation_permission_missing");
  const minted = data(await requestWithinDeadline<{ token?: unknown; expires_at?: unknown; permissions?: Record<string, unknown>; repositories?: { id?: unknown }[]; repository_selection?: unknown }>({
    path: `/app/installations/${input.installationId}/access_tokens`, token: jwt, auth: "app", method: "POST",
    body: { repository_ids: [input.repositoryId], permissions: { issues: "write", metadata: "read" } },
  }, options));
  const expiresAt = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : NaN;
  if (typeof minted.token !== "string" || !/^ghs_[A-Za-z0-9_.-]{16,4090}$/.test(minted.token)
    || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 3_720_000) throw new GithubInstallationError(503, "github_installation_token_invalid");
  if (minted.repository_selection !== "selected" || !Array.isArray(minted.repositories) || minted.repositories.length !== 1 || minted.repositories[0]?.id !== input.repositoryId
    || !minted.permissions || minted.permissions.issues !== "write" || minted.permissions.metadata !== "read"
    || Object.keys(minted.permissions).some(key => !["issues", "metadata"].includes(key))) throw new GithubInstallationError(503, "github_installation_token_scope_mismatch");
  return { token: minted.token, expiresAt };
}

export function requireEligibleFeedbackRepository(repository: GithubRepository | null): GithubRepository {
  if (!repository) throw new GithubInstallationError(409, "github_repository_changed");
  if (repository.private) throw new GithubInstallationError(409, "github_repository_private");
  if (repository.archived) throw new GithubInstallationError(409, "github_repository_archived");
  if (!repository.hasIssues) throw new GithubInstallationError(409, "github_repository_issues_disabled");
  return repository;
}

export async function verifyFeedbackInstallation(binding: Pick<GithubProductBinding, "installationId" | "repositoryId">, options: GithubInstallationOptions = {}): Promise<{ repository: GithubRepository }> {
  const credential = await getFeedbackInstallationToken(binding, options);
  const response = data(await requestWithinDeadline<unknown>({ path: `/repositories/${binding.repositoryId}`, token: credential.token, auth: "installation" }, options));
  return { repository: requireEligibleFeedbackRepository(parseGithubRepositoryResponse(response, binding.repositoryId)) };
}
