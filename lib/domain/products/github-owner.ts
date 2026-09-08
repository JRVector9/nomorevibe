export type GitHubRepositoryOwner = {
  login: string;
  profileUrl: string;
  repositoryUrl: string;
  avatarUrl: string;
};

const GITHUB_SEGMENT = /^[a-zA-Z0-9_.-]+$/;

/** A product repository is the only public identity signal we can safely attribute before claim. */
export function githubOwnerFromRepositoryUrl(input: string | null | undefined): GitHubRepositoryOwner | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if ((url.protocol !== "https:" && url.protocol !== "http:") || host !== "github.com") return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;

  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length !== 2) return null;
  const login = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  if (!GITHUB_SEGMENT.test(login) || !GITHUB_SEGMENT.test(repository)) return null;

  const profileUrl = `https://github.com/${login}`;
  return {
    login,
    profileUrl,
    repositoryUrl: `${profileUrl}/${repository}`,
    avatarUrl: `${profileUrl}.png?size=96`,
  };
}
