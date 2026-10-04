import { expect, it, vi } from "vitest";
import { access, readFile } from "node:fs/promises";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { grokAuthPath, grokFailure, grokReviewAgentDefinition, grokReviewArgs, grokReviewEffort, reviewWithGrokCli, type GrokCliRun } from "@/lib/crawl/agent-review-grok";

/**
 * Grok CLI 2차 표 — 정책 글·스키마·도구 차단이 인자에 들어가고, 구조화 출력이 심사 결과로 읽히며,
 * 실패는 종류로만 남는지. 진짜 CLI 는 부르지 않는다(run 을 가짜로).
 */
function input() {
  const now = new Date();
  return createReviewInput({ repo: "acme/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "acme/demo", productUrl: "https://demo.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Demo" }, pageStatus: 200, fetchedAt: now } as CrawlDocument, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
const approved = { decision: "approve", reason: "pageText introduces a deployed task tracker.", evidenceIds: ["product"], confidence: 0.86 };
const envelope = (structuredOutput: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
  text: JSON.stringify(structuredOutput), stopReason: "end_turn", structuredOutput,
  usage: { input_tokens: 14484, output_tokens: 622, reasoning_tokens: 597 }, total_cost_usd: 0.0105, ...extra,
});
const answer = (stdout: string, code = 0, stderr = ""): GrokCliRun => async () => ({ kind: "exit", code, stdout, stderr });

it("정책 글을 에이전트 정의의 시스템 프롬프트로, 증거를 파일로, 출력은 스키마로 — 한 턴에 도구 없이", () => {
  const args = grokReviewArgs("grok-4.7", "/tmp/x/prompt.txt");
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  expect(value("--prompt-file")).toBe("/tmp/x/prompt.txt");
  expect(value("--agent")).toBe("nmv-review");
  expect(args).not.toContain("--rules");
  expect(value("--tools")).toBe("");
  expect(grokReviewAgentDefinition()).toMatch(/^---\nname: nmv-review\n[\s\S]*promptMode: full[\s\S]*---\n/);
  expect(grokReviewAgentDefinition()).toContain("does product.url belong on a directory");
  expect(value("-m")).toBe("grok-4.7");
  expect(value("--effort")).toBe("low");
  expect(grokReviewEffort({ GROK_REVIEW_EFFORT: "High" })).toBe("high");
  expect(grokReviewEffort({ GROK_REVIEW_EFFORT: "turbo" })).toBe("low");
  expect(grokReviewArgs("grok-4.7", "/tmp/x/prompt.txt", "medium")).toContain("medium");
  expect(value("--output-format")).toBe("json");
  expect(value("--max-turns")).toBe("1");
  expect(args).toContain("--disable-web-search");
  expect(JSON.parse(value("--json-schema")).required).toEqual(["decision", "reason", "evidenceIds", "confidence"]);
});

it("빈 임시 GROK_HOME 과 로그인 파일 경로를 주고, 증거 파일을 쓴 뒤 치운다", async () => {
  vi.stubEnv("GROK_AUTH_PATH", "/run/grok/auth.json");
  let seen: { cwd: string; env: NodeJS.ProcessEnv; promptFile: string } | null = null;
  const run: GrokCliRun = async (args, options) => {
    const promptFile = args[args.indexOf("--prompt-file") + 1];
    expect(await readFile(promptFile, "utf8")).toContain("<untrusted_evidence_json>");
    expect(options.env.GROK_HOME).toMatch(/nomorevibe-grok-/);
    expect(await readFile(`${options.env.GROK_HOME}/agents/nmv-review.md`, "utf8")).toContain("promptMode: full");
    seen = { cwd: options.cwd, env: options.env, promptFile };
    return { kind: "exit", code: 0, stdout: envelope(approved), stderr: "" };
  };
  const result = await reviewWithGrokCli(input(), { model: "grok-4.7", run });
  expect(result).toMatchObject({ ok: true, outcome: { decision: "approve", confidence: 0.86 }, usage: { inputTokens: 14484, outputTokens: 622, costUsd: 0.0105 } });
  expect(seen!.env.GROK_AUTH_PATH).toBe("/run/grok/auth.json");
  await expect(access(seen!.promptFile)).rejects.toThrow();
  vi.unstubAllEnvs();
  expect(grokAuthPath({})).toMatch(/\.grok\/auth\.json$/);
});

it("structuredOutput 이 없으면 text 의 JSON 을 읽고, 모르는 증거 ID 는 invalid_output 이다", async () => {
  const fromText = await reviewWithGrokCli(input(), { model: "grok-4.7", run: answer(JSON.stringify({ text: JSON.stringify(approved), stopReason: "end_turn" })) });
  expect(fromText).toMatchObject({ ok: true, outcome: { decision: "approve" } });
  const unknown = await reviewWithGrokCli(input(), { model: "grok-4.7", run: answer(envelope({ ...approved, evidenceIds: ["ghost"] })) });
  expect(unknown).toMatchObject({ ok: false, error: "invalid_output" });
});

it("실패는 종류로 남는다 — 로그인·한도·제한 시간·CLI 없음·이름 오류", async () => {
  expect(await reviewWithGrokCli(input(), { model: "grok-4.7", run: answer("", 1, "Error: not signed in. Run `grok login`.") })).toEqual({ ok: false, error: "auth" });
  expect(await reviewWithGrokCli(input(), { model: "grok-4.7", run: answer("", 1, "429 Too Many Requests") })).toEqual({ ok: false, error: "rate_limited" });
  expect(await reviewWithGrokCli(input(), { model: "grok-4.7", run: answer("", 1, "weekly usage limit reached") })).toEqual({ ok: false, error: "budget" });
  expect(await reviewWithGrokCli(input(), { model: "grok-4.7", run: async () => ({ kind: "timeout" }) })).toEqual({ ok: false, error: "timeout" });
  expect(await reviewWithGrokCli(input(), { model: "grok-4.7", run: async () => ({ kind: "missing_cli" }) })).toEqual({ ok: false, error: "missing_cli" });
  expect(await reviewWithGrokCli(input(), { model: "--bad model", run: answer(envelope(approved)) })).toEqual({ ok: false, error: "not_configured" });
  expect(await reviewWithGrokCli(input(), { model: "grok-4.7", run: answer("not json at all") })).toEqual({ ok: false, error: "invalid_output" });
  expect(grokFailure("", "something else broke")).toBe("cli_error");
});
