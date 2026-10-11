import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createHmac } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { feedbackFingerprint, initialFeedbackReview, normalizedFeedbackBodyHash, validateFeedbackWrite } from "@/lib/domain/feedback/contract";

const valid = {
  requestId: "aa879b44-32ed-4356-8823-8454c0f905e1", kind: "bug", title: "설치 오류",
  body: "<script>alert('raw')</script> 설치가 실패합니다.", serviceDisclosureConsent: true,
  sendToGithub: false, githubDisclosureConsent: false,
};

describe("feedback contract", () => {
  it("keeps the author's original text and separate disclosure consents", () => {
    expect(validateFeedbackWrite(valid)).toEqual(valid);
  });

  it.each([
    { requestId: "bad" }, { kind: "other" }, { title: " " }, { title: "x".repeat(121) },
    { body: "\n " }, { body: "x".repeat(5001) }, { serviceDisclosureConsent: false },
    { sendToGithub: true, githubDisclosureConsent: false }, { sendToGithub: "false" },
    { githubDisclosureConsent: "true" },
  ])("rejects malformed or missing consent input #%#", (change) => {
    expect(() => validateFeedbackWrite({ ...valid, ...change })).toThrow(/feedback_invalid/);
  });

  it("accepts all supported kinds and the exact length boundaries", () => {
    for (const kind of ["bug", "feature", "question"]) {
      expect(validateFeedbackWrite({ ...valid, kind, title: "x".repeat(120), body: "x".repeat(5000) }).kind).toBe(kind);
    }
    expect(validateFeedbackWrite({ ...valid, title: "x", body: "x" }).body).toBe("x");
  });

  it("uses normalized body content only for repeat moderation", () => {
    expect(normalizedFeedbackBodyHash("  ＡＢＣ\n설치    오류 ")).toBe(normalizedFeedbackBodyHash("ABC 설치 오류"));
    expect(normalizedFeedbackBodyHash("ABC 설치 오류")).not.toBe(normalizedFeedbackBodyHash("다른 오류"));
  });

  it("holds four http(s) links or a recent normalized duplicate", () => {
    expect(initialFeedbackReview("https://a.test http://b.test https://c.test", false)).toEqual({ state: "accepted", reason: null });
    expect(initialFeedbackReview("https://a.test http://b.test https://c.test https://d.test", false)).toEqual({ state: "held", reason: "too_many_urls" });
    expect(initialFeedbackReview("설치 오류", true)).toEqual({ state: "held", reason: "repeated_body" });
  });

  it("counts adjacent URL schemes across the title and body for moderation", () => {
    expect(initialFeedbackReview("https://a.test,https://b.test,https://c.test,https://d.test", false)).toMatchObject({ state: "held", reason: "too_many_urls" });
    expect(initialFeedbackReview("https://a.test https://b.test", false, "https://c.test,https://d.test")).toMatchObject({ state: "held", reason: "too_many_urls" });
  });

  it("fingerprints every disclosed field and product to detect changed-key replay", () => {
    const input = validateFeedbackWrite(valid);
    expect(feedbackFingerprint(1, input)).toBe(feedbackFingerprint(1, { ...input }));
    expect(feedbackFingerprint(1, input)).not.toBe(feedbackFingerprint(2, input));
    expect(feedbackFingerprint(1, input)).not.toBe(feedbackFingerprint(1, { ...input, body: `${input.body} ` }));
    expect(feedbackFingerprint(1, input)).not.toBe(feedbackFingerprint(1, { ...input, githubDisclosureConsent: true }));
  });
});

