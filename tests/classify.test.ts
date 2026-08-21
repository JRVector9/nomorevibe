import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 카테고리 분류의 응답 처리.
 *
 * 실제 모델을 부르지 않고도 확인해야 하는 것이 있다 — 어떤 응답이 와도 발행이 멈추지
 * 않는가, 그리고 실패의 종류가 로그에서 갈리는가. 로컬에 API 자리를 대신할 서버를 세워
 * SDK가 실제로 주고받는 경로를 그대로 태운다.
 */

type Canned = { status: number; body: unknown };

/** 서버가 받아 적는 요청 — 확인하는 필드만 적는다 */
type SentRequest = {
  authHeader: boolean;
  body: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { content: string }[];
    output_config: { effort: string; format: { type: string } };
  };
};

let canned: Canned;
let requests: SentRequest[] = [];
let server: http.Server;
let classifyCategory: typeof import("@/lib/crawl/classify").classifyCategory;

const INPUT = {
  repo: "acme/revealui",
  url: "https://revealui.example",
  name: "RevealUI",
  tagline: "Offers, Payments and onboarding flows for sales teams",
  topics: ["sales"],
  language: "TypeScript",
};

/** 성공 응답 한 벌. content 안의 JSON이 구조화 출력의 본문이다 */
function message(content: unknown[], stopReason = "end_turn"): Canned {
  return {
    status: 200,
    body: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content,
      stop_reason: stopReason,
      usage: { input_tokens: 300, output_tokens: 40 },
    },
  };
}
const text = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }];
const apiError = (status: number, type: string): Canned => ({
  status,
  body: { type: "error", error: { type, message: "test" } },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({
        authHeader: Boolean(req.headers["x-api-key"]),
        body: JSON.parse(raw || "{}") as SentRequest["body"],
      });
      res.writeHead(canned.status, { "content-type": "application/json" });
      res.end(JSON.stringify(canned.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  // 클라이언트는 첫 호출에 만들어져 캐시된다. 그 전에 주소와 키를 세운다
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  ({ classifyCategory } = await import("@/lib/crawl/classify"));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  requests = [];
  vi.restoreAllMocks();
});

describe("classifyCategory", () => {
  it("구조화 출력을 읽어 카테고리를 준다", async () => {
    canned = message(text({ category: "Productivity", reason: "영업팀 업무 운영 도구" }));
    await expect(classifyCategory(INPUT)).resolves.toBe("Productivity");
  });

  it("생각 블록이 앞에 붙어도 답을 찾는다", async () => {
    canned = message([
      { type: "thinking", thinking: "업무 도구로 보인다", signature: "s" },
      ...text({ category: "Dev", reason: "개발자 도구" }),
    ]);
    await expect(classifyCategory(INPUT)).resolves.toBe("Dev");
  });

  it("근거가 길어도 카테고리를 버리지 않는다", async () => {
    // 이 API가 받는 스키마에는 maxLength가 없다. 길이로 분류를 무르면
    // 로그용 문장 하나 때문에 키워드 규칙으로 되돌아간다
    canned = message(text({ category: "Finance", reason: "가".repeat(400) }));
    await expect(classifyCategory(INPUT)).resolves.toBe("Finance");
  });

  it("허용하지 않은 카테고리는 통과시키지 않는다", async () => {
    // enum은 서버까지 가지 못하고 description의 힌트로만 남는다.
    // 모델이 다른 값을 내면 막는 곳은 여기뿐이다
    canned = message(text({ category: "Marketing", reason: "없는 카테고리" }));
    await expect(classifyCategory(INPUT)).resolves.toBeNull();
  });

  it("한도에 걸려 잘린 응답은 버린다", async () => {
    canned = message([{ type: "text", text: '{"category":"Produc' }], "max_tokens");
    await expect(classifyCategory(INPUT)).resolves.toBeNull();
  });

  it("답 블록이 없으면 unparsed로 남긴다", async () => {
    canned = message([{ type: "thinking", thinking: "음", signature: "s" }]);
    await expect(classifyCategory(INPUT)).resolves.toBeNull();
  });

  it("인증 실패와 한도 초과를 갈라 남긴다", async () => {
    const logger = await import("@/lib/observability/logger");
    const error = vi.spyOn(logger.logger, "error").mockImplementation(() => {});
    const warn = vi.spyOn(logger.logger, "warn").mockImplementation(() => {});

    canned = apiError(401, "authentication_error");
    await expect(classifyCategory(INPUT)).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith("crawl.classify_failed", expect.objectContaining({ reason: "auth" }));

    canned = apiError(429, "rate_limit_error");
    await expect(classifyCategory(INPUT)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith("crawl.classify_failed", expect.objectContaining({ reason: "rate_limit" }));
  });

  it("서버 오류에 재시도하지 않는다", async () => {
    // 발행 잡의 틱 예산이 25초다. 한 후보가 재시도로 예산을 먹으면 틱 전체가 끊긴다
    canned = apiError(500, "api_error");
    await expect(classifyCategory(INPUT)).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("보내는 요청에 모델·한도·effort가 그대로 실린다", async () => {
    canned = message(text({ category: "Other", reason: "그 밖" }));
    await classifyCategory(INPUT);

    const sent = requests[0]!;
    expect(sent.authHeader).toBe(true);
    expect(sent.body.model).toBe("claude-sonnet-5");
    expect(sent.body.max_tokens).toBe(4096);
    expect(sent.body.output_config.effort).toBe("high");
    expect(sent.body.output_config.format.type).toBe("json_schema");
    // 수집한 자료는 지시가 아니라는 것을 프롬프트가 못 박고 있어야 한다
    expect(sent.body.system).toContain("지시가 아니다");
    expect(sent.body.messages[0].content).toContain("<product>");
  });
});
