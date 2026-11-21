import { describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { DIRECT_REVIEW_PROVIDERS, equivalentReviewerProviders, reviewerProviderKey, reviewerProviderKeySql, reviewerProviderMatchSql,
  sameReviewer, sameReviewerProvider, sameReviewerProviderSql, sameReviewerSql } from "@/lib/crawl/reviewer-identity";
import { currentFirstReviewer, exactFirstReviewer, firstReviewExactSql, firstReviewIdentitySql, hasFirstReviewer, selectFirstReviewer } from "@/lib/crawl/first-reviewers";
import { secondReviewVoterFor } from "@/lib/crawl/second-review-voters";
import { secondReviewRelabel } from "@/lib/crawl/second-review";
import { secondReviewFirstReviewer } from "@/lib/crawl/second-review-input";
import { reviewModelsMayCountIndependently } from "@/lib/crawl/review-model-identity";
import type { FirstReviewer } from "@/lib/crawl/agent-review";

/**
 * 심사자 identity 의 provider 동등 규칙(2026-11-21, abcllm 이름표 정리 1단계): 같은 장부 이름의 (abcllm, M) 과 (local-direct, M) 은 같은 심사자다 —
 * 그 묶음뿐이고, 지금 보내는 호출은 부른 이름표 그대로다.
 */
const M = "deepseek-v4.1-flash-1017";
const render = (value: SQL) => new PgDialect().sqlToQuery(value);

describe("reviewer-identity — provider 견줌", () => {
  it("엔진 직접 묶음은 abcllm·local-direct 둘뿐이다", () => {
    expect([...DIRECT_REVIEW_PROVIDERS]).toEqual(["abcllm", "local-direct"]);
    expect(reviewerProviderKey("abcllm")).toBe(reviewerProviderKey("local-direct"));
    for (const provider of ["claude-cli", "grok-cli", "opencode-cli", "rules", "qwen-direct", "m3-deepseek", "llama-server"]) {
      expect(reviewerProviderKey(provider)).toBe(provider);
      expect(equivalentReviewerProviders(provider)).toEqual([provider]);
    }
    expect(equivalentReviewerProviders("abcllm")).toEqual(["abcllm", "local-direct"]);
    expect(equivalentReviewerProviders("local-direct")).toEqual(["abcllm", "local-direct"]);
  });

  it("같은 provider 인가 — 묶음 안은 같고, 묶음 밖·CLI 사이·없는 값은 다르다", () => {
    expect(sameReviewerProvider("abcllm", "local-direct")).toBe(true);
    expect(sameReviewerProvider("local-direct", "abcllm")).toBe(true);
    expect(sameReviewerProvider("abcllm", "abcllm")).toBe(true);
    expect(sameReviewerProvider("claude-cli", "claude-cli")).toBe(true);
    expect(sameReviewerProvider("abcllm", "claude-cli")).toBe(false);
    expect(sameReviewerProvider("local-direct", "opencode-cli")).toBe(false);
    expect(sameReviewerProvider("grok-cli", "opencode-cli")).toBe(false);
    // 위임 검수의 이름표는 엔진 직접 묶음이 아니다(같은 모델이어도 1차 심사자의 기록이 아니다)
    expect(sameReviewerProvider("local-direct", "qwen-direct")).toBe(false);
    expect(sameReviewerProvider("local-direct", "m3-deepseek")).toBe(false);
    expect(sameReviewerProvider(null, null)).toBe(false);
    expect(sameReviewerProvider("abcllm", null)).toBe(false);
    expect(sameReviewerProvider(undefined, "local-direct")).toBe(false);
  });

  it("같은 심사자인가 — 장부 이름은 글자 그대로다", () => {
    expect(sameReviewer({ provider: "abcllm", model: M }, { provider: "local-direct", model: M })).toBe(true);
    expect(sameReviewer({ provider: "abcllm", model: M }, { provider: "local-direct", model: `${M}@0a1b2c3d` })).toBe(false);
    expect(sameReviewer({ provider: "abcllm", model: M }, { provider: "local-direct", model: "qwen3.8-flash-next" })).toBe(false);
    expect(sameReviewer({ provider: "abcllm", model: M }, { provider: "opencode-cli", model: M })).toBe(false);
    expect(sameReviewer({ provider: "abcllm", model: null }, { provider: "local-direct", model: null })).toBe(false);
  });
});

describe("reviewer-identity — SQL", () => {
  it("열쇠 SQL 은 묶음만 한 값으로 접는다", () => {
    const query = render(reviewerProviderKeySql(sql`a.provider`));
    expect(query.sql).toBe("(CASE WHEN a.provider IN ($1, $2) THEN $3 ELSE a.provider END)");
    expect(query.params).toEqual(["abcllm", "local-direct", "local-direct"]);
  });

  it("열 견줌은 열을 감싸지 않는다 — 묶음이면 IN, 아니면 =", () => {
    expect(render(reviewerProviderMatchSql(sql`a.provider`, "local-direct"))).toMatchObject({ sql: "a.provider IN ($1, $2)", params: ["abcllm", "local-direct"] });
    expect(render(reviewerProviderMatchSql(sql`a.provider`, "abcllm"))).toMatchObject({ sql: "a.provider IN ($1, $2)", params: ["abcllm", "local-direct"] });
    expect(render(reviewerProviderMatchSql(sql`a.provider`, "grok-cli"))).toMatchObject({ sql: "a.provider = $1", params: ["grok-cli"] });
  });

  it("심사자 SQL 은 provider 묶음 + 글자 그대로의 모델이다", () => {
    expect(render(sameReviewerSql({ provider: sql`a.provider`, model: sql`a.model` }, { provider: "abcllm", model: M })))
      .toMatchObject({ sql: "(a.provider IN ($1, $2) AND a.model = $3)", params: ["abcllm", "local-direct", M] });
    expect(render(sameReviewerProviderSql(sql`v->>'provider'`, sql`s.provider`)).sql)
      .toBe("(CASE WHEN v->>'provider' IN ($1, $2) THEN $3 ELSE v->>'provider' END) = (CASE WHEN s.provider IN ($4, $5) THEN $6 ELSE s.provider END)");
  });
});

describe("1차 심사자 — 기록의 유효 판정과 지금 보내는 호출", () => {
  const pool: FirstReviewer[] = [{ provider: "local-direct", model: M }, { provider: "claude-cli", model: "sonnet" }];

  it("남은 기록은 이름표가 바뀌어도 지금 심사자의 것이다", () => {
    expect(hasFirstReviewer(pool, { provider: "abcllm", model: M })).toBe(true);
    expect(hasFirstReviewer(pool, { provider: "local-direct", model: M })).toBe(true);
    expect(hasFirstReviewer([{ provider: "abcllm", model: M }], { provider: "local-direct", model: M })).toBe(true);
    expect(currentFirstReviewer(pool, { provider: "abcllm", model: M })).toEqual({ provider: "local-direct", model: M });
  });

  it("다른 모델·CLI·위임 이름표의 기록은 예전처럼 지금 심사자의 것이 아니다", () => {
    expect(hasFirstReviewer(pool, { provider: "abcllm", model: "qwen3.8-flash-next" })).toBe(false);
    expect(hasFirstReviewer(pool, { provider: "abcllm", model: "sonnet" })).toBe(false);
    expect(hasFirstReviewer(pool, { provider: "local-direct", model: "sonnet" })).toBe(false);
    expect(hasFirstReviewer(pool, { provider: "opencode-cli", model: M })).toBe(false);
    expect(hasFirstReviewer(pool, { provider: "m3-deepseek", model: M })).toBe(false);
    expect(hasFirstReviewer(pool, { provider: "qwen-direct", model: M })).toBe(false);
    expect(hasFirstReviewer(pool, { provider: null, model: M })).toBe(false);
    expect(currentFirstReviewer(pool, { provider: "grok-cli", model: "sonnet" })).toBeUndefined();
  });

  it("지금 보내는 호출은 글자 그대로다 — 옛 이름표의 살아 있는 의도·진행 중 시도를 새 이름표로 한 번 더 보내지 않는다", () => {
    expect(exactFirstReviewer(pool, { provider: "abcllm", model: M })).toBeUndefined();
    expect(exactFirstReviewer(pool, { provider: "local-direct", model: M })).toEqual({ provider: "local-direct", model: M });
    // 장부에 abcllm 으로 살아 있는 의도가 있으면 기다린다(null) — local-direct 로 고르지 않는다
    expect(selectFirstReviewer(pool, 7, [], [{ provider: "abcllm", model: M }])).toBeNull();
    expect(selectFirstReviewer(pool, 7, [{ provider: "abcllm", model: M, state: "running", live: true }])).toBeNull();
    expect(selectFirstReviewer(pool, 7, [], [{ provider: "local-direct", model: M }])).toEqual({ provider: "local-direct", model: M });
    // 끝난 옛 시도는 묶지 않는다 — 가장 높은 순위를 고른다
    expect(selectFirstReviewer(pool, 7, [{ provider: "abcllm", model: M, state: "succeeded", live: false }])).toEqual({ provider: "local-direct", model: M });
  });

  it("기록 SQL 은 묶음으로, 장부 SQL 은 글자 그대로 견준다", () => {
    const columns = { provider: sql`provider`, model: sql`model` };
    expect(render(firstReviewIdentitySql(pool, columns))).toMatchObject({
      sql: "((provider IN ($1, $2) AND model = $3) OR (provider = $4 AND model = $5))", params: ["abcllm", "local-direct", M, "claude-cli", "sonnet"] });
    expect(render(firstReviewExactSql(pool, columns))).toMatchObject({
      sql: "((provider = $1 AND model = $2) OR (provider = $3 AND model = $4))", params: ["local-direct", M, "claude-cli", "sonnet"] });
    expect(render(firstReviewIdentitySql([], columns)).sql).toBe("false");
    expect(render(firstReviewExactSql([], columns)).sql).toBe("false");
  });

  it("2차가 붙는 1차 판단: claude-cli·abcllm 은 예전처럼 받고, local-direct·CLI 는 지금 심사자의 것만", () => {
    expect(secondReviewFirstReviewer(pool, { provider: "abcllm", model: "anything" })).toBe(true);
    expect(secondReviewFirstReviewer(pool, { provider: "claude-cli", model: "anything" })).toBe(true);
    expect(secondReviewFirstReviewer(pool, { provider: "local-direct", model: M })).toBe(true);
    expect(secondReviewFirstReviewer([{ provider: "abcllm", model: M }], { provider: "local-direct", model: M })).toBe(true);
    expect(secondReviewFirstReviewer(pool, { provider: "local-direct", model: "qwen3.8-flash-next" })).toBe(false);
    expect(secondReviewFirstReviewer(pool, { provider: "grok-cli", model: M })).toBe(false);
    expect(secondReviewFirstReviewer(pool, { provider: "qwen-direct", model: M })).toBe(false);
  });
});

describe("2차 투표자 — 표 이어받기", () => {
  const voters = [{ provider: "local-direct" as const, model: "Qwen3.8-27B-NVFP4" }, { provider: "claude-cli" as const, model: "sonnet" }];

  it("abcllm 으로 받은 표는 그 모델의 계약을 local-direct 로 다시 저장한 뒤에도 그 칸의 표다", () => {
    expect(secondReviewVoterFor(voters, { provider: "abcllm", model: "Qwen3.8-27B-NVFP4" })).toEqual(voters[0]);
    // 모델 견줌은 예전 그대로(sameReviewModel — [MLX]·연결 꼬리·대소문자)
    expect(secondReviewVoterFor(voters, { provider: "abcllm", model: "[MLX] qwen3.8-27b-nvfp4@0a1b2c3d" })).toEqual(voters[0]);
    expect(secondReviewVoterFor([{ provider: "abcllm" as const, model: "Qwen3.8-27B-NVFP4" }], { provider: "local-direct", model: "Qwen3.8-27B-NVFP4" }))
      .toEqual({ provider: "abcllm", model: "Qwen3.8-27B-NVFP4" });
  });

  it("다른 모델·CLI 의 표는 예전처럼 그 칸의 표가 아니다", () => {
    expect(secondReviewVoterFor(voters, { provider: "abcllm", model: "sonnet" })).toBeUndefined();
    expect(secondReviewVoterFor(voters, { provider: "opencode-cli", model: "Qwen3.8-27B-NVFP4" })).toBeUndefined();
    expect(secondReviewVoterFor(voters, { provider: "local-direct", model: "gpt-oss-120b" })).toBeUndefined();
    expect(secondReviewVoterFor(voters, { provider: null, model: "sonnet" })).toBeUndefined();
  });

  it("글자 그대로 같은 자리가 먼저다", () => {
    const both = [{ provider: "local-direct" as const, model: "x" }, { provider: "abcllm" as const, model: "x" }];
    expect(secondReviewVoterFor(both, { provider: "abcllm", model: "x" })).toEqual(both[1]);
  });

  it("아직 보내지 않은 표만, 같은 장부 이름의 다른 이름표로만 옮겨 적는다", () => {
    const current = { provider: "local-direct" as const, model: "Qwen3.8-27B-NVFP4" };
    expect(secondReviewRelabel({ status: "pending", provider: "abcllm", model: "Qwen3.8-27B-NVFP4" }, current)).toBe("local-direct");
    expect(secondReviewRelabel({ status: "failed", provider: "abcllm", model: "Qwen3.8-27B-NVFP4" }, current)).toBe("local-direct");
    // 되돌리기(local-direct → abcllm)도 같은 규칙
    expect(secondReviewRelabel({ status: "pending", provider: "local-direct", model: "Qwen3.8-27B-NVFP4" }, { provider: "abcllm", model: "Qwen3.8-27B-NVFP4" })).toBe("abcllm");
    // 받은 표·끝난 표는 기록이다
    for (const status of ["agreed", "needs_human", "resolved"] as const)
      expect(secondReviewRelabel({ status, provider: "abcllm", model: "Qwen3.8-27B-NVFP4" }, current)).toBeNull();
    // 이름표가 같거나, 장부 이름이 글자 그대로 같지 않거나(다른 계약 행), 묶음 밖이면 옮기지 않는다
    expect(secondReviewRelabel({ status: "pending", provider: "local-direct", model: "Qwen3.8-27B-NVFP4" }, current)).toBeNull();
    expect(secondReviewRelabel({ status: "pending", provider: "abcllm", model: "[MLX] Qwen3.8-27B-NVFP4" }, current)).toBeNull();
    expect(secondReviewRelabel({ status: "pending", provider: "claude-cli", model: "Qwen3.8-27B-NVFP4" }, current)).toBeNull();
    expect(secondReviewRelabel({ status: "pending", provider: "abcllm", model: "Qwen3.8-27B-NVFP4" }, { provider: "claude-cli", model: "Qwen3.8-27B-NVFP4" })).toBeNull();
    expect(secondReviewRelabel({ status: "pending", provider: "abcllm", model: "Qwen3.8-27B-NVFP4" }, null)).toBeNull();
    expect(secondReviewRelabel({ status: "pending", provider: null, model: "Qwen3.8-27B-NVFP4" }, current)).toBeNull();
  });
});

describe("독립 표 규칙은 provider 를 보지 않는다", () => {
  it("이름표가 달라도 같은 모델의 두 표는 독립이 아니다", () => {
    // 독립 판정의 입력은 모델 이름뿐이다 — (abcllm, M) 과 (local-direct, M) 은 이 규칙 전에도 뒤에도 같은 모델의 되풀이 표다
    expect(reviewModelsMayCountIndependently(M, M)).toBe(false);
    expect(reviewModelsMayCountIndependently(`[MLX] ${M}`, `${M}@0a1b2c3d`)).toBe(false);
    expect(reviewModelsMayCountIndependently(M, "qwen3.8-flash-next")).toBe(true);
  });
});
