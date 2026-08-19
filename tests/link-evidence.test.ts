import { describe, expect, it, vi } from "vitest";
import { fetchCapped, type CappedFetchResult } from "@/lib/net/fetch";
import {
  verifyAppStoreLink,
  verifyChangelogLink,
  verifyPackageLink,
  verifyPlayStoreLink,
} from "@/lib/domain/evidence/providers/links";

const ok = (body: unknown, finalUrl = "https://example.com"): CappedFetchResult => ({
  ok: true,
  status: 200,
  finalUrl,
  headers: new Headers({ "content-type": "application/json" }),
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});

describe("capped external fetch", () => {
  it("rejects a declared Content-Length above the cap before reading the body", async () => {
    const result = await fetchCapped("https://example.com/large", {
      maxBytes: 5,
      request: async () => new Response("small", {
        status: 200,
        headers: { "content-length": "500" },
      }),
    });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("rejects a streamed body above the cap instead of keeping a truncated success", async () => {
    const result = await fetchCapped("https://example.com/stream", {
      maxBytes: 4,
      request: async () => new Response("12345", { status: 200 }),
    });
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it("re-checks every redirect and rejects a redirect to a private address", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/latest/meta-data" },
    }));
    const result = await fetchCapped("https://example.com/start", { maxBytes: 32, request });
    expect(result).toEqual({ ok: false, reason: "unsafe_url" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns explicit http and timeout failures", async () => {
    await expect(fetchCapped("https://example.com/missing", {
      maxBytes: 32,
      request: async () => new Response("missing", { status: 404 }),
    })).resolves.toEqual({ ok: false, reason: "http", status: 404 });

    await expect(fetchCapped("https://example.com/slow", {
      maxBytes: 32,
      request: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    })).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  it("returns an explicit timeout when reading the response stream times out", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new DOMException("timed out", "TimeoutError"));
      },
    });
    await expect(fetchCapped("https://example.com/slow-body", {
      maxBytes: 32,
      request: async () => new Response(body, { status: 200 }),
    })).resolves.toEqual({ ok: false, reason: "timeout" });
  });
});

describe("official link evidence", () => {
  it("maps an Apple lookup ID match to official-source facts", async () => {
    const request = vi.fn(async (url: string) => ok({
      resultCount: 1,
      results: [{
        trackId: 123456,
        trackName: "Simple HWP",
        bundleId: "app.simplehwp",
        version: "1.6.0",
        currentVersionReleaseDate: "2026-08-14T00:00:00Z",
        trackViewUrl: "https://apps.apple.com/app/id123456",
        sellerName: "Simple Tools",
      }],
    }, url));

    await expect(verifyAppStoreLink("https://apps.apple.com/kr/app/simple-hwp/id123456", request))
      .resolves.toMatchObject({
        type: "app_store",
        provider: "apple",
        appId: "123456",
        name: "Simple HWP",
        version: "1.6.0",
        evidenceLabel: "공식 출처에서 확인",
      });
    expect(request).toHaveBeenCalledWith(
      "https://itunes.apple.com/lookup?id=123456",
      expect.objectContaining({ maxBytes: expect.any(Number) }),
    );
  });

  it("labels Play Store reachability as a link check, not verified official metadata", async () => {
    const request = vi.fn(async () => ok("<html></html>", "https://play.google.com/store/apps/details?id=app.simplehwp"));
    const result = await verifyPlayStoreLink(
      "https://play.google.com/store/apps/details?id=app.simplehwp",
      request,
    );
    expect(result).toMatchObject({
      type: "link",
      provider: "google_play",
      packageId: "app.simplehwp",
      evidenceLabel: "링크 확인",
    });
    expect(JSON.stringify(result)).not.toContain("공식 출처에서 확인");
  });

  it.each([
    ["npm", "https://www.npmjs.com/package/@scope/tool", "https://registry.npmjs.org/%40scope%2Ftool", { name: "@scope/tool", version: "2.0.0" }],
    ["pypi", "https://pypi.org/project/Simple-HWP", "https://pypi.org/pypi/simple-hwp/json", { name: "simple-hwp", version: "1.4.0" }],
    ["crates", "https://crates.io/crates/simple-hwp", "https://crates.io/api/v1/crates/simple-hwp", { name: "simple-hwp", version: "0.8.0" }],
  ] as const)("validates %s packages only through the official registry endpoint", async (kind, link, endpoint, expected) => {
    const request = vi.fn(async (url: string) => {
      if (kind === "npm") return ok({ name: "@scope/tool", "dist-tags": { latest: "2.0.0" } }, url);
      if (kind === "pypi") return ok({ info: { name: "simple-hwp", version: "1.4.0" } }, url);
      return ok({ crate: { name: "simple-hwp", max_version: "0.8.0" } }, url);
    });
    await expect(verifyPackageLink(kind, link, request)).resolves.toMatchObject({
      type: "package",
      registry: kind,
      ...expected,
      evidenceLabel: "공식 출처에서 확인",
    });
    expect(request).toHaveBeenCalledWith(endpoint, expect.any(Object));
  });

  it("rejects non-official package hosts and treats a changelog as reachability only", async () => {
    const request = vi.fn(async (url: string) => ok("ok", url));
    await expect(verifyPackageLink("npm", "https://evil.example/package/tool", request))
      .rejects.toThrow("invalid npm link");
    expect(request).not.toHaveBeenCalled();

    await expect(verifyChangelogLink("https://product.example/changelog", request)).resolves.toEqual({
      type: "link",
      provider: "product_changelog",
      url: "https://product.example/changelog",
      evidenceLabel: "링크 확인",
    });
  });
});
