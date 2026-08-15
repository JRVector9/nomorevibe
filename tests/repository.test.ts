import { describe, it, expect } from "vitest";
import { uniqueViolation } from "@/lib/domain/products/repository";

/**
 * drizzle-orm은 드라이버 에러를 DrizzleQueryError로 감싸고 원본을 cause에 넣는다.
 * 겉 객체만 보면 code가 undefined라 unique 위반 처리가 통째로 죽는다 (2차 리뷰 F2).
 */
describe("uniqueViolation — DrizzleQueryError 언래핑 (2차 리뷰 F2 회귀)", () => {
  it("cause에 감싸인 postgres 에러에서 제약명을 찾는다", () => {
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: Object.assign(new Error("duplicate key"), {
        code: "23505",
        constraint_name: "products_slug_unique",
      }),
    });
    expect(uniqueViolation(wrapped)).toBe("products_slug_unique");
  });

  it("감싸지 않은 에러도 그대로 읽는다", () => {
    const raw = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "products_url_unique",
    });
    expect(uniqueViolation(raw)).toBe("products_url_unique");
  });

  it("여러 겹으로 감싸여도 따라간다", () => {
    const deep = Object.assign(new Error("a"), {
      cause: Object.assign(new Error("b"), {
        cause: Object.assign(new Error("c"), { code: "23505", constraint_name: "x_unique" }),
      }),
    });
    expect(uniqueViolation(deep)).toBe("x_unique");
  });

  it("unique 위반이 아니면 null을 반환한다", () => {
    expect(uniqueViolation(new Error("connection refused"))).toBeNull();
    expect(uniqueViolation(Object.assign(new Error("x"), { code: "23503" }))).toBeNull();
    expect(uniqueViolation(null)).toBeNull();
  });

  it("cause 순환 참조에도 멈춘다", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(uniqueViolation(a)).toBeNull();
  });
});
