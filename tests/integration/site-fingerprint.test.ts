import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { evidenceSettings, jobs, productEvidenceSources, products } from "@/lib/db/schema";
import { refreshSiteFingerprint } from "@/lib/domain/evidence/providers/site-fingerprint";
import { upsertObservedSource } from "@/lib/domain/evidence/repository";
import { ensureSchema, resetTables } from "./setup";

const NOW = new Date("2026-10-14T00:00:00Z");
const INPUT = { slug: "site-cache", productId: 1, url: "https://site-cache.example" };
const body = Buffer.from('<a href="https://github.com/owner/repo">Source code</a>');
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(jobs);
  await db.insert(products).values({ slug: INPUT.slug, url: INPUT.url, name: "Site cache", tagline: "Evidence",
    description: "Evidence", category: "Dev", status: "verified", verifyToken: "site", editTokenHash: "a".repeat(64) });
});
const source = () => db.query.productEvidenceSources.findFirst({ where: eq(productEvidenceSources.slug, INPUT.slug) });

describe("canonical site cache", () => {
  it("awaits actual fetch settlement after a synchronous preflight abort", async () => {
    const controller = new AbortController();
    let settle!: (value: { ok: false; reason: "timeout" }) => void;
    const fetch = vi.fn(async () => { controller.abort(); return new Promise<{ ok: false; reason: "timeout" }>(resolve => { settle=resolve; }); });
    let settled=false;
    const work=refreshSiteFingerprint(INPUT, { now: NOW, fetch, signal: controller.signal }).finally(()=>{settled=true;});
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    settle({ok:false,reason:"timeout"});
    expect(await Promise.race([work,new Promise(resolve=>setTimeout(()=>resolve("hung"),150))])).toBe("budget_exhausted");
    await work;
    expect(await source()).toBeUndefined();
  });

  it("fences site observations after job ownership is lost during a fetch", async () => {
    const lease = { name: "site-evidence-fence", token: "first-owner", requestedVersion: 0 };
    await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date() });
    const fetch = vi.fn(async () => {
      await db.update(jobs).set({ leaseToken: "next-owner" }).where(eq(jobs.name, lease.name));
      await upsertObservedSource({ slug: INPUT.slug, kind: "documentation", provider: "product_site", sourceKey: "canonical_site",
        sourceUrl: INPUT.url, state: "ok", normalizedFacts: { type: "site_fingerprint", repositoryKeys: ["owner/new-repo"] } });
      return { ok: true as const, status: 200, finalUrl: INPUT.url, headers: new Headers(), body };
    });
    await expect(refreshSiteFingerprint(INPUT, { now: NOW, fetch, lease })).rejects.toThrow("job_lease_lost");
    expect((await source())?.normalizedFacts?.repositoryKeys).toEqual(["owner/new-repo"]);
  });

  it("fetches a new body when a 304 redirects to a different final URL", async () => {
    const movedUrl = `${INPUT.url}/moved`;
    const movedBody = Buffer.from('<a href="https://github.com/owner/new-repo">Source code</a>');
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, finalUrl: INPUT.url,
      headers: new Headers({ etag: '"site-v1"' }), body }).mockResolvedValueOnce({ ok: true, status: 304,
      finalUrl: movedUrl, headers: new Headers(), body: Buffer.alloc(0) }).mockResolvedValueOnce({ ok: true,
      status: 200, finalUrl: movedUrl, headers: new Headers({ etag: '"site-v2"' }), body: movedBody });
    await refreshSiteFingerprint(INPUT, { now: NOW, fetch });
    expect(await refreshSiteFingerprint(INPUT, { now: new Date(NOW.getTime() + 86400000), fetch })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2][1].headers).toEqual({});
    expect((await source())?.normalizedFacts).toMatchObject({ finalUrl: movedUrl, repositoryKeys: ["owner/new-repo"] });
  });

  it("bounds preflight and in-flight fetch by the shared deadline without recording a false site failure", async () => {
    const fetch = vi.fn(async (_url: string, options: { signal?: AbortSignal }) => new Promise<{ ok: false; reason: "timeout" }>(resolve => {
      options.signal!.addEventListener("abort", () => resolve({ ok: false, reason: "timeout" }), { once: true });
    }));
    const started = Date.now();
    const result = await refreshSiteFingerprint(INPUT, { now: NOW, fetch, deadlineAt: started + 100 } as Parameters<typeof refreshSiteFingerprint>[1]);
    expect(result).toBe("budget_exhausted");
    expect(Date.now() - started).toBeLessThan(500);
    expect(await source()).toBeUndefined();
  });

  it("reuses a versioned last-good fingerprint on 304 and stores body digest and validators", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, finalUrl: INPUT.url,
      headers: new Headers({ etag: '"site-v1"' }), body }).mockResolvedValueOnce({ ok: true, status: 304,
      finalUrl: INPUT.url, headers: new Headers({ etag: '"site-v1"' }), body: Buffer.alloc(0) });
    expect(await refreshSiteFingerprint(INPUT, { now: NOW, fetch })).toBe(true);
    const first = await source();
    expect(first?.normalizedFacts).toMatchObject({ repositoryKeys: ["owner/repo"], bodyDigest: expect.stringMatching(/^[0-9a-f]{64}$/), parserVersion: 1 });
    const later = new Date(NOW.getTime() + 86400000);
    expect(await refreshSiteFingerprint(INPUT, { now: later, fetch })).toBe(true);
    expect(fetch.mock.calls[1][1]).toMatchObject({ acceptNotModified: true, headers: { "If-None-Match": '"site-v1"' } });
    expect((await source())?.normalizedFacts).toEqual(first?.normalizedFacts);
    expect((await source())?.lastSuccessAt).toEqual(later);
  });

  it("retries a 304 without a compatible parsed fingerprint unconditionally", async () => {
    await upsertObservedSource({ slug: INPUT.slug, kind: "documentation", provider: "product_site", sourceKey: "canonical_site",
      sourceUrl: INPUT.url, state: "ok", etag: '"legacy"', normalizedFacts: { type: "site_fingerprint", repositoryKeys: [] }, nextAttemptAt: NOW });
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 304, finalUrl: INPUT.url, headers: new Headers(), body: Buffer.alloc(0) })
      .mockResolvedValueOnce({ ok: true, status: 200, finalUrl: INPUT.url, headers: new Headers(), body });
    expect(await refreshSiteFingerprint(INPUT, { now: NOW, fetch })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers).toEqual({});
    expect((await source())?.normalizedFacts?.repositoryKeys).toEqual(["owner/repo"]);
  });

  it("counts failures and follows configured bounded retry without erasing cached facts", async () => {
    await db.insert(evidenceSettings).values({ id: 1, values: { maxRetries: 2 } });
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, finalUrl: INPUT.url, headers: new Headers(), body })
      .mockResolvedValue({ ok: false, reason: "timeout" });
    await refreshSiteFingerprint(INPUT, { now: NOW, fetch });
    const first = new Date(NOW.getTime() + 86400000);
    await refreshSiteFingerprint(INPUT, { now: first, fetch });
    await refreshSiteFingerprint(INPUT, { now: new Date(first.getTime() + 6 * 3600000), fetch });
    expect(await source()).toMatchObject({ attempts: 2, lastErrorCode: "site_timeout",
      nextAttemptAt: new Date(first.getTime() + 18 * 3600000), normalizedFacts: { repositoryKeys: ["owner/repo"] } });
  });
});
