import { describe, expect, it } from "vitest";
import { DETAIL_EDIT_PURGE, DETAIL_STATUS_PURGE, purgesLists, purgeTags } from "@/lib/cdn/purge";
import { RELEASE_BUILD_ID_ENV, takeReleaseBuildId } from "@/lib/web/release-build-id";

/**
 * 상세만 새로 받는 줄(edited·status)은 목록을 지우지 않는다 — 목록은 2분 안에 스스로 새로 받고, 지우면 홈의 지난 사본까지 사라져
 * 다음 방문이 원 서버를 기다린다. 내린 것·감사 보류가 하나라도 섞이면 목록도 지운다(2026-11-11).
 */
describe("Cloudflare 지우기 태그", () => {
  it("상세만 새로 받는 줄뿐이면 목록 태그를 싣지 않는다", () => {
    expect(purgesLists([DETAIL_EDIT_PURGE, DETAIL_STATUS_PURGE])).toBe(false);
    expect(purgeTags(["a", "b"], { lists: false })).toEqual(["p-a", "og-a", "p-b", "og-b"]);
  });

  it("내린 줄·감사 보류 줄이 섞이면 목록도 지운다", () => {
    for (const reason of ["banned", "deleted", "takedown", "audit_hold", "audit_release", "unverified"]) {
      expect(purgesLists([DETAIL_EDIT_PURGE, reason]), reason).toBe(true);
    }
    expect(purgeTags(["a", "", "a"], { lists: true })).toEqual(["p-a", "og-a", "lists"]);
    // 기본은 예전처럼 목록까지
    expect(purgeTags([""])).toEqual(["lists"]);
  });
});

describe("릴리스 빌드 ID", () => {
  it("NEXT_DEPLOYMENT_ID 를 옮기고 지운다 — Next 가 deploymentId 로 쓰지 못하게", () => {
    const env: Record<string, string | undefined> = { NEXT_DEPLOYMENT_ID: " tree-abc123 " };
    expect(takeReleaseBuildId(env)).toBe("tree-abc123");
    expect(env).toEqual({ [RELEASE_BUILD_ID_ENV]: "tree-abc123" });
    // 다시 읽어도 같은 값(옮긴 값을 먼저 본다)
    expect(takeReleaseBuildId(env)).toBe("tree-abc123");
  });

  it("값이 없으면 없음 — Next 가 빌드마다 임의 ID 를 짓는다", () => {
    const env: Record<string, string | undefined> = { NEXT_DEPLOYMENT_ID: "  " };
    expect(takeReleaseBuildId(env)).toBeUndefined();
    expect(env).toEqual({});
  });

  it("경로 조각이 될 수 없는 값은 거절한다", () => {
    for (const value of ["../x", "a/b", "-x", "x".repeat(129), "a b"]) {
      expect(() => takeReleaseBuildId({ NEXT_DEPLOYMENT_ID: value }), value).toThrow(/release build id/);
    }
    expect(takeReleaseBuildId({ NEXT_DEPLOYMENT_ID: "0123456789abcdef0123456789abcdef01234567" })).toBe("0123456789abcdef0123456789abcdef01234567");
  });
});
