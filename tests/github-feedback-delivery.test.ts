import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFeedbackIssuePayload, feedbackIssueMarker, feedbackPayloadHash, parseDeliveredIssue } from "@/lib/domain/feedback/github/issue-body";
import type { GithubRepository } from "@/lib/github/repositories";

const repository: GithubRepository = { id: 123, owner: "acme", repo: "tool", fullName: "acme/tool", htmlUrl: "https://github.com/acme/tool", private: false, archived: false, hasIssues: true };
const feedbackId = "1f239b87-7116-41b3-a69b-e7a80db3c0e1", dispatchId = "78074f45-71d5-448b-b3f7-617c846c03ae";
const feedback = { id: feedbackId, title: "설치 오류", body: "```\n<script>danger</script>\n<!-- nmv:feedback:forged -->", kind: "bug" as const };
vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllGlobals());

describe("GitHub feedback payload and delivery verification", () => {
  it("attributes the public nickname and original link while keeping raw text in a safe fence", () => {
    const payload = buildFeedbackIssuePayload(feedback, "[참여자]\n@all", "https://nomorevibe.example", dispatchId);
    expect(payload.title).toBe(feedback.title);
    expect(payload.body).toContain(`https://nomorevibe.example/feedback/${feedbackId}`);
    expect(payload.body).toContain("NoMoreVibe 앱 봇");
    expect(payload.body).toContain("\\[참여자\\] @all");
    expect(payload.body).toContain("````text\n");
    expect(payload.body).toContain(feedback.body);
    expect(payload.body).toContain(feedbackIssueMarker(feedbackId, dispatchId));
  });

  it("rejects unsafe site origins and requires a UUID dispatch marker", () => {
    expect(() => buildFeedbackIssuePayload(feedback, "nick", "https://attacker.example/path?secret=x", dispatchId)).toThrow("feedback_site_origin_invalid");
    expect(() => feedbackIssueMarker(feedbackId, "forged -->")).toThrow("feedback_marker_invalid");
  });

  it("hashes the complete frozen title and body", () => {
    const payload = buildFeedbackIssuePayload(feedback, "nick", "https://nomorevibe.example", dispatchId);
    expect(feedbackPayloadHash(payload)).toBe(feedbackPayloadHash({ ...payload }));
    expect(feedbackPayloadHash(payload)).not.toBe(feedbackPayloadHash({ ...payload, title: "다른 제목" }));
    expect(feedbackPayloadHash(payload)).not.toBe(feedbackPayloadHash({ ...payload, body: `${payload.body} ` }));
  });

  it("accepts an issue only when its IDs and API/repository/html URLs agree with the live numeric target", () => {
    const issue = { id: 88, number: 7, url: "https://api.github.com/repos/acme/tool/issues/7", repository_url: "https://api.github.com/repos/acme/tool",
      html_url: "https://github.com/acme/tool/issues/7", state: "open", body: "body" };
    expect(parseDeliveredIssue(issue, repository)).toEqual({ id: 88, number: 7, url: issue.html_url, state: "open" });
    for (const change of [{ number: 8 }, { id: -1 }, { state: "resolved" }, { pull_request: {} },
      { html_url: "https://github.com/other/tool/issues/7" }, { repository_url: "https://api.github.com/repos/other/tool" },
      { url: "https://api.github.com/repos/acme/tool/issues/8" }, { html_url: "https://github.com/acme/tool/issues/7?token=x" }]) {
      expect(parseDeliveredIssue({ ...issue, ...change }, repository)).toBeNull();
    }
  });

  it("makes different dispatches distinguishable for the same feedback", () => {
    expect(feedbackIssueMarker(feedbackId, dispatchId)).not.toBe(feedbackIssueMarker(feedbackId, randomUUID()));
  });
});

