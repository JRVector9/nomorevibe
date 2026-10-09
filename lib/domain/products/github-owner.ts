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

/** 상세 '운영 주체' — 저장소를 지금 가진 계정과, 등록한 주소가 가리키던 다른 계정 */
export type RepositoryOperator = {
  /** 운영 주체 — GitHub 이 지금 이 저장소의 주인이라고 답한 계정 */
  owner: GitHubRepositoryOwner;
  /** 등록한 저장소 주소(repoUrl)의 계정이 지금 주인과 다르면 그 계정 — '주요 기여자'로 따로 붙인다. 같으면 null */
  contributor: GitHubRepositoryOwner | null;
};

/**
 * 운영 주체를 정한다(2026-10-08 UX 감사 UX-15).
 *
 * 등록한 저장소 주소(repoUrl)는 저장소를 옮기기 전 주소일 수 있다 — GitHub 은 옛 주소를 새 주소로 넘겨 주고,
 * 사실 수집(evidence/providers/github.ts)은 넘겨받은 저장소의 정식 주소(html_url)를 남긴다. LCU 는 repoUrl 이
 * github.com/0xpolarzero/lcu 지만 저장소는 amontlabs 조직으로 옮겨졌다(커밋 437건 중 435건이 0xpolarzero, 2026-10-09).
 * 그래서 주인은 관측한 정식 주소의 계정으로 하고, repoUrl 의 계정과 대조해 다르면 그 계정을 따로 돌려준다.
 * 관측한 주소가 아직 없으면 repoUrl 의 계정이 주인이다. repoUrl 이 GitHub 저장소가 아니면 null — 관측한 주소는
 * 그 저장소의 정식 주소를 고칠 때만 쓴다(메이커가 따로 알려 준 저장소 링크로 운영 주체를 새로 짓지 않는다).
 */
export function repositoryOperator(repoUrl: string | null | undefined, observedRepositoryUrl?: string | null): RepositoryOperator | null {
  const listed = githubOwnerFromRepositoryUrl(repoUrl);
  if (!listed) return null;
  const observed = githubOwnerFromRepositoryUrl(observedRepositoryUrl);
  // GitHub 계정 이름은 대소문자를 가리지 않는다
  const moved = observed !== null && listed.login.toLowerCase() !== observed.login.toLowerCase();
  return { owner: observed ?? listed, contributor: moved ? listed : null };
}
