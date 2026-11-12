import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AI1_LIVE_CALL_MARGIN_MS, ai1LiveCallWindowMs, ai1WithinLiveCallWindowSql } from "@/lib/crawl/ai1-live-call";
import { setModelRoutePolicyOverlay } from "@/lib/llm/model-registry";

// 1차 호출 「보내는 중」 창(2026-11-11 실시간 한도 개편) — OpenCode CLI 는 review-cli 상한 + 60초다. 예전에는 「모르는 공급자」로 떨어져
// 호출이 없는 Grok 심사 상한(grok-review 90초)이 창(150초)을 정했다 — 실시간 한도 화면에서 그 칸을 빼기 전에 이 연결을 끊는다.
afterEach(() => setModelRoutePolicyOverlay(undefined));

describe("ai1LiveCallWindowMs", () => {
  it("공급자마다 그 호출의 상한 + 60초 — CLI(Claude·OpenCode)는 review-cli, 게이트웨이·엔진 직접은 심사 사다리, Grok 만 grok-review", () => {
    setModelRoutePolicyOverlay(() => ({ limits: { "review-cli": { maxTokens: 2_000, concurrency: 1, timeoutMs: 60_000 } } }));
    expect(AI1_LIVE_CALL_MARGIN_MS).toBe(60_000);
    expect(ai1LiveCallWindowMs("opencode-cli")).toBe(120_000);
    expect(ai1LiveCallWindowMs("claude-cli")).toBe(120_000);
    expect(ai1LiveCallWindowMs("abcllm")).toBe(120_000);
    expect(ai1LiveCallWindowMs("local-direct")).toBe(120_000);
    expect(ai1LiveCallWindowMs("grok-cli")).toBe(150_000);
    // 모르는 공급자는 게이트웨이·CLI 중 긴 쪽 — grok-review 를 더는 보지 않는다
    expect(ai1LiveCallWindowMs("someday-cli")).toBe(120_000);
    expect(ai1LiveCallWindowMs(null)).toBe(120_000);
  });
  it("CLI 상한을 바꾸면 OpenCode 창이 따라간다(grok-review 를 바꿔도 OpenCode 창은 그대로)", () => {
    setModelRoutePolicyOverlay(() => ({ limits: { "review-cli": { maxTokens: 2_000, concurrency: 1, timeoutMs: 90_000 } }, timeouts: { "grok-review": 200_000 } }));
    expect(ai1LiveCallWindowMs("opencode-cli")).toBe(150_000);
    expect(ai1LiveCallWindowMs("grok-cli")).toBe(260_000);
    expect(ai1LiveCallWindowMs("unknown")).toBe(150_000);
  });
  it("SQL 창도 같은 갈래 — opencode-cli 는 claude-cli 와 같은 CLI 창이다", () => {
    setModelRoutePolicyOverlay(() => ({ limits: { "review-cli": { maxTokens: 2_000, concurrency: 1, timeoutMs: 60_000 } } }));
    const query = new PgDialect().sqlToQuery(ai1WithinLiveCallWindowSql(sql`provider`, sql`started_at`));
    expect(query.sql).toContain("IN ('claude-cli','opencode-cli')");
    expect(query.params).toEqual([120_000, 120_000, 150_000, 120_000]);
  });
});
