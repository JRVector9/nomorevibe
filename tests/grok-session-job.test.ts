import { beforeEach, expect, it, vi } from "vitest";
import { checkGrokSession, grokSessionArgs } from "@/lib/crawl/jobs/grok-session";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";

/** Grok 로그인 확인 잡 — grok-cli 설정이 있을 때만 짧은 호출을 하고, 결과를 관측 키로 남긴다 */
const mocks = vi.hoisted(() => ({ settings: null as CrawlSettings | null }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => mocks.settings }));
vi.mock("@/lib/operations/observations", () => ({ observe: vi.fn() }));

const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(), lease: { name: "grok-session-check", token: "t", requestedVersion: 1 } });
const grokSettings = (): CrawlSettings => ({ ...DEFAULT_CRAWL_SETTINGS, enabled: true,
  secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "grok-cli", model: "grok-4.7" }] } });

beforeEach(() => { vi.stubEnv("SERVICE_INSTANCE_ID", "m3-reviewer"); vi.stubEnv("GROK_AUTH_PATH", "/nonexistent/auth.json"); });

it("grok-cli 를 쓰는 설정이 없으면 호출하지 않는다", async () => {
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true };
  const run = vi.fn(); const record = vi.fn();
  const ctx = context();
  expect(await checkGrokSession(ctx as never, { run, record })).toEqual({ done: true });
  expect(run).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith("crawl.grok_session_skipped", { reason: "no_grok_cli_in_settings" });
});

it("짧은 호출이 OK 를 돌려주면 success 를, 로그인이 끊겼으면 auth 를 관측에 남긴다", async () => {
  mocks.settings = grokSettings();
  const record = vi.fn();
  const ok = vi.fn(async (args: string[], options: { env: NodeJS.ProcessEnv }) => {
    expect(args).toEqual(grokSessionArgs("grok-4.7"));
    expect(options.env.GROK_AUTH_PATH).toBe("/nonexistent/auth.json");
    expect(options.env.GROK_HOME).toMatch(/nomorevibe-grok-session-/);
    return { kind: "exit" as const, code: 0, stdout: JSON.stringify({ text: "OK", modelUsage: { "grok-4.7-build": {} } }), stderr: "" };
  });
  await checkGrokSession(context() as never, { run: ok, record });
  expect(record).toHaveBeenCalledWith("service:grok:m3-reviewer", expect.objectContaining({ provider: "grok-cli", model: "grok-4.7", resolvedModel: "grok-4.7-build", result: "success", authFile: { exists: false, modifiedAt: null } }));
  const signedOut = vi.fn(async () => ({ kind: "exit" as const, code: 1, stdout: "", stderr: "Error: Not signed in. To authenticate without a browser, run: grok login --device-code" }));
  await checkGrokSession(context() as never, { run: signedOut, record });
  expect(record).toHaveBeenLastCalledWith("service:grok:m3-reviewer", expect.objectContaining({ result: "auth" }));
});
