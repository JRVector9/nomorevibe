import type { DecisionReason } from "@/lib/db/schema";
import type { CrawlSettings } from "./settings-schema";

/**
 * 판정 규칙.
 *
 * 순수 함수다 — DB도 네트워크도 모른다. 설정과 수집한 사실만 받아 판정을 낸다.
 * 그래서 기준을 바꿔가며 테스트하기 쉽고, 저장된 원본으로 재판정할 수 있다.
 */

/** 판정에 필요한 사실만 추린 것 (crawl_documents.repoMeta에서 뽑는다) */
export type RepoFacts = {
  repo: string;
  stars: number;
  isFork: boolean;
  ownerType: "User" | "Organization" | string;
  /** 마지막 푸시. null이면 알 수 없음 */
  pushedAt: Date | null;
  archived: boolean;
};

export type PageFacts = {
  /** 정규화된 배포 URL. null이면 homepage 미설정 */
  productUrl: string | null;
  /** 배포 URL 응답 코드. null이면 확인 못 함 */
  status: number | null;
};

export type Verdict = {
  state: "approved" | "rejected" | "needs_review";
  reason: DecisionReason;
  signals: Record<string, unknown>;
};

/**
 * `*` 와일드카드만 지원하는 단순 패턴 매칭.
 *
 * 하이픈과 밑줄을 같은 것으로 본다. 실데이터에서 `my-portfolio`는 걸리는데
 * `my_portfolio`는 통과했다 — 같은 것을 뜻하는 이름이 표기 하나로 갈리면 안 된다.
 *
 * 같은 이유로 와일드카드에 붙은 구분자는 와일드카드가 비면 함께 사라진다.
 * `*-blog`는 `my-blog`뿐 아니라 `blog`도 잡아야 한다 — 실데이터에서 이름이 그냥
 * `blog`인 개인 블로그가 `*-blog`를 통과했다.
 */
export function matchesPattern(name: string, pattern: string): boolean {
  const normalize = (s: string) => s.replace(/_/g, "-");
  // 한 번에 치환한다. 두 번 훑으면 앞 단계가 넣은 `.*`의 `*`를 다음 단계가 또 건드린다
  const body = normalize(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*-|-\*|\*/g, (m) => (m === "*-" ? "(?:.*-)?" : m === "-*" ? "(?:-.*)?" : ".*"));
  return new RegExp(`^${body}$`, "i").test(normalize(name));
}

