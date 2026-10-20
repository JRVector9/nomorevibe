import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inspectGitHubCollectorToken, collectorTokens, collectorSecret, encryptCollectorToken, decryptCollectorToken, parseCoreQuota, saveGitHubCollectorAccount } from "@/lib/crawl/github-accounts";
import { collectorScope } from "@/lib/crawl/github-secret";
import { logger } from "@/lib/observability/logger";
const { appTokens, select } = vi.hoisted(() => ({ appTokens: vi.fn(), select: vi.fn() }));
vi.mock("@/lib/crawl/github-apps", () => ({ appCollectorTokens: appTokens }));
vi.mock("@/lib/db", () => ({ db: { select } }));

const SCOPE_ENV = ["GITHUB_COLLECTOR_SOURCES", "GITHUB_COLLECTOR_APP_INSTALLATIONS", "GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS"];
// 셸에 서버 범위가 떠 있어도 기본(범위 없음)에서 시작한다 — 필요한 테스트가 스스로 넣는다
beforeEach(() => { for (const name of SCOPE_ENV) vi.stubEnv(name, undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const SECRET = "a".repeat(48);
const patRows = (...rows: { userId: number; login: string; token: string }[]) => ({ from: () => ({ where: () => ({ orderBy: async () =>
  rows.map(({ userId, login, token }) => ({ userId, login, encryptedToken: encryptCollectorToken(token, SECRET) })) }) }) });
const appToken = { token: "ghs_app_fixture_token_1234567890", installationId: 77, login: "fixture (앱)" };

it.each(["accounts", "apps"])("stops token preparation after abort while awaiting %s", async phase => {
  const controller = new AbortController();
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "a".repeat(48));
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  appTokens.mockReset().mockImplementation(async () => { if (phase === "apps") controller.abort(); return []; });
  select.mockReset().mockReturnValueOnce({ from: () => ({ where: () => ({ orderBy: async () => {
    if (phase === "accounts") controller.abort();
    return [];
  } }) }) } as never);
  expect(await collectorTokens({ signal: controller.signal } as Parameters<typeof collectorTokens>[0])).toEqual([]);
  if (phase === "accounts") expect(appTokens).not.toHaveBeenCalled();
  else expect(appTokens.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
});

it("checks identity and quota without returning the PAT", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "OtherOwner" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 12, remaining: 4988, reset: 1800000000 } } }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const result = await inspectGitHubCollectorToken("github_pat_12345678901234567890");
  expect(result).toEqual({ userId: 42, login: "OtherOwner", core: { limit: 5000, used: 12, remaining: 4988, reset: 1800000000 } });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://api.github.com/user", "https://api.github.com/rate_limit"]);
  expect(JSON.stringify(result)).not.toContain("github_pat_");
});

it("rejects an invalid credential without persisting its text", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
  await expect(inspectGitHubCollectorToken("github_pat_12345678901234567890")).rejects.toThrow("github_token_invalid");
});

it("encrypts PATs with the dedicated shared secret", () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "a".repeat(48));
  const secret = collectorSecret();
  const sealed = encryptCollectorToken("github_pat_12345678901234567890", secret);
  expect(sealed).not.toContain("github_pat_");
  expect(decryptCollectorToken(sealed, secret)).toBe("github_pat_12345678901234567890");
  expect(() => decryptCollectorToken(sealed, "b".repeat(48))).toThrow();
});

it("does not replace a different GitHub user when a specific account was selected", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "a".repeat(48));
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "OtherOwner" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 12, remaining: 4988, reset: 1800000000 } } }), { status: 200 })));
  await expect(saveGitHubCollectorAccount("github_pat_12345678901234567890", "admin", 43)).rejects.toThrow("github_account_mismatch");
});

it("rejects absent quota fields instead of displaying false zero usage", () => {
  expect(parseCoreQuota({ limit: 5000, remaining: 0 })).toBeNull();
});

