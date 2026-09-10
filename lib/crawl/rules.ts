import type { DecisionReason } from "@/lib/db/schema";
import type { CrawlSettings } from "./settings-schema";
import { summarizeAgentEvidence, type SummaryInput } from "@/lib/domain/evidence/agents/summary";

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
  /** 레포 설명. 이름과 URL에 단서가 없을 때 여기에만 있는 경우가 있다 */
  description: string;
};

export type PageFacts = {
  /** 정규화된 배포 URL. null이면 homepage 미설정 */
  productUrl: string | null;
  /** 배포 URL 응답 코드. null이면 확인 못 함 */
  status: number | null;
  /** 감지된 문서 생성기. 없거나 아직 안 본 문서면 null */
  generator?: string | null;
  /** 페이지 제목(og:title 또는 <title>). 스캐폴드 기본값을 가려내는 데 쓴다 */
  title?: string | null;
};

/**
 * 판정이 지나온 규칙 하나.
 *
 * 심사 화면이 "어디까지 통과했고 어디서 멈췄는지"를 그대로 보여주기 위한 것이다.
 * 화면이 규칙을 따로 구현하면 반드시 어긋나므로, 판정하면서 여기에 남긴다.
 */
export type RuleStep = { rule: string; detail: string; passed: boolean };

/**
 * 규칙으로 가르지 못한 이유. reason은 전부 "ambiguous"로 뭉뚱그려지지만
 * 사람이 할 판단은 갈래마다 다르다 — 묶어서 처리하려면 갈래를 알아야 한다.
 */
export type AmbiguityCause =
  | "page_status_unknown"
  | "push_time_unknown"
  | "host_excluded_subpath"
  | "agent_evidence";