/** URL의 호스트가 차단 목록에 있는지 (서브도메인 포함) */
export function isBlockedHost(url: string, blocked: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return true; // 파싱 안 되는 URL은 배포물이 아니다
  }
  return blocked.some((b) => {
    const domain = b.toLowerCase().replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function daysSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / 86_400_000;
}

/**
 * 후보를 판정한다.
 *
 * 순서가 중요하다. 값싸고 확실한 거르기를 먼저 해서, 사람이 볼 목록에 명백한 것이
 * 섞이지 않게 한다. 애매한 것만 needs_review로 남는다.
 */
export function judge(
  repo: RepoFacts,
  page: PageFacts,
  settings: CrawlSettings,
  now = new Date(),
): Verdict {
  const { judge: rules } = settings;
  const signals: Record<string, unknown> = {
    stars: repo.stars,
    isFork: repo.isFork,
    ownerType: repo.ownerType,
    pushAgeDays: repo.pushedAt ? Math.round(daysSince(repo.pushedAt, now)) : null,
    archived: repo.archived,
    productUrl: page.productUrl,
    pageStatus: page.status,
  };

  const reject = (reason: DecisionReason): Verdict => ({ state: "rejected", reason, signals });

  // 배포물이 없으면 제품이 아니다 — 가장 값싼 거르기
  if (!page.productUrl) return reject("no_homepage");
  if (isBlockedHost(page.productUrl, rules.blockedHomepageDomains)) return reject("not_a_product");

  if (repo.isFork && rules.excludeForks) return reject("fork");
  if (repo.archived) return reject("personal_site"); // 보관된 레포는 살아있는 제품이 아니다

  /**
   * 레포 이름과 배포 호스트를 패턴에 건다. 단 호스트는 배포물이 사이트 루트일 때만 본다.
   *
   * 호스트로 판단한다는 것은 그 사이트 전체가 그런 성격이라는 뜻이다.
   * `owner.github.io`(루트)는 개인 홈페이지지만, `owner.github.io/repo`는 그 위에 얹힌
   * 배포물 하나일 뿐이라 호스트만 보고 개인 사이트라 할 수 없다. 실데이터에서 호스트를
   * 무조건 걸었더니 GitHub Pages에 올린 진짜 제품(f1podigami, hidden-council)이
   * 함께 거부됐다. 개인 홈페이지는 레포 이름(`owner.github.io`)이나 루트 배포로 잡는다.
   *
   * 루트가 아닌 경우는 아래에서 따로 다룬다 — 확실히 거부할 수도, 통과시킬 수도 없다.
   */
  const repoName = repo.repo.split("/")[1] ?? "";
  let productHost = "";
  let productPath = "";
  try {
    const u = new URL(page.productUrl);
    productHost = u.hostname.replace(/^www\./, "");
    productPath = u.pathname.replace(/\/+$/, "");
  } catch {
    /* 위에서 이미 걸러졌다 */
  }
  const hostIsWholeSite = productPath === "";
  if (
    rules.excludedRepoPatterns.some(
      (p) => matchesPattern(repoName, p) || (hostIsWholeSite && matchesPattern(productHost, p)),
    )
  ) {
    return reject("personal_site");
  }

  // 스타 상한이 대형 오픈소스를 거른다. 하한이 아니라 상한인 것이 요지다 —
  // 갓 배포한 제품은 정당하게 스타가 0개다.
  if (repo.stars > rules.maxStars) return reject("large_oss");
  if (repo.stars < rules.minStars) return reject("large_oss");

  if (rules.excludeOrganizations && repo.ownerType === "Organization") return reject("large_oss");

  if (repo.pushedAt && daysSince(repo.pushedAt, now) > rules.maxPushAgeDays) {
    return reject("unreachable"); // 죽은 프로젝트
  }

  // 배포 URL이 살아있는지 확인 못 했으면 판단을 미룬다 (fetch가 끝나면 다시 온다)
  if (page.status === null) {
    return { state: "needs_review", reason: "ambiguous", signals };
  }
  if (page.status < 200 || page.status >= 400) return reject("unreachable");

  // 푸시 시각을 모르면 살아있는지 확신할 수 없다
  if (!repo.pushedAt && rules.holdAmbiguous) {
    return { state: "needs_review", reason: "ambiguous", signals };
  }

  /**
   * 호스트는 제외 패턴에 걸리는데 루트 배포가 아닌 것 — 규칙으로 가를 수 없다.
   *
   * 실데이터에서 `owner.github.io/repo` 14개를 눈으로 보니 웹앱과, CLI·데스크톱 도구의
   * 소개 페이지가 섞여 있었다. 우리가 모으는 것은 "배포한 서비스"이므로 후자를 자동으로
   * 통과시키면 안 되고, 전자를 자동으로 버려서도 안 된다. 사람이 가른다.
   */
  if (!hostIsWholeSite && rules.excludedRepoPatterns.some((p) => matchesPattern(productHost, p))) {
    return rules.holdAmbiguous
      ? { state: "needs_review", reason: "ambiguous", signals }
      : reject("personal_site");
  }

  return { state: "approved", reason: "passed", signals };
}

/** GitHub 레포 메타 원본에서 판정에 쓸 사실만 추린다 */
export function factsFromRepoMeta(repo: string, meta: Record<string, unknown>): RepoFacts {
  const owner = (meta.owner ?? {}) as { type?: string };
  const pushed = typeof meta.pushed_at === "string" ? new Date(meta.pushed_at) : null;
  return {
    repo,
    stars: typeof meta.stargazers_count === "number" ? meta.stargazers_count : 0,
    isFork: meta.fork === true,
    ownerType: owner.type ?? "User",
    pushedAt: pushed && !Number.isNaN(pushed.getTime()) ? pushed : null,
    archived: meta.archived === true,
  };
}