const requestMocks = vi.hoisted(() => ({ mutation: vi.fn(), session: vi.fn(), submit: vi.fn(), productList: vi.fn(), mine: vi.fn(),
  lookup: vi.fn(), admin: vi.fn(), review: vi.fn(), headerList: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/domain/accounts/request-auth", () => {
  class PublicAuthError extends Error { constructor(public status: number, public code: string) { super(code); } }
  return { PublicAuthError, requirePublicMutation: requestMocks.mutation, getPublicSession: requestMocks.session,
    publicAuthErrorResponse: (error: PublicAuthError) => Response.json({ error: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store" } }) };
});
vi.mock("@/lib/domain/feedback/submit", () => ({ submitFeedback: requestMocks.submit }));
vi.mock("@/lib/domain/feedback/repository", () => ({ listProductFeedback: requestMocks.productList, listMyFeedback: requestMocks.mine, getFeedback: requestMocks.lookup }));
vi.mock("@/lib/domain/feedback/review", () => ({ reviewFeedback: requestMocks.review }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: requestMocks.admin, authSecret: () => "a".repeat(32), adminLocalLoginEnabled: () => false, LOCAL_ADMIN_LOGIN: "local" }));
vi.mock("next/headers", () => ({ headers: requestMocks.headerList }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("feedback request boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "true");
    requestMocks.admin.mockResolvedValue(null);
    requestMocks.headerList.mockResolvedValue(new Headers({ origin: "https://nomorevibe.example" }));
    requestMocks.session.mockResolvedValue(null);
  });

  it("requires a public session for submission and never trusts a supplied author", async () => {
    const { POST } = await import("@/app/api/products/[slug]/feedback/route");
    const { PublicAuthError } = await import("@/lib/domain/accounts/request-auth");
    requestMocks.mutation.mockRejectedValue(new PublicAuthError(401, "login_required"));
    const request = () => new Request("https://nomorevibe.example/api/products/tool/feedback", { method: "POST", body: JSON.stringify({ ...valid, authorUserId: 999 }) });
    const denied = await POST(request(), { params: Promise.resolve({ slug: "tool" }) });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
    expect(requestMocks.submit).not.toHaveBeenCalled();
    requestMocks.mutation.mockResolvedValue({ id: 7, displayName: "user" });
    requestMocks.submit.mockResolvedValue({ feedback: { id: valid.requestId }, replayed: false });
    requestMocks.lookup.mockResolvedValue({ id: valid.requestId, deliveryState: "local_only" });
    const accepted = await POST(request(), { params: Promise.resolve({ slug: "tool" }) });
    expect(accepted.status).toBe(201);
    expect(requestMocks.submit).toHaveBeenCalledWith("tool", 7, expect.objectContaining({ authorUserId: 999 }));
  });

  it("keeps public and personal feedback responses private and disables routes when flagged off", async () => {
    const { GET } = await import("@/app/api/products/[slug]/feedback/route");
    const mine = await import("@/app/api/me/feedback/route");
    requestMocks.productList.mockResolvedValue([]);
    const response = await GET(new Request("https://nomorevibe.example/api/products/tool/feedback"), { params: Promise.resolve({ slug: "tool" }) });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await mine.GET(new Request("https://nomorevibe.example/api/me/feedback"))).status).toBe(401);
    requestMocks.session.mockResolvedValue({ user: { id: 7, displayName: "user" }, csrfToken: "csrf" });
    requestMocks.mine.mockResolvedValue([]);
    expect((await mine.GET(new Request("https://nomorevibe.example/api/me/feedback"))).headers.get("Cache-Control")).toBe("private, no-store");
    expect(requestMocks.mine).toHaveBeenCalledWith(7);
    requestMocks.mine.mockClear();
    await mine.GET(new Request("https://nomorevibe.example/api/me/feedback?slug=tool"));
    expect(requestMocks.mine).toHaveBeenCalledWith(7, "tool");
    vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "false");
    expect((await GET(new Request("https://nomorevibe.example/api/products/tool/feedback"), { params: Promise.resolve({ slug: "tool" }) })).status).toBe(404);
  });

  it("returns private error JSON when personal authentication or its primary query fails", async () => {
    const { GET } = await import("@/app/api/me/feedback/route");
    requestMocks.session.mockRejectedValue(new Error("database_unavailable"));
    const response = await GET(new Request("https://nomorevibe.example/api/me/feedback"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "feedback_unavailable" });
  });

  it("rejects an oversized streamed body before reading the rest or invoking storage", async () => {
    const { POST } = await import("@/app/api/products/[slug]/feedback/route");
    requestMocks.mutation.mockResolvedValue({ id: 7, displayName: "user" });
    const cancelled = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(40_000)); if (chunks >= 100) controller.close(); },
      cancel: cancelled,
    }, { highWaterMark: 0 });
    const request = new Request("https://nomorevibe.example/api/products/tool/feedback", { method: "POST", body, duplex: "half" } as RequestInit);
    const response = await POST(request, { params: Promise.resolve({ slug: "tool" }) });
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(chunks).toBe(1);
    expect(requestMocks.submit).not.toHaveBeenCalled();
  });

  it("does not allow a general account to review feedback", async () => {
    const { reviewFeedbackAction } = await import("@/app/admin/feedback/actions");
    const form = new FormData();
    form.set("id", valid.requestId); form.set("decision", "accepted"); form.set("reason", "승인");
    await expect(reviewFeedbackAction(form)).rejects.toThrow("unauthorized");
    expect(requestMocks.review).not.toHaveBeenCalled();
  });

  it("requires the administrator's bound nonce and exact configured origin", async () => {
    const { reviewFeedbackAction } = await import("@/app/admin/feedback/actions");
    const admin = { login: "reviewer", exp: Math.floor(Date.now() / 1000) + 3600 };
    requestMocks.admin.mockResolvedValue(admin);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
    const form = new FormData();
    form.set("id", valid.requestId); form.set("decision", "accepted"); form.set("reason", "검토 완료");
    form.set("csrfExpiresAt", String(admin.exp));
    await expect(reviewFeedbackAction(form)).rejects.toThrow("forbidden");
    form.set("csrfToken", createHmac("sha256", "a".repeat(32)).update(`feedback-admin:${admin.login}:${admin.exp}`).digest("hex"));
    requestMocks.headerList.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(reviewFeedbackAction(form)).rejects.toThrow("forbidden");
    expect(requestMocks.review).not.toHaveBeenCalled();
    requestMocks.headerList.mockResolvedValue(new Headers({ origin: "https://nomorevibe.example" }));
    form.set("csrfExpiresAt", String(admin.exp - 1));
    await expect(reviewFeedbackAction(form)).rejects.toThrow("forbidden");
    form.set("csrfExpiresAt", String(admin.exp));
    await reviewFeedbackAction(form);
    expect(requestMocks.review).toHaveBeenCalledWith({ id: valid.requestId, decision: "accepted", reason: "검토 완료", adminLogin: "reviewer" });
  });

  it("renders original HTML as escaped text", async () => {
    const { FeedbackItem } = await import("@/components/product-detail/FeedbackList");
    const markup = renderToStaticMarkup(createElement(FeedbackItem, { feedback: {
      id: valid.requestId, productId: 1, slug: "tool", productName: "Tool", authorUserId: 1, authorDisplayName: "<b>user</b>",
      kind: "bug", title: "<img src=x onerror=alert(1)>", body: valid.body, reviewState: "accepted", reviewReason: null,
      deliveryState: "local_only", createdAt: "2026-10-11T00:00:00.000Z",
    } }));
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
  });
});
