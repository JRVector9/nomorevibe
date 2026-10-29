import { expect, it } from "vitest";
import { parseStaleReconcileArgs } from "@/lib/crawl/second-review-stale";

/** 정합 도구 인자 — 기본 dry-run, --apply 는 실행자 이름이 있어야 하고, 묶음 크기는 상한 안이어야 한다 */
it("defaults to a bounded dry-run from the first candidate", () => {
  expect(parseStaleReconcileArgs([], 200)).toEqual({ apply: false, actor: null, limit: 25, after: 0 });
  expect(parseStaleReconcileArgs(["--dry-run", "--limit", "80", "--after", "357315"], 200))
    .toEqual({ apply: false, actor: null, limit: 80, after: 357315 });
});

it("writes only with --apply and a named actor", () => {
  expect(parseStaleReconcileArgs(["--apply", "--actor", "jr"], 200)).toEqual({ apply: true, actor: "jr", limit: 25, after: 0 });
  expect(() => parseStaleReconcileArgs(["--apply"], 200)).toThrow("actor_required_for_apply");
  expect(() => parseStaleReconcileArgs(["--apply", "--actor", "--limit"], 200)).toThrow("invalid_actor");
  expect(() => parseStaleReconcileArgs(["--apply", "--dry-run", "--actor", "jr"], 200)).toThrow("conflicting_mode");
});

it("rejects batch sizes outside the cap and unknown or malformed flags", () => {
  for (const limit of ["0", "201", "-1", "1e2", "abc", undefined])
    expect(() => parseStaleReconcileArgs(limit === undefined ? ["--limit"] : ["--limit", limit], 200)).toThrow("invalid_limit");
  expect(() => parseStaleReconcileArgs(["--after", "-5"], 200)).toThrow("invalid_after");
  expect(() => parseStaleReconcileArgs(["--aply"], 200)).toThrow("unknown_argument:--aply");
  expect(parseStaleReconcileArgs(["--limit", "200"], 200).limit).toBe(200);
});
