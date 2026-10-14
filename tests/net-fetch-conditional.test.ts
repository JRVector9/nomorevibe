import { expect, it } from "vitest";
import { fetchCapped } from "@/lib/net/fetch";

it("accepts an explicit conditional 304 with an empty body and final URL", async () => {
  const headers = new Headers({ etag: '"unchanged"' });
  const result = await fetchCapped("https://8.8.8.8/start", { maxBytes: 32, acceptNotModified: true,
    request: async url => url.endsWith("/start")
      ? new Response(null, { status: 302, headers: { location: "/page" } })
      : new Response(null, { status: 304, headers }),
  });
  expect(result).toMatchObject({ ok: true, status: 304, finalUrl: "https://8.8.8.8/page", body: Buffer.alloc(0) });
  if (!result.ok) throw new Error(result.reason);
  expect(result.headers.get("etag")).toBe('"unchanged"');
});

it("does not accept 304 without the explicit conditional option", async () => {
  expect(await fetchCapped("https://8.8.8.8/page", { maxBytes: 32,
    request: async () => new Response(null, { status: 304 }),
  })).toEqual({ ok: false, reason: "http", status: 304 });
});
