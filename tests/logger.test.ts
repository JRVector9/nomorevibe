import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redact, logger } from "@/lib/observability/logger";

describe("redact — 비밀값이 로그에 원문으로 남지 않는다", () => {
  it("토큰 계열 키를 가린다", () => {
    const out = redact({
      slug: "simplehwp",
      edit_token: "nmv_edit_deadbeef",
      verifyToken: "nmv_verify_cafe",
      authorization: "Bearer secret",
      password: "hunter2",
      api_key: "sk-live-1234",
    }) as Record<string, unknown>;

    expect(out.slug).toBe("simplehwp");
    for (const key of ["edit_token", "verifyToken", "authorization", "password", "api_key"]) {
      expect(out[key], key).toBe("[redacted]");
    }
    expect(JSON.stringify(out)).not.toContain("deadbeef");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("중첩 객체 안의 비밀값도 가린다", () => {
    const out = redact({ response: { body: { edit_token: "nmv_edit_x" } } });
    expect(JSON.stringify(out)).not.toContain("nmv_edit_x");
  });

  it("Error를 직렬화 가능한 형태로 바꾼다", () => {
    const out = redact(new Error("연결 실패")) as Record<string, unknown>;
    expect(out.name).toBe("Error");
    expect(out.message).toBe("연결 실패");
    expect(Array.isArray(out.stack)).toBe(true);
  });

  it("순환 참조에도 무한 재귀하지 않는다", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => JSON.stringify(redact(a))).not.toThrow();
  });
});

describe("logger 출력", () => {
  const saved = process.env.LOG_LEVEL;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    if (saved !== undefined) process.env.LOG_LEVEL = saved;
    else delete process.env.LOG_LEVEL;
  });

  it("한 줄 JSON으로 쓴다", () => {
    logger.info("register.succeeded", { slug: "simplehwp" });
    const line = stdout.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toContain("\n");
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ level: "info", event: "register.succeeded", slug: "simplehwp" });
    expect(parsed.ts).toBeTruthy();
  });

  it("error는 stderr로 분리한다", () => {
    logger.error("http.unhandled", { route: "products.register" });
    expect(stderr).toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("LOG_LEVEL 아래 레벨은 내보내지 않는다", () => {
    process.env.LOG_LEVEL = "warn";
    logger.info("무시될 이벤트");
    expect(stdout).not.toHaveBeenCalled();
    logger.warn("남을 이벤트");
    expect(stdout).toHaveBeenCalled();
  });
});