it("reads the host credential scope and rejects malformed values instead of using every credential", () => {
  expect(collectorScope({})).toBeNull();
  expect(collectorScope({ GITHUB_COLLECTOR_SOURCES: "apps", GITHUB_COLLECTOR_APP_INSTALLATIONS: " 12, 34 " }))
    .toEqual({ sources: new Set(["apps"]), onlyInstallations: [12, 34], excludedInstallations: null });
  expect(collectorScope({ GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS: "12" }))
    .toEqual({ sources: new Set(["env", "accounts", "apps"]), onlyInstallations: null, excludedInstallations: [12] });
  expect(collectorScope({ GITHUB_COLLECTOR_SOURCES: "env, accounts" }))
    .toEqual({ sources: new Set(["env", "accounts"]), onlyInstallations: null, excludedInstallations: null });
  const invalid: Record<string, string>[] = [
    { GITHUB_COLLECTOR_SOURCES: "" }, { GITHUB_COLLECTOR_SOURCES: "apps,pat" }, { GITHUB_COLLECTOR_SOURCES: "apps," }, { GITHUB_COLLECTOR_SOURCES: "APPS" },
    { GITHUB_COLLECTOR_APP_INSTALLATIONS: "" }, { GITHUB_COLLECTOR_APP_INSTALLATIONS: "12,,34" }, { GITHUB_COLLECTOR_APP_INSTALLATIONS: "0" },
    { GITHUB_COLLECTOR_APP_INSTALLATIONS: "-1" }, { GITHUB_COLLECTOR_APP_INSTALLATIONS: "1e3" }, { GITHUB_COLLECTOR_APP_INSTALLATIONS: "12abc" },
    { GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS: "99999999999999999999" },
    // 허용과 제외를 함께, 또는 App 을 쓰지 않는 서버에 설치를 고르면 뜻이 둘로 읽힌다
    { GITHUB_COLLECTOR_APP_INSTALLATIONS: "12", GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS: "34" },
    { GITHUB_COLLECTOR_SOURCES: "env,accounts", GITHUB_COLLECTOR_APP_INSTALLATIONS: "12" },
  ];
  for (const env of invalid) expect(() => collectorScope(env), JSON.stringify(env)).toThrow(/^github_collector_scope_invalid:GITHUB_COLLECTOR_/);
});

it("keeps the existing credential order when no host scope is set", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", SECRET);
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  appTokens.mockReset().mockResolvedValue([appToken]);
  select.mockReset().mockReturnValueOnce(patRows({ userId: 1, login: "pat-owner", token: "github_pat_fixture_1234567890" }));
  expect(await collectorTokens()).toEqual([
    { token: "legacy-fixture-token", userId: null, login: "환경 토큰" },
    { token: "github_pat_fixture_1234567890", userId: 1, login: "pat-owner" },
    { token: appToken.token, userId: null, login: appToken.login, installationId: 77 },
  ]);
  expect(appTokens).toHaveBeenCalledWith(SECRET);
  // 비밀키가 아직 없으면 예전처럼 환경 토큰만 쓴다
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", undefined);
  select.mockReset(); appTokens.mockReset();
  expect((await collectorTokens()).map(item => item.token)).toEqual(["legacy-fixture-token"]);
  expect(select).not.toHaveBeenCalled();
});

it("uses only App installations on an apps-only host without reading personal tokens", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", SECRET);
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", "apps");
  appTokens.mockReset().mockResolvedValue([appToken]);
  select.mockReset();
  expect((await collectorTokens()).map(item => item.token)).toEqual([appToken.token]);
  expect(select).not.toHaveBeenCalled();
});

it("uses only the environment token on an env-only host without the shared key or a database read", async () => {
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", "env");
  select.mockReset(); appTokens.mockReset();
  expect((await collectorTokens()).map(item => item.token)).toEqual(["legacy-fixture-token"]);
  expect(select).not.toHaveBeenCalled();
  expect(appTokens).not.toHaveBeenCalled();
});

it("fails loudly instead of falling back to the environment token when a scoped host lacks the shared key", async () => {
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", "env,apps");
  appTokens.mockReset();
  await expect(collectorTokens()).rejects.toThrow("github_collector_secret_missing");
  expect(appTokens).not.toHaveBeenCalled();
});

it("rejects a malformed host scope before touching the database", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", SECRET);
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", "apps,oracle");
  select.mockReset(); appTokens.mockReset();
  await expect(collectorTokens()).rejects.toThrow("github_collector_scope_invalid:GITHUB_COLLECTOR_SOURCES");
  expect(select).not.toHaveBeenCalled();
});

it("records an error when a scoped host is left with no credential", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", SECRET);
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", "apps");
  vi.stubEnv("GITHUB_COLLECTOR_APP_INSTALLATIONS", "77");
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});
  appTokens.mockReset().mockResolvedValue([]);
  expect(await collectorTokens()).toEqual([]);
  expect(error).toHaveBeenCalledWith("github.collector_scope_empty", { sources: ["apps"], onlyInstallations: [77], excludedInstallations: null });
});
