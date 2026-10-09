import { describe, expect, it } from "vitest";
import { githubOwnerFromRepositoryUrl, repositoryOperator } from "@/lib/domain/products/github-owner";

describe("githubOwnerFromRepositoryUrl", () => {
  it("preserves the public login while producing canonical profile and repository URLs", () => {
    expect(githubOwnerFromRepositoryUrl("https://github.com/AgentWorkforce/relay"))
      .toEqual({
        login: "AgentWorkforce",
        profileUrl: "https://github.com/AgentWorkforce",
        repositoryUrl: "https://github.com/AgentWorkforce/relay",
        avatarUrl: "https://github.com/AgentWorkforce.png?size=96",
      });
  });

  it.each([
    null,
    "",
    "https://gitlab.com/acme/app",
    "https://github.com/acme",
    "https://github.com/acme/app/issues",
    "https://github.com/acme/app?tab=readme",
    "javascript:alert(1)",
  ])("rejects a non-canonical repository URL: %s", (value) => {
    expect(githubOwnerFromRepositoryUrl(value)).toBeNull();
  });
});

describe("repositoryOperator — 운영 주체를 저장소 주인과 대조한다(UX-15)", () => {
  it("옮겨진 저장소는 지금 주인을 운영 주체로, 등록한 주소의 계정은 주요 기여자로 — amontlabs/lcu", () => {
    // 등록한 주소는 개인 계정, GitHub 이 넘겨준 정식 주소는 조직(2026-10-08 감사 detail-lcu)
    const operator = repositoryOperator("https://github.com/0xpolarzero/lcu", "https://github.com/amontlabs/lcu");
    expect(operator?.owner.login).toBe("amontlabs");
    expect(operator?.owner.profileUrl).toBe("https://github.com/amontlabs");
    expect(operator?.contributor?.login).toBe("0xpolarzero");
  });

  it("주소가 같으면(대소문자만 달라도) 따로 붙일 계정이 없다", () => {
    expect(repositoryOperator("https://github.com/acme/app", "https://github.com/acme/app")).toMatchObject({ owner: { login: "acme" }, contributor: null });
    expect(repositoryOperator("https://github.com/ACME/app", "https://github.com/acme/app")?.contributor).toBeNull();
  });

  it("아직 저장소를 읽지 않았으면 등록한 주소의 계정, GitHub 저장소가 아니면 없다", () => {
    expect(repositoryOperator("https://github.com/acme/app", null)).toMatchObject({ owner: { login: "acme" }, contributor: null });
    expect(repositoryOperator("https://gitlab.com/acme/app", null)).toBeNull();
    expect(repositoryOperator(null, undefined)).toBeNull();
    // 등록한 저장소가 없으면 따로 알려 준 저장소 링크로 운영 주체를 짓지 않는다
    expect(repositoryOperator(null, "https://github.com/acme/app")).toBeNull();
  });
});
