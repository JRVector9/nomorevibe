import { describe, expect, it } from "vitest";
import { decideOwnership, parseClaimInput, parseRepoUrl, productRepoRef, repositoryIdFromNodeId, sameRepository } from "@/lib/me/maker-claims";

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

describe("productRepoRef — 제품에 적힌 주소는 저장소 바로 그 주소만", () => {
  it.each([
    ["https://github.com/Hanul/Tiny-Cron", "hanul/tiny-cron"],
    ["http://www.github.com/hanul/tiny-cron.git", "hanul/tiny-cron"],
    ["https://github.com/hanul/tiny-cron/", "hanul/tiny-cron"],
  ])("%s → %s", (input, fullName) => {
    expect(productRepoRef(input)?.fullName).toBe(fullName);
  });

  it.each([
    // 공용 저장소의 한 폴더는 다른 사람의 앱일 수 있다 — 저장소 주인을 그 제품의 주인으로 보지 않는다
    "https://github.com/alice/hackathon/tree/main/teams/bob-app", "https://github.com/hanul/tiny-cron/tree/main",
    "https://github.com/hanul/tiny-cron?tab=readme-ov-file", "https://github.com/hanul/tiny-cron#readme", "https://gitlab.com/hanul/tiny-cron", null, "",
  ])("저장소가 아니다: %s", (input) => {
    expect(productRepoRef(input)).toBeNull();
  });
});

describe("저장소 node id → 숫자 id", () => {
  it("옛 모양(base64 \"010:Repository<id>\")과 새 모양(R_ + msgpack)을 읽는다", () => {
    expect(repositoryIdFromNodeId("MDEwOlJlcG9zaXRvcnkxMjk2MjY5")).toBe(1296269);
    expect(repositoryIdFromNodeId("R_kgDOGNw4Iw")).toBe(0x18dc3823);
    expect(repositoryIdFromNodeId(`R_${Buffer.from([0x92, 0x00, 0x2a]).toString("base64url")}`)).toBe(42);
    expect(repositoryIdFromNodeId("MDQ6VXNlcjU4MzIzMQ==")).toBeNull(); // 사용자 node id
    expect(repositoryIdFromNodeId("not-a-node-id")).toBeNull();
  });

  it("전에 본 id 와 지금 답을 맞춘다 — 답에 id 가 없으면 같다고 하지 않는다", () => {
    const fact = { ownerId: 1, ownerType: "User", private: false, repoId: 1296269, nodeId: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5" };
    expect(sameRepository({ repoId: 1296269 }, fact)).toBe(true);
    expect(sameRepository({ nodeId: "MDEwOlJlcG9zaXRvcnkxMjk2MjY5" }, fact)).toBe(true);
    expect(sameRepository({ nodeId: "R_kgDOGNw4Iw" }, fact)).toBe(false);
    expect(sameRepository({ nodeId: "opaque" }, { ...fact, nodeId: "opaque" })).toBe(true);
    expect(sameRepository({ repoId: 1296269 }, { ownerId: 1, ownerType: "User", private: false })).toBe(false);
  });
});

describe("decideOwnership — 주인 판정(순수)", () => {
  const user = { ownerId: 4810, ownerType: "User", private: false, repoId: 11 };
  const seen = [{ repoId: 11 }];

  it("개인 저장소의 주인 숫자 id 가 같고 전에 본 저장소면 통과", () => {
    expect(decideOwnership([4810], user, seen)).toEqual({ ok: true, githubUserId: 4810 });
  });

  it("이름이 바뀐 계정도 숫자 id 만 보므로 통과한다(login 은 판정에 들어가지 않는다)", () => {
    expect(decideOwnership([99, 4810], { ...user }, seen)).toEqual({ ok: true, githubUserId: 4810 });
  });

  it("주인 id 가 다르면(옮겨 간 저장소) 거절", () => {
    expect(decideOwnership([4811], user, seen)).toEqual({ ok: false, reason: "owner_mismatch" });
    expect(decideOwnership([], user, seen)).toEqual({ ok: false, reason: "owner_mismatch" });
  });

  it("전에 본 저장소 id 가 없으면 지금 이름 주인을 믿지 않는다(repo_unverified) — 수집하지 않은 등록 제품의 이름 차지", () => {
    expect(decideOwnership([4810], user, [])).toEqual({ ok: false, reason: "repo_unverified" });
  });

  it("전에 본 id 와 하나라도 다르면 같은 이름의 다른 저장소다(repo_replaced)", () => {
    expect(decideOwnership([4810], { ...user, repoId: 99 }, seen)).toEqual({ ok: false, reason: "repo_replaced" });
    expect(decideOwnership([4810], user, [{ repoId: 11 }, { repoId: 99 }])).toEqual({ ok: false, reason: "repo_replaced" });
    expect(decideOwnership([4810], { ...user, repoId: undefined }, seen)).toEqual({ ok: false, reason: "repo_replaced" });
  });

  it("조직 저장소는 아직 받지 않는다 — id 가 같아도", () => {
    expect(decideOwnership([4810], { ...user, ownerType: "Organization" }, seen)).toEqual({ ok: false, reason: "org_repo_not_supported_yet" });
  });

  it("개인·조직이 아닌 주인 종류와 이상한 id 는 거절", () => {
    expect(decideOwnership([4810], { ...user, ownerType: "Bot" }, seen)).toEqual({ ok: false, reason: "owner_mismatch" });
    expect(decideOwnership([0], { ...user, ownerId: 0 }, seen)).toEqual({ ok: false, reason: "owner_mismatch" });
  });

  it("없는 저장소·비공개 저장소는 거절", () => {
    expect(decideOwnership([4810], null, seen)).toEqual({ ok: false, reason: "repo_not_found" });
    expect(decideOwnership([4810], { ...user, private: true }, seen)).toEqual({ ok: false, reason: "repo_not_public" });
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
