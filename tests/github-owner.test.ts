import { describe, expect, it } from "vitest";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";

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
