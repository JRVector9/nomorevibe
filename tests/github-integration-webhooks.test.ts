import { createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

it("loads maintenance dependencies in a plain Node worker without React export conditions", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    await import("./lib/domain/github-webhooks/process.ts");
    await import("./lib/domain/github-webhooks/reconcile.ts");
    await import("./lib/domain/github-webhooks/lifecycle.ts");
  `], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: "", READ_DATABASE_URL: "" }, timeout: 10_000, encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

const starSecret = "star-webhook-secret-at-least-32-bytes";
const feedbackSecret = "feedback-webhook-secret-at-least-32-bytes";
const installation = { id: 12, app_id: 123, repository_selection: "selected", suspended_at: null, permissions: { issues: "write", metadata: "read" } };
function signed(payload: unknown, event = "installation", changed: Record<string, string> = {}, app: "star" | "feedback" = "feedback") {
  const raw = JSON.stringify(payload);
  return new Request("https://nomorevibe.test/api/github/webhooks/" + app, { method: "POST", headers: {
    "content-type": "application/json", "x-github-delivery": randomUUID(), "x-github-event": event,
    "x-github-hook-installation-target-id": app === "feedback" ? "123" : "321",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", app === "feedback" ? feedbackSecret : starSecret).update(raw).digest("hex"), ...changed,
  }, body: raw });
}
async function read(request: Request, app: "star" | "feedback" = "feedback", options?: { timeoutMs?: number }) {
  const implementation = await import("@/lib/domain/github-webhooks/verify");
  return implementation.readGithubWebhook(request, app, options);
}
beforeEach(() => {
  vi.stubEnv("GITHUB_FEEDBACK_APP_ID", "123"); vi.stubEnv("GITHUB_STAR_APP_ID", "321");
  vi.stubEnv("GITHUB_FEEDBACK_APP_WEBHOOK_SECRET", feedbackSecret); vi.stubEnv("GITHUB_STAR_APP_WEBHOOK_SECRET", starSecret);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("raw GitHub App webhook verification", () => {
  it("verifies the exact raw body and retains only target identifiers and a payload digest", async () => {
    const request = signed({ action: "deleted", installation, sender: { id: 42, email: "private@example.test" }, token: "secret-credential" });
    const value = await read(request);
    expect(value).toMatchObject({ app: "feedback", event: "installation", action: "deleted", installationId: 12, repositoryId: null });
    expect(value!.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(value)).not.toContain("private@example.test");
    expect(JSON.stringify(value)).not.toContain("secret-credential");
  });

  it.each(["missing", "sha1", "tampered", "duplicate"])("rejects %s signatures", async kind => {
    const signature = kind === "missing" ? "" : kind === "sha1" ? "sha1=" + "a".repeat(40) : kind === "duplicate" ? "sha256=" + "a".repeat(64) + ", sha256=" + "b".repeat(64) : "sha256=" + "a".repeat(64);
    await expect(read(signed({ action: "deleted", installation }, "installation", { "x-hub-signature-256": signature }))).rejects.toMatchObject({ status: 401, code: "github_webhook_signature_invalid" });
  });

  it("rejects a different App's payload even with a valid endpoint signature", async () => {
    await expect(read(signed({ action: "deleted", installation: { ...installation, app_id: 999 } }))).rejects.toMatchObject({ code: "github_webhook_app_mismatch" });
    await expect(read(signed({ action: "deleted", installation }, "installation", { "x-github-hook-installation-target-id": "999" }))).rejects.toMatchObject({ code: "github_webhook_app_mismatch" });
  });

  it("keeps user revocation tied to the Star App secret and numeric GitHub user ID", async () => {
    const payload = { action: "revoked", sender: { id: 42, login: "maker", email: "private@example.test" } };
    expect(await read(signed(payload, "github_app_authorization", {}, "star"), "star")).toMatchObject({ app: "star", event: "github_app_authorization", githubUserId: 42, action: "revoked" });
    await expect(read(signed(payload, "github_app_authorization", {}, "star"), "feedback")).rejects.toMatchObject({ code: "github_webhook_signature_invalid" });
  });

  it("rejects shared App webhook secrets because a user revocation has no App ID in its body", async () => {
    vi.stubEnv("GITHUB_STAR_APP_WEBHOOK_SECRET", feedbackSecret);
    await expect(read(signed({ action: "deleted", installation }))).rejects.toMatchObject({ status: 503, code: "github_webhook_unconfigured" });
  });

  it("keeps only numeric removed repository IDs and issue identity, not issue body", async () => {
    expect(await read(signed({ action: "removed", installation, repositories_removed: [{ id: 42 }, { id: 43 }, { id: 42 }] }, "installation_repositories"))).toMatchObject({ removedRepositoryIds: [42, 43] });
    const value = await read(signed({ action: "closed", installation, repository: { id: 42 }, issue: { id: 99, number: 7, body: "private feedback text", state: "closed" } }, "issues"));
    expect(value).toMatchObject({ repositoryId: 42, issueId: 99, issueNumber: 7 });
    expect(JSON.stringify(value)).not.toContain("private feedback text");
    expect(JSON.stringify(value)).not.toContain('"state":"closed"');
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, "42"])("rejects unsafe payload identifiers %s", async id => {
    await expect(read(signed({ action: "deleted", installation: { ...installation, id } }))).rejects.toMatchObject({ code: "github_webhook_payload_invalid" });
  });

  it("rejects invalid delivery GUIDs and content types before recording any event", async () => {
    await expect(read(signed({ action: "deleted", installation }, "installation", { "x-github-delivery": "../../secret" }))).rejects.toMatchObject({ code: "github_webhook_headers_invalid" });
    await expect(read(signed({ action: "deleted", installation }, "installation", { "content-type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
  });

  it("bounds declared and streamed raw bodies and cancels overflow", async () => {
    await expect(read(signed({ action: "deleted", installation }, "installation", { "content-length": "10000000" }))).rejects.toMatchObject({ status: 413 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); }, cancel() { cancelled = true; } });
    const request = new Request("https://nomorevibe.test/hook", { method: "POST", headers: { "content-type": "application/json", "x-github-delivery": randomUUID(), "x-github-event": "installation", "x-hub-signature-256": "sha256=" + "a".repeat(64) }, body: stream, duplex: "half" } as RequestInit);
    await expect(read(request)).rejects.toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
  });

  it("bounds a hanging raw-body read and ignores verified unsupported events", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
    const request = new Request("https://nomorevibe.test/hook", { method: "POST", headers: { "content-type": "application/json", "x-github-delivery": randomUUID(), "x-github-event": "installation", "x-hub-signature-256": "sha256=" + "a".repeat(64) }, body: stream, duplex: "half" } as RequestInit);
    await expect(read(request, "feedback", { timeoutMs: 5 })).rejects.toMatchObject({ status: 408, code: "github_webhook_body_timeout" });
    expect(await read(signed({ action: "changed", private: "text" }, "push"))).toBeNull();
  });

  it("rejects unbounded installation enum values before their database fields", async () => {
    await expect(read(signed({ action: "created", installation: { ...installation, repository_selection: "x".repeat(1000) } }))).rejects.toMatchObject({ code: "github_webhook_payload_invalid" });
    await expect(read(signed({ action: "created", installation: { ...installation, permissions: { issues: "x".repeat(1000) } } }))).rejects.toMatchObject({ code: "github_webhook_payload_invalid" });
  });

  it.each([{}, { metadata: "read" }])("treats a present permissions object without Issues as no Issues permission: %j", async permissions => {
    expect(await read(signed({ action: "new_permissions_accepted", installation: { ...installation, permissions } }))).toMatchObject({ issuesPermission: "none" });
  });

  it("keeps an absent optional permissions object distinct from permission removal", async () => {
    expect(await read(signed({ action: "created", installation: { ...installation, permissions: undefined } }))).toMatchObject({ issuesPermission: null });
  });

  it.each([null, [], "read"])("rejects a provided malformed permissions object: %j", async permissions => {
    await expect(read(signed({ action: "new_permissions_accepted", installation: { ...installation, permissions } }))).rejects.toMatchObject({ code: "github_webhook_payload_invalid" });
  });
});

const repository = { id: 42, name: "Repo", owner: { login: "Owner" }, full_name: "Owner/Repo", html_url: "https://github.com/Owner/Repo", private: false, archived: false, has_issues: true };
const linkedIssue = { id: 99, number: 7, state: "closed", repository_url: "https://api.github.com/repos/Owner/Repo", url: "https://api.github.com/repos/Owner/Repo/issues/7", html_url: "https://github.com/Owner/Repo/issues/7", body: "Edited by a maintainer" };
const success = (data: unknown) => ({ outcome: "confirmed_success" as const, status: 200, data, retryAt: null, requestId: null, code: null });
const linked = { installationId: 12, repositoryId: 42, githubIssueId: 99, githubIssueNumber: 7 };

describe("authoritative linked issue reads", () => {
  it("reads the frozen numeric repository then exact issue identity without requiring an unchanged body", async () => {
    const { readLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    const request = vi.fn().mockResolvedValueOnce(success(repository)).mockResolvedValueOnce(success(linkedIssue));
    const token = vi.fn().mockResolvedValue({ token: "ghs_fixture", expiresAt: Date.now() + 60_000 });
    expect(await readLinkedGithubIssue(linked, { request, token, deadlineAt: Date.now() + 10_000 })).toMatchObject({ state: "closed", errorCode: null });
    expect(request.mock.calls.map(call => call[0].path)).toEqual(["/repositories/42", "/repos/Owner/Repo/issues/7"]);
    expect(request.mock.calls.every(call => !call[0].method || call[0].method === "GET")).toBe(true);
  });
  it.each(["metadata", "private", "mismatch", "issue_identity", "rate_limit"])("keeps %s ambiguity as unknown without a write", async kind => {
    const { readLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    const rejected = { outcome: "confirmed_rejection", status: kind === "rate_limit" ? 429 : 404, code: kind === "rate_limit" ? "github_rate_limited" : "github_not_found", retryAt: null, requestId: null };
    const request = vi.fn().mockResolvedValueOnce(kind === "metadata" ? rejected : success({ ...repository, ...(kind === "private" ? { private: true } : {}), ...(kind === "mismatch" ? { id: 43 } : {}) })).mockResolvedValueOnce(kind === "rate_limit" ? rejected : success({ ...linkedIssue, id: kind === "issue_identity" ? 100 : 99 }));
    expect(await readLinkedGithubIssue(linked, { request, token: async () => ({ token: "ghs_fixture", expiresAt: Date.now() + 60_000 }), deadlineAt: Date.now() + 10_000 })).toMatchObject({ state: "unknown" });
    expect(request.mock.calls.every(call => !call[0].method || call[0].method === "GET")).toBe(true);
  });
  it("marks a missing issue deleted only after the public repository ID has been confirmed", async () => {
    const { readLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    const request = vi.fn().mockResolvedValueOnce(success(repository)).mockResolvedValueOnce({ outcome: "confirmed_rejection", status: 404, code: "github_not_found", retryAt: null, requestId: null });
    expect(await readLinkedGithubIssue(linked, { request, token: async () => ({ token: "ghs_fixture", expiresAt: Date.now() + 60_000 }), deadlineAt: Date.now() + 10_000 })).toMatchObject({ state: "deleted" });
  });
  it("does not chain a late token result into another HTTP call", async () => {
    const { readLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    let resolve!: (value: { token: string; expiresAt: number }) => void;
    const token = () => new Promise<{ token: string; expiresAt: number }>(done => { resolve = done; });
    const request = vi.fn();
    expect(await readLinkedGithubIssue(linked, { request, token, deadlineAt: Date.now() + 5 })).toMatchObject({ state: "unknown" });
    resolve({ token: "ghs_fixture", expiresAt: Date.now() + 60_000 });
    await new Promise(done => setTimeout(done, 5));
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["token", "metadata", "issue"])("retains a proven %s retry time for a periodic read", async stage => {
    const { readLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    const { GithubInstallationError } = await import("@/lib/domain/github-installations/credentials");
    const retryAt = Date.now() + 3_600_000;
    const rejected = { outcome: "confirmed_rejection", status: 429, code: "github_rate_limited", retryAt, requestId: null };
    const request = vi.fn().mockResolvedValueOnce(stage === "metadata" ? rejected : success(repository)).mockResolvedValueOnce(rejected);
    const token = async () => { if (stage === "token") throw new GithubInstallationError(503, "github_installation_rate_limited", { providerCode: "github_rate_limited", retryAt }); return { token: "ghs_fixture", expiresAt: Date.now() + 60_000 }; };
    expect(await readLinkedGithubIssue(linked, { request, token, deadlineAt: Date.now() + 10_000 })).toMatchObject({ state: "unknown", errorCode: "github_rate_limited", retryAt });
  });
});

describe("administrator recovery form protection", () => {
  const secret = "admin-secret-at-least-32-characters";
  const admin = { login: "operator", exp: Math.floor(Date.now() / 1000) + 3600 };
  it("requires a signed session-purpose token and the configured exact Origin", async () => {
    const { adminRecoveryCsrf, assertAdminRecoveryCsrf } = await import("@/lib/domain/github-webhooks/admin-auth");
    const token = adminRecoveryCsrf(admin, secret);
    expect(() => assertAdminRecoveryCsrf({ admin, secret, origin: "https://nomorevibe.test", configuredOrigin: "https://nomorevibe.test", token, expiresAt: admin.exp, local: false })).not.toThrow();
  });
  it.each(["origin", "missing", "tampered", "expired", "different_session"])("rejects %s admin mutation proof", async kind => {
    const { adminRecoveryCsrf, assertAdminRecoveryCsrf } = await import("@/lib/domain/github-webhooks/admin-auth");
    expect(() => assertAdminRecoveryCsrf({ admin, secret, origin: kind === "origin" ? "https://attacker.test" : "https://nomorevibe.test", configuredOrigin: "https://nomorevibe.test", token: kind === "missing" ? null : kind === "tampered" ? "a".repeat(64) : adminRecoveryCsrf(admin, secret), expiresAt: kind === "expired" ? 1 : kind === "different_session" ? admin.exp + 1 : admin.exp, local: false })).toThrow();
  });
  it("rejects anonymous administrator actions before accepting any form target", async () => {
    vi.doMock("@/lib/auth/admin", () => ({ currentAdmin: async () => null, authSecret: () => secret, adminLocalLoginEnabled: () => false, LOCAL_ADMIN_LOGIN: "local" }));
    const { requeryGithubIntegrationAction, retransmitGithubIntegrationAction } = await import("@/app/admin/github-integrations/actions");
    await expect(requeryGithubIntegrationAction(new FormData())).rejects.toThrow("unauthorized");
    await expect(retransmitGithubIntegrationAction(new FormData())).rejects.toThrow("unauthorized");
    vi.doUnmock("@/lib/auth/admin");
  });
});