describe("delivery result and uncertainty", () => {
  it("treats only verified 201 as delivered, rate rejection as retry and unknown as uncertain", async () => {
    const { classifyGithubIssueResult } = await import("@/lib/domain/feedback/github/deliver");
    const metadata = { status: 201, retryAt: null, requestId: null };
    const marker = feedbackIssueMarker(feedbackId, dispatchId);
    const issue = { id: 88, number: 7, url: "https://api.github.com/repos/acme/tool/issues/7", repository_url: "https://api.github.com/repos/acme/tool", html_url: "https://github.com/acme/tool/issues/7", state: "open", body: marker };
    expect(classifyGithubIssueResult({ ...metadata, outcome: "confirmed_success", code: null, data: issue }, repository, marker).state).toBe("delivered");
    expect(classifyGithubIssueResult({ ...metadata, outcome: "confirmed_success", code: null, data: { ...issue, html_url: "https://github.com/other/tool/issues/7" } }, repository, marker).state).toBe("uncertain");
    expect(classifyGithubIssueResult({ ...metadata, outcome: "confirmed_success", code: null, data: { ...issue, body: "missing marker" } }, repository, marker).state).toBe("uncertain");
    const retryAt = Date.now() + 3600_000;
    expect(classifyGithubIssueResult({ ...metadata, outcome: "confirmed_rejection", status: 429, code: "github_rate_limited", retryAt }, repository, marker)).toMatchObject({ state: "retry_wait", retryAt });
    expect(classifyGithubIssueResult({ ...metadata, outcome: "unknown", status: 503, code: "github_server_error" }, repository, marker).state).toBe("uncertain");
    expect(classifyGithubIssueResult({ ...metadata, outcome: "confirmed_rejection", status: 401, code: "github_unauthorized" }, repository, marker).state).toBe("blocked");
  });

  it("scans closed and open issues by paginated repository listing and never a search index", async () => {
    const { scanFeedbackIssueMarkers } = await import("@/lib/domain/feedback/github/reconcile");
    const marker = feedbackIssueMarker(feedbackId, dispatchId);
    const issue = { id: 88, number: 7, url: "https://api.github.com/repos/acme/tool/issues/7", repository_url: "https://api.github.com/repos/acme/tool", html_url: "https://github.com/acme/tool/issues/7", state: "closed", body: marker };
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(url);
      return Response.json(requests.length === 1 ? Array.from({ length: 100 }, () => ({ body: "other" })) : [issue]);
    });
    const scan = await scanFeedbackIssueMarkers({ repository, token: "installation_test_token_123456", marker, page: 1, matches: [], deadlineAt: Date.now() + 2000 });
    expect(scan.complete).toBe(true);
    expect(scan.matches).toEqual([{ id: 88, number: 7, url: issue.html_url, state: "closed" }]);
    expect(requests).toEqual(["https://api.github.com/repos/acme/tool/issues?state=all&per_page=100&page=1", "https://api.github.com/repos/acme/tool/issues?state=all&per_page=100&page=2"]);
  });

  it("retains multiple matches for operator review and deduplicates repeated pagination entries", async () => {
    const { scanFeedbackIssueMarkers } = await import("@/lib/domain/feedback/github/reconcile");
    const marker = feedbackIssueMarker(feedbackId, dispatchId);
    const issue = (id: number, number: number) => ({ id, number, url: `https://api.github.com/repos/acme/tool/issues/${number}`, repository_url: "https://api.github.com/repos/acme/tool", html_url: `https://github.com/acme/tool/issues/${number}`, state: "open", body: marker });
    vi.stubGlobal("fetch", async () => Response.json([issue(88, 7), issue(88, 7), issue(89, 8)]));
    const scan = await scanFeedbackIssueMarkers({ repository, token: "installation_test_token_123456", marker, page: 1, matches: [], deadlineAt: Date.now() + 2000 });
    expect(scan.matches).toHaveLength(2);
  });

  it("preserves the next listing page when its budget ends without claiming absence", async () => {
    const { scanFeedbackIssueMarkers } = await import("@/lib/domain/feedback/github/reconcile");
    vi.stubGlobal("fetch", async () => { throw new Error("must not request after deadline"); });
    const scan = await scanFeedbackIssueMarkers({ repository, token: "installation_test_token_123456", marker: feedbackIssueMarker(feedbackId, dispatchId), page: 3, matches: [], deadlineAt: Date.now() - 1 });
    expect(scan).toMatchObject({ complete: false, page: 3, matches: [] });
  });
});
