import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/jobs/control", () => ({ requestJob: mocks.request }));
// Loading an executable registry from this route would violate the HTTP boundary.
vi.mock("@/lib/jobs/registry", () => { throw new Error("collector imported by cron"); });
import { POST } from "@/app/api/cron/[job]/route";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("cron request boundary", () => {
  it("does not accept scheduler observation as a request with no consumer", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    const response = await POST(new Request("http://localhost/api/cron/heartbeat", {
      method: "POST", headers: { authorization: "Bearer test-secret" },
    }), { params: Promise.resolve({ job: "heartbeat" }) });
    expect(response.status).toBe(400);
    expect((await response.json()).available).not.toContain("heartbeat");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("requires authentication before queueing", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    const response = await POST(new Request("http://localhost/api/cron/crawl-fetch", { method: "POST" }), { params: Promise.resolve({ job: "crawl-fetch" }) });
    expect(response.status).toBe(403); expect(mocks.request).not.toHaveBeenCalled();
  });
  it("rejects unknown names and returns a receipt for a known job", async () => {
    vi.stubEnv("CRON_SECRET", "test-secret");
    const request = () => new Request("http://localhost/api/cron/crawl-fetch", { method: "POST", headers: { authorization: "Bearer test-secret" } });
    expect((await POST(request(), { params: Promise.resolve({ job: "unknown" }) })).status).toBe(404);
    expect(mocks.request).not.toHaveBeenCalled();
    const receipt = { job: "crawl-fetch", status: "queued", requestedVersion: 3 };
    mocks.request.mockResolvedValue(receipt);
    const response = await POST(request(), { params: Promise.resolve({ job: "crawl-fetch" }) });
    expect(response.status).toBe(202); expect(await response.json()).toEqual(receipt);
  });
});
