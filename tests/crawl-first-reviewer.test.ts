import { describe, expect, it } from "vitest";
import { firstReviewer } from "@/lib/crawl/agent-review";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

/**
 * 1차 심사자를 데이터로 뺀 뒤의 계약.
 *
 * 저장된 설정에 이 칸이 없는 배포 환경도 설정을 읽을 수 있어야 하고, 채운 설정만이 1차 심사자를 정한다 —
 * 재배포 없이 모델을 갈아 끼울 수 있어야 비교 실험이 된다. CRAWL_REVIEW_MODEL 대체는 2026-10-31 지웠다(읽지 않는다).
 */
describe("1차 심사자 고르기", () => {
  const withEnv = (model: string | undefined, run: () => void) => {
    const before = process.env.CRAWL_REVIEW_MODEL;
    if (model === undefined) delete process.env.CRAWL_REVIEW_MODEL;
    else process.env.CRAWL_REVIEW_MODEL = model;
    try { run(); } finally {
      if (before === undefined) delete process.env.CRAWL_REVIEW_MODEL;
      else process.env.CRAWL_REVIEW_MODEL = before;
    }
  };

  it("설정이 비어 있으면 CRAWL_REVIEW_MODEL 이 있어도 읽지 않고 null 이다", () => {
    withEnv("sonnet", () => {
      expect(firstReviewer(DEFAULT_CRAWL_SETTINGS)).toBeNull();
    });
  });

  it("설정이 있으면 그것만 쓴다 — 환경변수는 상관없다", () => {
    withEnv("sonnet", () => {
      const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm" as const, model: "[MLX] gpt-oss-120b" } };
      expect(firstReviewer(settings)).toEqual({ provider: "abcllm", model: "[MLX] gpt-oss-120b" });
    });
  });

  it("설정이 없으면 null — 잡이 그것을 보고 멈춘다", () => {
    withEnv(undefined, () => expect(firstReviewer(DEFAULT_CRAWL_SETTINGS)).toBeNull());
  });

  it("게이트웨이 이름의 대괄호·공백은 받고, CLI 이름의 그것은 막는다", () => {
    const parse = (firstReview: unknown) =>
      crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, firstReview });
    expect(parse({ provider: "abcllm", model: "[MLX] gpt-oss-120b" }).success).toBe(true);
    // CLI 이름은 명령 인자로 나가므로 좁게 받는다
    expect(parse({ provider: "claude-cli", model: "[MLX] gpt-oss-120b" }).success).toBe(false);
    expect(parse({ provider: "claude-cli", model: "sonnet" }).success).toBe(true);
    // 제어 문자와 셸 문자는 어느 쪽이든 막는다
    expect(parse({ provider: "abcllm", model: 'a"; rm -rf /' }).success).toBe(false);
  });

  it("칸이 아예 없는 옛 설정도 그대로 읽힌다 — 이 칸 때문에 수집이 멈추면 안 된다", () => {
    const { firstReview, ...withoutField } = DEFAULT_CRAWL_SETTINGS as Record<string, unknown>;
    void firstReview;
    const parsed = crawlSettingsSchema.safeParse(withoutField);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.firstReview).toBeUndefined();
  });
});
