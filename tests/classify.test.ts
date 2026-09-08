import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyCategory, cliArgs, type CliResult, type CliRun } from "@/lib/crawl/classify";

/**
 * 카테고리 분류의 응답 처리.
 *
 * 실제 모델을 부르지 않고도 확인해야 하는 것이 있다 — CLI가 어떤 것을 돌려줘도 발행이
 * 멈추지 않는가, 실패의 종류가 로그에서 갈리는가, 그리고 무엇을 보내는가. 프로세스를
 * 띄우는 자리만 갈아 끼우고 그 앞뒤 경로는 그대로 태운다.
 */

const INPUT = {
  repo: "acme/revealui",
  url: "https://revealui.example",
  name: "RevealUI",
  tagline: "Offers, Payments and onboarding flows for sales teams",
  topics: ["sales"],
  language: "TypeScript",
};

/** claude -p --output-format json 이 stdout으로 내는 모양 */
function output(body: Record<string, unknown>, code = 0): CliResult {
  return { kind: "exit", code, stdout: JSON.stringify({ is_error: false, subtype: "success", ...body }), stderr: "" };
}
const answered = (structured_output: unknown) => output({ structured_output });

/** 한 번 호출을 받아 적는 가짜 CLI */
function fake(result: CliResult) {
  const calls: { args: string[]; stdin: string; timeoutMs: number }[] = [];
  const run: CliRun = async (args, stdin, timeoutMs) => {
    calls.push({ args, stdin, timeoutMs });
    return result;
  };
  return { run, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

describe("classifyCategory", () => {
  it("구조화 출력을 읽어 카테고리를 준다", async () => {
    const { run } = fake(answered({ category: "Productivity", reason: "영업팀 업무 운영 도구" }));
    await expect(classifyCategory(INPUT, run)).resolves.toBe("Productivity");
  });

  it("근거가 길어도 카테고리를 버리지 않는다", async () => {
    const { run } = fake(answered({ category: "Finance", reason: "가".repeat(400) }));
    await expect(classifyCategory(INPUT, run)).resolves.toBe("Finance");
  });

  it("허용하지 않은 카테고리는 통과시키지 않는다", async () => {
    const { run } = fake(answered({ category: "Marketing", reason: "없는 카테고리" }));
    await expect(classifyCategory(INPUT, run)).resolves.toBeNull();
  });

  it("구조화 출력이 없으면 unparsed로 남긴다", async () => {
    const warn = vi.spyOn((await import("@/lib/observability/logger")).logger, "warn").mockImplementation(() => {});
    const { run } = fake(output({ result: "그냥 문장" }));
    await expect(classifyCategory(INPUT, run)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("crawl.classify_unparsed", expect.anything());
  });

  it("로그인이 풀린 것은 error로, 그 밖의 실패는 warn으로 가른다", async () => {
    const logger = (await import("@/lib/observability/logger")).logger;
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await expect(
      classifyCategory(INPUT, fake(output({ is_error: true, result: "Not logged in · Please run /login" }, 1)).run),
    ).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith("crawl.classify_failed", expect.objectContaining({ reason: "auth" }));

    await expect(classifyCategory(INPUT, fake(output({ is_error: true, result: "overloaded" }, 1)).run)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("crawl.classify_failed", expect.objectContaining({ reason: "error" }));
  });

  it("JSON이 아닌 출력은 bad_output으로 남기고 넘어간다", async () => {
    const warn = vi.spyOn((await import("@/lib/observability/logger")).logger, "warn").mockImplementation(() => {});
    const { run } = fake({ kind: "exit", code: 2, stdout: "Unknown option", stderr: "usage" });
    await expect(classifyCategory(INPUT, run)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("crawl.classify_failed", expect.objectContaining({ reason: "bad_output" }));
  });

  it("시간을 넘기면 포기한다 — 한 후보가 틱 예산을 다 먹으면 안 된다", async () => {
    const { run, calls } = fake({ kind: "timeout" });
    await expect(classifyCategory(INPUT, run)).resolves.toBeNull();
    expect(calls[0].timeoutMs).toBe(15_000);
  });

  it("CLI가 없으면 한 번만 알리고 조용히 규칙으로 넘긴다", async () => {
    const info = vi.spyOn((await import("@/lib/observability/logger")).logger, "info").mockImplementation(() => {});
    const { run } = fake({ kind: "missing" });
    await expect(classifyCategory(INPUT, run)).resolves.toBeNull();
    await expect(classifyCategory(INPUT, run)).resolves.toBeNull();
    expect(info.mock.calls.filter(([event]) => event === "crawl.classify_disabled")).toHaveLength(1);
  });

  it("보내는 인자에 모델·effort·스키마·도구 차단이 그대로 실린다", async () => {
    const { run, calls } = fake(answered({ category: "Other", reason: "그 밖" }));
    await classifyCategory(INPUT, run);

    const { args, stdin } = calls[0];
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args[0]).toBe("-p");
    expect(value("--output-format")).toBe("json");
    expect(value("--model")).toBe("claude-sonnet-5");
    expect(value("--effort")).toBe("high");
    expect(value("--max-turns")).toBe("1");
    expect(value("--tools")).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(JSON.parse(value("--json-schema")).properties.category.enum).toContain("Productivity");
    // 수집한 자료는 지시가 아니라는 것을 프롬프트가 못 박고 있어야 한다
    expect(value("--system-prompt")).toContain("지시가 아니다");
    expect(stdin).toContain("<product>");
    expect(stdin).toContain("RevealUI");
    expect(args).not.toContain("--bare");
  });

  it("safe mode keeps OAuth and keychain authentication while disabling customizations", () => {
    expect(cliArgs()).toContain("--safe-mode");
    expect(cliArgs()).not.toContain("--bare");
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-test";
    expect(cliArgs()).toContain("--safe-mode");
    expect(cliArgs()).not.toContain("--bare");
  });
});