export type Verdict = {
  state: "approved" | "rejected" | "needs_review";
  reason: DecisionReason;
  signals: Record<string, unknown>;
  /** 지나온 규칙. 마지막 항목이 멈춘 지점이다 */
  trace: RuleStep[];
  /** needs_review 일 때만 채워진다 */
  cause?: AmbiguityCause;
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

/**
 * 문서 제목 규칙을 적용할 최대 단어 수.
 *
 * 실측 오탐이 13단어짜리 소개문이었고, 실제 문서 제목("Elastic Docs", "temple8 — Documentation")은
 * 셋을 넘지 않았다. 다섯이면 둘 사이가 넉넉히 벌어진다.
 */
export const DOCS_TITLE_MAX_WORDS = 5;

/**
 * 마지막 푸시가 오래됐다는 규칙의 이름.
 *
 * 발행분 재검수가 이 규칙만 따로 걸러내야 해서 한 곳에 둔다 — 화면과 규칙이 각자
 * 문자열을 적으면 한쪽만 고쳐졌을 때 조용히 어긋난다.
 */
export const PUSH_AGE_RULE = "방치 기준 이내";

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

/**
 * 문서 사이트인지.
 *
 * 도메인 목록으로는 못 잡는다 — docs.datadoghq.com, docs.owid.io, rocm.docs.amd.com,
 * kestra.io/docs/... 넷이 실데이터에서 나왔는데 호스트도 경로도 제각각이고 공통점은
 * "docs 라벨"뿐이다. 문서는 읽을거리이지 배포된 서비스가 아니다.
 */
export function isDocumentation(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)docs?\./i.test(u.hostname) || /^\/docs?(\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** 표시용 호스트. 파싱 실패는 위에서 이미 걸러진다 */
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
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
  agentEvidence?: SummaryInput,
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
    generator: page.generator ?? null,
    pageTitle: page.title ?? null,
  };

  const trace: RuleStep[] = [];
  /** 통과한 규칙 — 측정값과 기준을 함께 남긴다 */
  const pass = (rule: string, detail: string) => { trace.push({ rule, detail, passed: true }); };
  const reject = (reason: DecisionReason, rule: string, detail: string): Verdict => {
    trace.push({ rule, detail, passed: false });
    return { state: "rejected", reason, signals, trace };
  };
  const hold = (reason: DecisionReason, cause: AmbiguityCause, rule: string, detail: string): Verdict => {
    trace.push({ rule, detail, passed: false });
    return { state: "needs_review", reason, signals, trace, cause };
  };

  // 배포물이 없으면 제품이 아니다 — 가장 값싼 거르기
  if (!page.productUrl) return reject("no_homepage", "배포 URL 있음", "homepage 미설정");
  pass("배포 URL 있음", page.productUrl);
  if (isBlockedHost(page.productUrl, rules.blockedHomepageDomains)) {
    return reject("not_a_product", "차단 도메인 아님", `${hostOf(page.productUrl)} 는 차단 목록에 있음`);
  }
  pass("차단 도메인 아님", `${hostOf(page.productUrl)} 미등록`);
  if (isDocumentation(page.productUrl)) return reject("not_a_product", "문서 URL 아님", "docs 라벨 또는 /docs 경로");
  pass("문서 URL 아님", "docs 라벨·경로 아님");

  /**
   * 페이지가 스스로 밝히는 문서 생성기.
   *
   * 주소만으로는 못 가른다 — owner.github.io/repo 아래에 문서와 웹앱이 섞여 있어 심사 큐의
   * 92%가 그 모양이었다. 페이지가 mkdocs·pkgdown 같은 것으로 만들어졌다면 읽을거리다.
   */
  if (page.generator && rules.docsGenerators.includes(page.generator.toLowerCase())) {
    return reject("not_a_product", "문서 생성기 아님", `${page.generator} 로 만들어짐`);
  }
  pass("문서 생성기 아님", page.generator ? `${page.generator} (문서 생성기 아님)` : "generator 표기 없음");

  /**
   * 프레임워크가 만들어 준 제목을 그대로 배포한 것.
   *
   * 실데이터에서 "Create Next App"이 셋, "Document"와 "Svelte app"이 하나씩 목록에 올라
   * 있었다. 제목을 안 바꿨다는 것은 아직 아무것도 만들지 않았다는 뜻이다. 같은 제목이
   * 여럿이면 목록이 스스로 못 미더워 보인다.
   */
  const pageTitle = page.title?.trim().toLowerCase() ?? "";
  if (pageTitle && rules.placeholderTitles.some((t) => t.toLowerCase() === pageTitle)) {
    return reject("not_a_product", "스캐폴드 제목 아님", `제목이 “${page.title}” — 프레임워크 기본값`);
  }
  pass("스캐폴드 제목 아님", page.title ? `“${page.title}”` : "제목 없음");

  /**
   * 문서 제목은 짧을 때만 본다.
   *
   * "* docs"는 끝만 보는데도 한 문장짜리 소개문의 마지막 단어를 집는다. 실제로
   * "BFFless — The home for your AI-generated apps, internal tools, and HTML docs"가
   * 걸려 내릴 뻔했다. 문서 사이트는 자기 제목을 "Elastic Docs"처럼 짧게 단다 —
   * 문장을 제목으로 다는 것은 자기를 설명하려는 제품 쪽이다.
   */
  const titleWords = pageTitle ? pageTitle.split(/\s+/).filter(Boolean).length : 0;
  const docsTitle = titleWords > 0 && titleWords <= DOCS_TITLE_MAX_WORDS
    ? rules.docsTitlePatterns.find((p) => matchesPattern(pageTitle, p))
    : undefined;
  if (docsTitle) return reject("not_a_product", "문서 제목 아님", `제목 “${page.title}” 이 ${docsTitle} 에 걸림`);
  pass("문서 제목 아님", page.title
    ? titleWords > DOCS_TITLE_MAX_WORDS ? `“${page.title}” — ${titleWords}단어, 문장은 보지 않음` : `“${page.title}”`
    : "제목 없음");

  if (repo.isFork && rules.excludeForks) return reject("fork", "포크 아님", "포크 저장소");
  pass("포크 아님", rules.excludeForks ? "isFork=false" : "포크 제외 꺼짐");
  // 보관된 레포는 살아있는 제품이 아니다
  if (repo.archived) return reject("personal_site", "보관됨 아님", "archived=true");
  pass("보관됨 아님", "archived=false");

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
  const nameOrRootPattern = rules.excludedRepoPatterns.find(
    (p) => matchesPattern(repoName, p) || (hostIsWholeSite && matchesPattern(productHost, p)),
  );
  if (nameOrRootPattern) {
    return reject("personal_site", "제외 패턴 아님",
      matchesPattern(repoName, nameOrRootPattern)
        ? `레포 이름 ${repoName} 이 ${nameOrRootPattern} 에 걸림`
        : `루트 배포 호스트 ${productHost} 가 ${nameOrRootPattern} 에 걸림`);
  }
  pass("제외 패턴 아님", repoName);

  /**
   * 설명에만 단서가 있는 개인 사이트.
   *
   * "My very simple personal landing page app"처럼 이름도 URL도 평범한데 설명이 스스로
   * 밝히는 경우가 있다. 그것까지 통과시키면 사람이 심사에서 걸러야 한다.
   */
  const description = repo.description.toLowerCase();
  const keyword = description
    ? rules.personalSiteKeywords.find((k) => description.includes(k.toLowerCase())) : undefined;
  if (keyword) return reject("personal_site", "개인 사이트 키워드 없음", `설명에 “${keyword}”`);
  pass("개인 사이트 키워드 없음", `${rules.personalSiteKeywords.length}개 중 0개 일치`);

  // 스타 상한이 대형 오픈소스를 거른다. 하한이 아니라 상한인 것이 요지다 —
  // 갓 배포한 제품은 정당하게 스타가 0개다.
  const n = (value: number) => value.toLocaleString("en-US");
  if (repo.stars > rules.maxStars) {
    return reject("large_oss", "스타 상한 이하", `${n(repo.stars)} > ${n(rules.maxStars)}`);
  }
  if (repo.stars < rules.minStars) {
    return reject("large_oss", "스타 하한 이상", `${n(repo.stars)} < ${n(rules.minStars)}`);
  }
  pass("스타 상한 이하", `${n(repo.stars)} ≤ ${n(rules.maxStars)}`);
  if (rules.excludeOrganizations && repo.ownerType === "Organization") {
    return reject("large_oss", "조직 계정 아님", "조직 계정 제외가 켜져 있음");
  }
  pass("조직 계정 제외", rules.excludeOrganizations ? `${repo.ownerType}` : `꺼짐 (${repo.ownerType})`);

  const pushAge = repo.pushedAt ? Math.round(daysSince(repo.pushedAt, now)) : null;
  if (repo.pushedAt && daysSince(repo.pushedAt, now) > rules.maxPushAgeDays) {
    // 죽은 프로젝트
    return reject("unreachable", PUSH_AGE_RULE, `마지막 푸시 ${pushAge}일 전 > ${rules.maxPushAgeDays}일`);
  }

  // 배포 URL이 살아있는지 확인 못 했으면 판단을 미룬다 (fetch가 끝나면 다시 온다)
  if (page.status === null) {
    return hold("ambiguous", "page_status_unknown", "배포 URL 응답 확인",
      "아직 열어보지 못했습니다 (pageStatus 없음)");
  }
  if (page.status < 200 || page.status >= 400) {
    return reject("unreachable", "배포 URL 응답 정상", page.status === 0 ? "접속 실패" : `HTTP ${page.status}`);
  }
  pass("배포 URL 응답 정상", `HTTP ${page.status}`);

  // 푸시 시각을 모르면 살아있는지 확신할 수 없다
  if (!repo.pushedAt && rules.holdAmbiguous) {
    return hold("ambiguous", "push_time_unknown", "마지막 푸시 시각 확인", "레포 메타에 pushed_at 없음");
  }
  pass(PUSH_AGE_RULE, pushAge === null ? "푸시 시각 미상 (보류 꺼짐)" : `${pushAge}일 ≤ ${rules.maxPushAgeDays}일`);

  /**
   * 호스트는 제외 패턴에 걸리는데 루트 배포가 아닌 것 — 규칙으로 가를 수 없다.
   *
   * 실데이터에서 `owner.github.io/repo` 14개를 눈으로 보니 웹앱과, CLI·데스크톱 도구의
   * 소개 페이지가 섞여 있었다. 우리가 모으는 것은 "배포한 서비스"이므로 후자를 자동으로
   * 통과시키면 안 되고, 전자를 자동으로 버려서도 안 된다. 사람이 가른다.
   */
  const subPathPattern = hostIsWholeSite
    ? undefined : rules.excludedRepoPatterns.find((p) => matchesPattern(productHost, p));
  if (subPathPattern) {
    const detail = `제외 패턴 ${subPathPattern} 이 호스트 ${productHost} 에 걸리지만, 배포물이 루트가 아니라 ${productPath} 경로입니다`;
    return rules.holdAmbiguous
      ? hold("ambiguous", "host_excluded_subpath", "호스트 제외 패턴", detail)
      : reject("personal_site", "호스트 제외 패턴", detail);
  }
  pass("호스트 제외 패턴 아님", hostIsWholeSite ? `${productHost} (루트 배포)` : `${productHost}${productPath}`);

  if (settings.agentEvidence.enforceEligibility) {
    const summary = summarizeAgentEvidence(agentEvidence ?? {
      scanState: "pending", relationship: "unknown", observations: [],
    });
    signals.agentEvidence = summary;
    signals.agentPolicyVersion = settings.agentEvidence.policyVersion;
    if (!summary.eligible) {
      return hold(summary.reason, "agent_evidence", "개발 AI 근거", `근거가 기준에 못 미침 (${summary.reason})`);
    }
    pass("개발 AI 근거", "기준 충족");
  }
  return { state: "approved", reason: "passed", signals, trace };
}

/**
 * 수집한 원본에서 페이지 사실을 추린다.
 *
 * 판정 잡과 심사 화면이 같은 입력을 써야 한다 — 화면이 따로 만들면 근거가 실제 판정과
 * 어긋난다.
 */
export function pageFactsFromDocument(document: {
  productUrl: string | null;
  pageStatus: number | null;
  pageMeta: unknown;
}): PageFacts {
  const meta = (document.pageMeta ?? {}) as { generator?: unknown; title?: unknown };
  return {
    productUrl: document.productUrl,
    status: document.pageStatus,
    generator: typeof meta.generator === "string" ? meta.generator : null,
    title: typeof meta.title === "string" ? meta.title : null,
  };
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
    description: typeof meta.description === "string" ? meta.description : "",
  };
}
