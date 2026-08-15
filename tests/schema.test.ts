import { describe, it, expect } from "vitest";
import { registerSchema, updateSchema, LIMITS } from "@/lib/domain/products/schema";

const valid = {
  url: "https://example.com",
  name: "simpleHWP",
  tagline: "브라우저에서 HWP 파일을 여는 도구",
  description: "한글 오피스 없이 .hwp를 브라우저에서 엽니다.",
  category: "Productivity" as const,
};

describe("registerSchema", () => {
  it("최소 필드로 통과한다", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });

  it("필수 필드가 빠지면 거부한다", () => {
    for (const field of ["url", "name", "tagline", "description", "category"] as const) {
      const body = { ...valid };
      delete body[field];
      expect(registerSchema.safeParse(body).success, field).toBe(false);
    }
  });

  it("허용목록 밖의 category를 거부한다", () => {
    expect(registerSchema.safeParse({ ...valid, category: "Nope" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, category: "" }).success).toBe(false);
  });

  it("description 길이 상한을 강제한다 (2차 리뷰 F6 회귀)", () => {
    expect(registerSchema.safeParse({ ...valid, description: "A".repeat(LIMITS.description) }).success).toBe(true);
    expect(registerSchema.safeParse({ ...valid, description: "A".repeat(LIMITS.description + 1) }).success).toBe(false);
  });

  it("repo_url의 javascript: 스킴을 거부한다 (1차 리뷰 F3 회귀)", () => {
    expect(registerSchema.safeParse({ ...valid, repo_url: "javascript:alert(1)" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, repo_url: "https://github.com/a/b" }).success).toBe(true);
  });

  it("stack을 개수·항목길이 상한으로 자른다", () => {
    const parsed = registerSchema.parse({
      ...valid,
      stack: Array.from({ length: 30 }, () => "X".repeat(100)),
    });
    expect(parsed.stack).toHaveLength(LIMITS.stackItems);
    expect(parsed.stack![0]).toHaveLength(LIMITS.stackItemLength);
  });
});

describe("updateSchema — POST와 같은 규칙을 공유한다", () => {
  it("빈 문자열 category를 거부한다 (2차 리뷰 F3 회귀)", () => {
    // 예전엔 `if (body.category && ...)` 라서 빈 문자열이 검증을 건너뛰고 저장됐다
    expect(updateSchema.safeParse({ category: "" }).success).toBe(false);
  });

  it("description 상한이 POST와 동일하다", () => {
    expect(updateSchema.safeParse({ description: "A".repeat(LIMITS.description + 1) }).success).toBe(false);
  });

  it("repo_url 스킴 검증이 POST와 동일하다", () => {
    expect(updateSchema.safeParse({ repo_url: "javascript:alert(1)" }).success).toBe(false);
  });

  it("url 수정 시도를 거부한다 (소유권의 기준이라 변경 불가)", () => {
    expect(updateSchema.safeParse({ url: "https://other.com" }).success).toBe(false);
  });

  it("부분 수정을 허용한다", () => {
    expect(updateSchema.safeParse({ tagline: "새 소개" }).success).toBe(true);
    expect(updateSchema.safeParse({}).success).toBe(true);
  });
});
