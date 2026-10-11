export type GithubRepositoryName = { owner: string; repo: string; fullName: string; htmlUrl: string };
export type GithubRepository = GithubRepositoryName & {
  id: number;
  private: boolean;
  archived: boolean;
  hasIssues: boolean;
  permissions?: { admin: boolean; maintain: boolean; push: boolean };
};

export function isGithubNumericId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isGithubRepositoryName(owner: unknown, repo: unknown): owner is string {
  return typeof owner === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(owner)
    && typeof repo === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(repo) && repo !== "." && repo !== "..";
}

/** Parse only repository roots; URL normalization must not conceal traversal or credentials. */
export function parseGithubRepository(url: string): GithubRepositoryName | null {
  if (typeof url !== "string" || /[\\\x00-\x20%?#]/.test(url) || url.split("/").some(part => part === "." || part === "..")) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.origin !== "https://github.com" || parsed.username || parsed.password) return null;
  const match = /^\/([^/]+)\/([^/]+)\/?$/.exec(parsed.pathname);
  if (!match) return null;
  const owner = match[1], repo = match[2].replace(/\.git$/, "");
  if (!isGithubRepositoryName(owner, repo)) return null;
  return { owner, repo, fullName: `${owner}/${repo}`, htmlUrl: `https://github.com/${owner}/${repo}` };
}
export function githubRepositoryPath(repository: Pick<GithubRepositoryName, "owner" | "repo">): string {
  if (!isGithubRepositoryName(repository.owner, repository.repo)) throw new Error("github_invalid_request");
  return `/repos/${repository.owner}/${repository.repo}`;
}

/** Names may change; the caller's persisted numeric ID must still match. */
export function parseGithubRepositoryResponse(value: unknown, expectedId?: number): GithubRepository | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!isGithubNumericId(data.id) || (expectedId !== undefined && (!isGithubNumericId(expectedId) || data.id !== expectedId))) return null;
  const owner = data.owner && typeof data.owner === "object" ? (data.owner as Record<string, unknown>).login : undefined;
  if (!isGithubRepositoryName(owner, data.name) || typeof data.name !== "string" || typeof data.html_url !== "string") return null;
  const repository = parseGithubRepository(data.html_url);
  const fullName = `${owner}/${data.name}`;
  if (!repository || repository.fullName.toLowerCase() !== fullName.toLowerCase()
    || typeof data.full_name !== "string" || data.full_name.toLowerCase() !== fullName.toLowerCase()
    || typeof data.private !== "boolean" || typeof data.archived !== "boolean" || typeof data.has_issues !== "boolean") return null;
  let permissions: GithubRepository["permissions"];
  if (data.permissions !== undefined) {
    if (!data.permissions || typeof data.permissions !== "object" || Array.isArray(data.permissions)) return null;
    const input = data.permissions as Record<string, unknown>;
    if (["admin", "maintain", "push"].some(key => input[key] !== undefined && typeof input[key] !== "boolean")) return null;
    permissions = { admin: input.admin === true, maintain: input.maintain === true, push: input.push === true };
  }
  return { id: data.id, ...repository, private: data.private, archived: data.archived, hasIssues: data.has_issues, ...(permissions && { permissions }) };
}
