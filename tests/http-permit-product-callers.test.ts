import { beforeEach, expect, it, vi } from "vitest";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
const mock = vi.hoisted(() => ({ fetchPage: vi.fn(), safeFetch: vi.fn(), readBodyCapped: vi.fn(),
  findByUrl: vi.fn(), findBySlug: vi.fn(), insert: vi.fn(), nextAvailableSlug: vi.fn(), setOgImage: vi.fn(), putOgImage: vi.fn(), markVerified: vi.fn(), requestJob: vi.fn() }));
vi.mock("@/lib/net/fetch", () => ({ fetchPage: mock.fetchPage, safeFetch: mock.safeFetch, readBodyCapped: mock.readBodyCapped }));
vi.mock("@/lib/net/ssrf", () => ({ allowPrivate: () => false, assertPublicUrl: async () => ({ ok: true }) }));
vi.mock("@/lib/domain/products/repository", () => mock);
vi.mock("@/lib/domain/products/view", () => ({ isUnclaimed: () => true }));
vi.mock("@/lib/jobs/control", () => ({ requestJob: mock.requestJob }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { registerProduct } from "@/lib/domain/products/register";
import { verifyProduct } from "@/lib/domain/products/verify";
import { cacheOgImage } from "@/lib/domain/products/og";
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => true, clientIp: () => "fixture" }));
import { POST as registerRoute } from "@/app/api/products/route";
import { POST as verifyRoute } from "@/app/api/products/[slug]/verify/route";
const input = { url: "https://permit.example", name: "Example", tagline: "Useful", description: "Useful service", category: "Productivity" as const };
const page = { status: 200, html: "<title>Example</title>", finalUrl: input.url };
const blocked = new HttpOriginPermitError("waiting_aborted");
beforeEach(() => {
  vi.resetAllMocks();
  mock.nextAvailableSlug.mockResolvedValue("example");
  mock.findBySlug.mockResolvedValue({ id: 1, slug: "example", url: input.url, status: "unverified", verifyToken: "proof", source: "crawler", claimedAt: null });
  mock.fetchPage.mockResolvedValue(page);
  mock.requestJob.mockResolvedValue(undefined);
});
it("register forwards a permit hold without recording an unreachable site or inserting", async () => {
  mock.fetchPage.mockRejectedValue(blocked);
  await expect(registerProduct(input)).rejects.toBe(blocked);
  expect(mock.insert).not.toHaveBeenCalled();
});
it.each([0, 1])("verification forwards permit hold at probe %i without failure or ownership writes", async probe => {
  mock.fetchPage.mockResolvedValue({ ...page, status: 404, html: "" });
  if (probe === 0) mock.fetchPage.mockRejectedValueOnce(blocked);
  else mock.fetchPage.mockResolvedValueOnce({ ...page, status: 404 }).mockRejectedValueOnce(blocked);
  await expect(verifyProduct("example")).rejects.toBe(blocked);
  expect(mock.fetchPage).toHaveBeenCalledTimes(probe + 1);
  expect(mock.markVerified).not.toHaveBeenCalled();
});
it("OG holds propagate without a cache write", async () => {
  mock.safeFetch.mockRejectedValue(blocked);
  await expect(cacheOgImage("https://permit.example/icon.png", "example")).rejects.toBe(blocked);
  expect(mock.putOgImage).not.toHaveBeenCalled();
});
it("a post-insert optional OG hold preserves the issued edit token and thumbnail request", async () => {
  mock.fetchPage.mockResolvedValue({ ...page, html: '<meta property="og:image" content="https://permit.example/icon.png">' });
  mock.safeFetch.mockRejectedValue(blocked);
  const result = await registerProduct(input);
  expect(result).toMatchObject({ ok: true, value: { slug: "example", editToken: expect.stringMatching(/^nmv_edit_/) } });
  expect(mock.insert).toHaveBeenCalledTimes(1);
  expect(mock.setOgImage).not.toHaveBeenCalled();
  expect(mock.requestJob).toHaveBeenCalledWith("product-thumbnail-refresh");
});
it.each(["register", "verify"])("%s actual public route returns temporary 503 without calling the site dead", async kind => {
  mock.fetchPage.mockRejectedValue(blocked);
  const request = new Request("https://nomorevibe.example/api/products", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
  const response = kind === "register" ? await registerRoute(request, { params: Promise.resolve({}) })
    : await verifyRoute(request, { params: Promise.resolve({ slug: "example" }) });
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toMatch(/permit|origin|verification_failed|unverified|접속할 수 없/);
  expect(response.headers.get("x-request-id")).toBe(body.request_id);
});
it("ordinary registration connection failures remain unreachable", async () => {
  mock.fetchPage.mockRejectedValue(new Error("connection reset"));
  expect(await registerProduct(input)).toMatchObject({ ok: false, error: { kind: "unreachable" } });
});
it("ordinary missing verification proof and OG failures keep their original results", async () => {
  mock.fetchPage.mockResolvedValue({ ...page, status: 404, html: "" });
  expect(await verifyProduct("example")).toMatchObject({ ok: false, error: { kind: "verification_failed" } });
  mock.safeFetch.mockRejectedValue(new Error("connection reset"));
  expect(await cacheOgImage("https://permit.example/icon.png", "example")).toBeNull();
});

it("the actual registration route keeps its 201 and issued keys after an optional OG hold", async () => {
  mock.fetchPage.mockResolvedValue({ ...page, html: '<meta property="og:image" content="https://permit.example/icon.png">' });
  mock.safeFetch.mockRejectedValue(blocked);
  const response = await registerRoute(new Request("https://nomorevibe.example/api/products", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }), { params: Promise.resolve({}) });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ slug: "example", edit_token: expect.stringMatching(/^nmv_edit_/), verify_token: expect.any(String) });
  expect(mock.insert).toHaveBeenCalledTimes(1);
});
