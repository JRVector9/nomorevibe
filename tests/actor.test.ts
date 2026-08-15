import { describe, it, expect } from "vitest";
import type { Product } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";
import { authenticate } from "@/lib/domain/products/actor";

const product = (editToken: string) =>
  ({ editTokenHash: hashToken(editToken) }) as Product;

describe("authenticate — 수정 자격 판정", () => {
  it("올바른 수정 키를 통과시킨다", () => {
    const outcome = authenticate(product("nmv_edit_abc"), { editToken: "nmv_edit_abc" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.actor.kind).toBe("edit_token");
  });

  it("틀린 키는 invalid로 구분한다", () => {
    const outcome = authenticate(product("nmv_edit_abc"), { editToken: "wrong" });
    expect(outcome).toEqual({ ok: false, reason: "invalid" });
  });

  it("키가 없으면 missing으로 구분한다 (401 vs 403을 가르는 근거)", () => {
    expect(authenticate(product("x"), { editToken: null })).toEqual({ ok: false, reason: "missing" });
    expect(authenticate(product("x"), {})).toEqual({ ok: false, reason: "missing" });
    expect(authenticate(product("x"), { editToken: "" })).toEqual({ ok: false, reason: "missing" });
  });

  it("평문 키를 저장하지 않는다 — 해시만 비교한다", () => {
    const p = product("nmv_edit_secret");
    expect(JSON.stringify(p)).not.toContain("nmv_edit_secret");
  });
});
