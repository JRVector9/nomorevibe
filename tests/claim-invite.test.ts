import { describe, it, expect } from "vitest";
import { claimInviteUrl } from "@/lib/domain/products/claim-invite";

const seeded = {
  name: "FoundApp",
  slug: "found-app",
  repoUrl: "https://github.com/someone/found-app",
  source: "crawler" as const,
  claimedAt: null,
};

describe("클레임 초대 링크", () => {
  it("레포의 새 이슈 화면을 제목·본문이 채워진 채로 연다", () => {
    const url = claimInviteUrl(seeded, "https://nomorevibe.app");

    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/someone/found-app/issues/new");
    expect(parsed.searchParams.get("title")).toContain("FoundApp");
    const body = parsed.searchParams.get("body")!;
    expect(body).toContain("https://nomorevibe.app/p/found-app");
    expect(body).toContain("/nomorevibe");
    expect(body).toContain("takedown");
  });

  it("발견 경위를 단정하지 않는다 — 커밋을 본 적 없이 찾은 레포도 있다", () => {
    const body = new URL(claimInviteUrl(seeded, "https://nomorevibe.app")!).searchParams.get("body")!;

    expect(body).toContain("public signals");
    expect(body).not.toContain("We found this repository through its AI co-authored commits");
  });

  it("이슈에 실을 수 없는 주소로는 만들지 않는다", () => {
    // NEXT_PUBLIC_SITE_URL이 비면 origin이 여기로 떨어진다 — 받는 사람은 열 수 없는 링크다
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3200", "http://[::1]:3000", "설정 없음"]) {
      expect(claimInviteUrl(seeded, origin), origin).toBeNull();
    }
  });

  it(".git 접미사와 끝 슬래시를 받아준다", () => {
    for (const repoUrl of ["https://github.com/a/b.git", "https://github.com/a/b/", "http://GitHub.com/a/b"]) {
      expect(claimInviteUrl({ ...seeded, repoUrl }, "https://x.test")).toContain("github.com/a/b/issues/new");
    }
  });

  it("GitHub 레포가 아니면 만들지 않는다 — 이슈를 열 곳이 없다", () => {
    expect(claimInviteUrl({ ...seeded, repoUrl: null }, "https://x.test")).toBeNull();
    expect(claimInviteUrl({ ...seeded, repoUrl: "https://gitlab.com/a/b" }, "https://x.test")).toBeNull();
    expect(claimInviteUrl({ ...seeded, repoUrl: "https://github.com/a" }, "https://x.test")).toBeNull();
  });

  it("주인이 있는 제품은 초대하지 않는다", () => {
    expect(claimInviteUrl({ ...seeded, claimedAt: new Date() }, "https://x.test")).toBeNull();
    expect(claimInviteUrl({ ...seeded, source: "skill" }, "https://x.test")).toBeNull();
  });
});
