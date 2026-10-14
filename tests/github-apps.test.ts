import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { appCollectorTokens, appJwt, clearAppTokenCache, inspectGitHubApp, mintInstallationToken } from "@/lib/crawl/github-apps";
import { seal } from "@/lib/operations/credential-vault";

const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select } }));

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearAppTokenCache(); });

it("does not mint tokens after cancellation during the app-account database read", async () => {
  const controller = new AbortController();
  const secret = "s".repeat(48);
  const row = { installationId: 456, appId: 123, appSlug: "fixture", encryptedPrivateKey: seal(pem, secret) };
  select.mockReset().mockReturnValueOnce({ from: () => ({ where: async () => { controller.abort(); return [row]; } }) });
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "ghs_fixture_token_1234567890", expires_at: new Date(Date.now() + 3600000).toISOString() }), { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await appCollectorTokens(secret, Date.now(), { signal: controller.signal } as Parameters<typeof appCollectorTokens>[2])).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("forwards abort to a mint request without poisoning the installation cache", async () => {
  const controller = new AbortController();
  const secret = "s".repeat(48);
  const row = { installationId: 456, appId: 123, appSlug: "fixture", encryptedPrivateKey: seal(pem, secret) };
  select.mockReset().mockReturnValue({ from: () => ({ where: async () => [row] }) });
  let firstSignal: AbortSignal | null | undefined;
  const fetcher = vi.fn().mockImplementationOnce(async (_url, init: RequestInit) => {
    firstSignal = init.signal;
    controller.abort();
    return new Response(JSON.stringify({ token: "ghs_cancelled_token_1234567890", expires_at: new Date(Date.now() + 3600000).toISOString() }), { status: 201 });
  }).mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_fresh_token_1234567890", expires_at: new Date(Date.now() + 3600000).toISOString() }), { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await appCollectorTokens(secret, Date.now(), { signal: controller.signal } as Parameters<typeof appCollectorTokens>[2])).toEqual([]);
  expect(firstSignal?.aborted).toBe(true);
  expect((await appCollectorTokens(secret)).map(token => token.token)).toEqual(["ghs_fresh_token_1234567890"]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("shares the extracted pure JWT signer without changing collector signatures", async () => {
  const pure = await import("@/lib/github/app-jwt").catch(() => ({})) as { appJwt?: typeof appJwt };
  expect(pure.appJwt).toBe(appJwt);
  expect(pure.appJwt?.(123, pem, 1_800_000_000_000)).toBe(appJwt(123, pem, 1_800_000_000_000));
});

it("signs a 9-minute RS256 app JWT that starts a minute early and verifies with the app's public key", () => {
  const token = appJwt(123, pem, 1_800_000_000_000);
  const [header, payload, signature] = token.split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "123" });
  const verify = createVerify("RSA-SHA256");
  verify.update(`${header}.${payload}`);
  expect(verify.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
});

it("mints an installation token and maps GitHub's refusals to reason codes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_installation_token_1234567890", expires_at: "2026-10-10T12:00:00Z" }), { status: 201 })));
  expect(await mintInstallationToken(123, 456, pem)).toEqual({ token: "ghs_installation_token_1234567890", expiresAt: Date.parse("2026-10-10T12:00:00Z") });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 404 })));
  await expect(mintInstallationToken(123, 456, pem)).rejects.toThrow("github_app_installation_missing");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("{}", { status: 401 })));
  await expect(mintInstallationToken(123, 456, pem)).rejects.toThrow("github_app_invalid");
});

it("inspects the app before saving — the key must parse, the app id must match, the installation must exist", async () => {
  await expect(inspectGitHubApp(123, 456, "not a key")).rejects.toThrow("github_app_key_invalid");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: 999, slug: "other" }), { status: 200 })));
  await expect(inspectGitHubApp(123, 456, pem)).rejects.toThrow("github_identity_unavailable");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123, slug: "nmv-collector" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 456, account: { login: "owner" } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ token: "ghs_installation_token_1234567890", expires_at: "2026-10-10T12:00:00Z" }), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 1, remaining: 4999, reset: 1800000000 } } }), { status: 200 })));
  expect(await inspectGitHubApp(123, 456, pem)).toEqual({ appId: 123, appSlug: "nmv-collector", installationId: 456, accountLogin: "owner",
    core: { limit: 5000, used: 1, remaining: 4999, reset: 1800000000 } });
});
