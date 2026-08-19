import { describe, expect, it, vi } from "vitest";
import { createMediaGet } from "@/lib/domain/media/http";
import type { MediaStorage } from "@/lib/domain/media/storage";

function storage(overrides: Partial<MediaStorage> = {}): MediaStorage {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    deleteIfUnreferenced: vi.fn(async () => false),
    ...overrides,
  };
}

describe("GET /api/media/[hash]", () => {
  const hash = "a".repeat(64);

  it.each(["web", "thumbnail"] as const)("serves the immutable internal %s variant", async (variant) => {
    const bytes = Buffer.from(`stored-${variant}`);
    const media = storage({
      get: vi.fn(async () => ({ data: bytes, mimeType: "image/webp", size: 999_999 })),
    });
    const response = await createMediaGet(media)(
      new Request(`https://nomorevibe.app/api/media/${hash}?variant=${variant}&url=http://127.0.0.1/x`),
      { params: Promise.resolve({ hash }) },
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(media.get).toHaveBeenCalledWith(hash, variant);
  });

  it("returns 404 for an invalid or unknown hash without accepting an external URL", async () => {
    const get = vi.fn(async () => null);
    const handler = createMediaGet(storage({ get }));
    const invalid = await handler(
      new Request("https://nomorevibe.app/api/media/not-a-hash?url=https://evil.example/a.png"),
      { params: Promise.resolve({ hash: "not-a-hash" }) },
    );
    expect(invalid.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    const unknown = await handler(
      new Request(`https://nomorevibe.app/api/media/${hash}`),
      { params: Promise.resolve({ hash }) },
    );
    expect(unknown.status).toBe(404);
    expect(get).toHaveBeenCalledWith(hash, "web");
  });

  it("rejects unknown variants", async () => {
    const get = vi.fn(async () => null);
    const response = await createMediaGet(storage({ get }))(
      new Request(`https://nomorevibe.app/api/media/${hash}?variant=original`),
      { params: Promise.resolve({ hash }) },
    );
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});
