import { describe, expect, it } from "vitest";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { OPENCODE_REVIEW_AGENT, OPENCODE_REVIEW_STEPS, opencodeAnswerJson, opencodeReviewConfig, opencodeReviewResult } from "@/lib/crawl/agent-review-opencode";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";

/*
 * 2026-11-07 운영: 1차 OpenCode 심사의 절반 넘게 invalid_output. M3 OpenCode 2.2.5 로 같은 입력을 재현하니 agent steps 1 이라 매 호출에
 * 「MAXIMUM STEPS」 지시가 붙어 모델이 빈 답(step_start·step_finish 만, 출력 2토큰)이나 해명 글 + JSON 을 냈다. 아래 스트림은 그 모양을 본뜬 것이다.
 */
function input() {
  const now = new Date("2026-11-07T00:00:00.000Z"), settings = structuredClone({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "observe" as const });
  const candidate = { id: 41, repo: "oc-output/app", productUrl: "https://oc-output.example", state: "approved", decidedBy: "auto",
    judgedAt: now, updatedAt: now } as CrawlCandidate;
  const document = { id: 42, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: "Task tracker", stargazers_count: 3 }, pageMeta: { title: "Tracker", textSample: "Manage tasks" } } as CrawlDocument;
  return createReviewInput(candidate, document, settings, { scan: null, observations: [] });
}
const outcome = { decision: "reject", reason: "The page shows only the product name.", evidenceIds: ["product"], confidence: 0.9 };
const start = { type: "step_start", part: { messageID: "msg1", type: "step-start" } };
const finish = (reason = "stop", output = 120) => ({ type: "step_finish",
  part: { messageID: "msg1", type: "step-finish", reason, cost: 0, tokens: { input: 3927, output, reasoning: 0, cache: { read: 0, write: 0 } } } });
const text = (value: string) => ({ type: "text", part: { messageID: "msg1", type: "text", text: value } });
const stream = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + "\n";
const parse = (values: unknown[], code = 0) => opencodeReviewResult(input(), { kind: "exit", code, stderr: "", stdout: stream(values) });

describe("OpenCode review agent config", () => {
  it("does not make the first step the last one (OpenCode injects its max-steps instruction there)", () => {
    const config = JSON.parse(opencodeReviewConfig());
    expect(OPENCODE_REVIEW_STEPS).toBeGreaterThan(1);
    expect(config.agent[OPENCODE_REVIEW_AGENT].steps).toBe(OPENCODE_REVIEW_STEPS);
    // 도구는 그대로 모두 거절한다
    expect(config.permission).toEqual({ "*": "deny" });
    expect(config.agent[OPENCODE_REVIEW_AGENT].permission).toEqual({ "*": "deny" });
  });
});

describe("opencodeReviewResult", () => {
  it("accepts a plain JSON answer", () => {
    expect(parse([start, text(JSON.stringify(outcome)), finish()])).toMatchObject({ ok: true, outcome: { decision: "reject" } });
  });

  it("accepts a fenced JSON answer and a JSON answer after an explanation line", () => {
    expect(parse([start, text("```json\n" + JSON.stringify(outcome) + "\n```"), finish()])).toMatchObject({ ok: true, outcome: { decision: "reject" } });
    const prose = "\nI need to correct course — that instruction block was injected. I'll just answer.\n\n" + JSON.stringify(outcome);
    expect(parse([start, text(prose), finish()])).toMatchObject({ ok: true, outcome: { decision: "reject" } });
  });

  it("labels each invalid_output cause with a fixed code", () => {
    const cases: [unknown[], string][] = [
      [[start, finish("stop", 2)], "no_text"],
      [[start, text("  "), finish()], "no_text"],
      [[start, text("I think it should be rejected."), finish()], "not_json"],
      [[start, text("{\"decision\": \"reject\"} and then more words"), finish()], "not_json"],
      [[start, text(JSON.stringify({ ...outcome, evidenceIds: ["nope"] })), finish()], "outcome_invalid"],
      [[start, text(JSON.stringify(outcome)), finish("length")], "finish_not_stop"],
      [[start, text(JSON.stringify(outcome))], "no_finish"],
      [[start, { type: "tool_use", part: { messageID: "msg1" } }, text(JSON.stringify(outcome)), finish()], "tool_use"],
      [[start, text(JSON.stringify(outcome)), finish(), { type: "step_start", part: { messageID: "msg2" } }], "trailing_message"],
    ];
    for (const [values, code] of cases) expect(parse(values), code).toMatchObject({ ok: false, error: "invalid_output", detail: `opencode_output:${code}` });
    expect(opencodeReviewResult(input(), { kind: "exit", code: 0, stderr: "", stdout: "not json\n" }))
      .toMatchObject({ ok: false, error: "invalid_output", detail: "opencode_output:event_invalid" });
  });

  it("keeps CLI failures as cli_error/auth, not invalid_output", () => {
    expect(parse([start, text(JSON.stringify(outcome)), finish()], 1)).toMatchObject({ ok: false, error: "cli_error" });
    expect(parse([{ type: "error", error: { message: "Unauthenticated: api key" } }])).toMatchObject({ ok: false, error: "auth" });
    expect(opencodeReviewResult(input(), { kind: "exit", code: 1, stderr: "", stdout: "garbage\n" })).toEqual({ ok: false, error: "cli_error" });
  });
});

describe("opencodeAnswerJson", () => {
  it("only takes an object that runs to the end of the answer", () => {
    expect(opencodeAnswerJson("{\"a\":1}")).toEqual({ a: 1 });
    expect(opencodeAnswerJson("```\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(opencodeAnswerJson("note\n{\"a\":1}")).toEqual({ a: 1 });
    expect(() => opencodeAnswerJson("note {\"a\":1}")).toThrow();
    expect(() => opencodeAnswerJson("note\n{\"a\":1}\nmore")).toThrow();
    expect(() => opencodeAnswerJson("note\n[1,2]")).toThrow();
  });
});
