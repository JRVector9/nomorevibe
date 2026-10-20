import { describe, expect, it } from "vitest";
import { decideOwnership, parseClaimInput, parseRepoUrl } from "@/lib/me/maker-claims";

describe("parseRepoUrl — 저장소 주소에서 owner/repo 뽑기", () => {
  it.each([
    ["https://github.com/Hanul/Tiny-Cron", "hanul/tiny-cron"],
    ["http://www.github.com/hanul/tiny-cron.git", "hanul/tiny-cron"],
    ["https://github.com/hanul/tiny-cron/", "hanul/tiny-cron"],
    ["https://github.com/hanul/tiny-cron/tree/main/docs?tab=readme#top", "hanul/tiny-cron"],
    ["github.com/Hanul/tiny-cron", "hanul/tiny-cron"],
    ["  www.github.com/hanul/tiny.cron  ", "hanul/tiny.cron"],
    ["Hanul/Tiny_Cron", "hanul/tiny_cron"],
  ])("%s → %s (소문자)", (input, fullName) => {
    const ref = parseRepoUrl(input);
    expect(ref?.fullName).toBe(fullName);
    expect(ref?.url).toBe(`https://github.com/${fullName}`);
  });

  it.each([
    "", "   ", "https://gitlab.com/hanul/tiny-cron", "https://github.com/hanul", "https://github.com/", "https://user:pw@github.com/hanul/app",
    "https://github.com:8443/hanul/app", "ftp://github.com/hanul/app", "https://github.com/-bad/app", "https://github.com/hanul/..",
    "hanul/app/extra", "hanul", "javascript:alert(1)", "https://evil.example/github.com/hanul/app", "https://github.com.evil.example/hanul/app",
    "https://github.com/ha nul/app", `https://github.com/${"a".repeat(40)}/app`, `https://github.com/hanul/${"r".repeat(301)}`,
  ])("거절: %s", (input) => {
    expect(parseRepoUrl(input)).toBeNull();
  });

  it("문자열이 아니면 거절", () => {
    expect(parseRepoUrl(null)).toBeNull();
    expect(parseRepoUrl(42)).toBeNull();
  });
});

describe("decideOwnership — 주인 판정(순수)", () => {
  const user = { ownerId: 4810, ownerType: "User", private: false };

  it("개인 저장소의 주인 숫자 id 가 같으면 통과", () => {
    expect(decideOwnership([4810], user)).toEqual({ ok: true, githubUserId: 4810 });
  });

  it("이름이 바뀐 계정도 숫자 id 만 보므로 통과한다(login 은 판정에 들어가지 않는다)", () => {
    expect(decideOwnership([99, 4810], { ...user })).toEqual({ ok: true, githubUserId: 4810 });
  });

  it("주인 id 가 다르면(옮겨 간 저장소) 거절", () => {
    expect(decideOwnership([4811], user)).toEqual({ ok: false, reason: "owner_mismatch" });
    expect(decideOwnership([], user)).toEqual({ ok: false, reason: "owner_mismatch" });
  });

  it("조직 저장소는 아직 받지 않는다 — id 가 같아도", () => {
    expect(decideOwnership([4810], { ...user, ownerType: "Organization" })).toEqual({ ok: false, reason: "org_repo_not_supported_yet" });
  });

  it("개인·조직이 아닌 주인 종류와 이상한 id 는 거절", () => {
    expect(decideOwnership([4810], { ...user, ownerType: "Bot" })).toEqual({ ok: false, reason: "owner_mismatch" });
    expect(decideOwnership([0], { ...user, ownerId: 0 })).toEqual({ ok: false, reason: "owner_mismatch" });
  });

  it("없는 저장소·비공개 저장소는 거절", () => {
    expect(decideOwnership([4810], null)).toEqual({ ok: false, reason: "repo_not_found" });
    expect(decideOwnership([4810], { ...user, private: true })).toEqual({ ok: false, reason: "repo_not_public" });
  });
});

describe("parseClaimInput — 요청 본문", () => {
  it("productIds 는 1~20개, 겹치면 하나로", () => {
    expect(parseClaimInput({ productIds: [3, 3, 7] })).toEqual({ productIds: [3, 7] });
    expect(parseClaimInput({ repoUrl: "hanul/app" })).toEqual({ repoUrl: "hanul/app" });
  });

  it.each([
    null, [], {}, { productIds: [] }, { productIds: Array.from({ length: 21 }, (_, i) => i + 1) }, { productIds: [0] }, { productIds: [1.5] },
    { productIds: ["1"] }, { productIds: [1], repoUrl: "a/b" }, { repoUrl: 1 }, { other: true },
  ])("거절: %j", (input) => {
    expect(() => parseClaimInput(input)).toThrow(expect.objectContaining({ code: "invalid_request", status: 400 }));
  });
});

describe("재확인 잡 등록", () => {
  it("GitHub 수집 자격이 있는 crawler 에서 한 시간마다 돈다", async () => {
    const { JOB_CATALOG, jobsForRole } = await import("@/lib/jobs/catalog");
    expect(JOB_CATALOG.find((job) => job.name === "maker-recheck")).toEqual({ name: "maker-recheck", role: "crawler", intervalMs: 60 * 60_000 });
    expect(jobsForRole("crawler")).toContain("maker-recheck");
    expect(jobsForRole("maintenance")).not.toContain("maker-recheck");
  });
});
