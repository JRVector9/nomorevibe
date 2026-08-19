import { describe, expect, it } from "vitest";
import { relationshipState } from "@/lib/domain/evidence/relationship";

describe("repository relationship evidence", () => {
  it.each([
    [{ makerDeclared: true, siteLinksRepository: true, repositoryLinksCanonicalSite: true, previouslyConnected: false }, "bidirectional"],
    [{ makerDeclared: false, siteLinksRepository: true, repositoryLinksCanonicalSite: false, previouslyConnected: false }, "site_link"],
    [{ makerDeclared: false, siteLinksRepository: false, repositoryLinksCanonicalSite: true, previouslyConnected: false }, "repository_link"],
    [{ makerDeclared: true, siteLinksRepository: false, repositoryLinksCanonicalSite: false, previouslyConnected: false }, "maker_reported"],
    [{ makerDeclared: false, siteLinksRepository: false, repositoryLinksCanonicalSite: false, previouslyConnected: true }, "disconnected"],
  ] as const)("classifies independent link observations", (input, expected) => {
    expect(relationshipState(input)).toBe(expected);
  });

  it("does not infer a connected state from names or maker declaration alone", () => {
    expect(relationshipState({
      makerDeclared: false,
      siteLinksRepository: false,
      repositoryLinksCanonicalSite: false,
      previouslyConnected: false,
    })).toBe("disconnected");
  });
});
