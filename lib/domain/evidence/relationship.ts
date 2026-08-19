import type { RelationshipState } from "@/lib/db/product-evidence-schema";

export function relationshipState(input: {
  makerDeclared: boolean;
  siteLinksRepository: boolean;
  repositoryLinksCanonicalSite: boolean;
  previouslyConnected: boolean;
}): RelationshipState {
  if (input.siteLinksRepository && input.repositoryLinksCanonicalSite) return "bidirectional";
  if (input.siteLinksRepository) return "site_link";
  if (input.repositoryLinksCanonicalSite) return "repository_link";
  if (input.makerDeclared && !input.previouslyConnected) return "maker_reported";
  return "disconnected";
}
