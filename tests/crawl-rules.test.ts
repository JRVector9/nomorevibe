import { describe, it, expect } from "vitest";
import { judge, matchesPattern, isBlockedHost, factsFromRepoMeta, type RepoFacts } from "@/lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema } from "@/lib/crawl/settings-schema";
import { resolveCanonical } from "@/lib/domain/products/register";

const NOW = new Date("2026-08-17T00:00:00Z");
const settings = DEFAULT_CRAWL_SETTINGS;

/** 통과하는 기본 제품 — 각 테스트는 여기서 한 가지만 바꾼다 */
const goodRepo = (over: Partial<RepoFacts> = {}): RepoFacts => ({
  repo: "someone/my-app",
  stars: 12,
  isFork: false,
  ownerType: "User",
  pushedAt: new Date("2026-08-10T00:00:00Z"),
  archived: false,
  description: "배포한 서비스입니다",
  ...over,
});
const livePage = { productUrl: "https://my-app.vercel.app", status: 200 };

describe("judge — 통과", () => {
  it("개인이 최근 배포한 소규모 제품은 통과한다", () => {
    const v = judge(goodRepo(), livePage, settings, NOW);
    expect(v).toMatchObject({ state: "approved", reason: "passed" });
  });

  it("스타가 0개여도 통과한다 — 갓 배포한 제품이 그렇다", () => {
    expect(judge(goodRepo({ stars: 0 }), livePage, settings, NOW).state).toBe("approved");
  });

  it("판정 근거를 함께 남긴다", () => {
    const v = judge(goodRepo({ stars: 7 }), livePage, settings, NOW);
    expect(v.signals).toMatchObject({ stars: 7, isFork: false, ownerType: "User", pageStatus: 200 });
    expect(v.signals.pushAgeDays).toBe(7);
  });
});

describe("judge — 거르기", () => {
  it("배포 URL이 없으면 제품이 아니다", () => {
    const v = judge(goodRepo(), { productUrl: null, status: null }, settings, NOW);
    expect(v).toMatchObject({ state: "rejected", reason: "no_homepage" });
  });

  it("homepage가 GitHub·SNS면 배포물이 아니다", () => {
    for (const url of [
      "https://github.com/someone/my-app",
      "https://www.instagram.com/someone",
      "https://x.com/someone",
      "https://medium.com/@someone",
    ]) {
      const v = judge(goodRepo(), { productUrl: url, status: 200 }, settings, NOW);
      expect(v.reason, url).toBe("not_a_product");
    }
  });

  it("대형 오픈소스를 스타 상한으로 거른다", () => {
    // windmill-labs/windmill 처럼 AI가 커밋 일부에 참여했을 뿐인 것
    const v = judge(goodRepo({ stars: 15_000 }), livePage, settings, NOW);
    expect(v).toMatchObject({ state: "rejected", reason: "large_oss" });
  });

  it("포크를 거른다", () => {
    expect(judge(goodRepo({ isFork: true }), livePage, settings, NOW).reason).toBe("fork");
  });

  it("조직 계정이라고 거르지 않는다 — 규모는 스타 상한이 본다", () => {
    // 실측: large_oss로 거른 52건 중 39건이 "조직인데 스타 1000 이하"였고
    // 그 안에 nodetool.ai·albyhub.com 같은 실제 배포 제품이 있었다
    expect(judge(goodRepo({ ownerType: "Organization" }), livePage, settings, NOW).state).toBe("approved");

    const strict = { ...settings, judge: { ...settings.judge, excludeOrganizations: true } };
    expect(judge(goodRepo({ ownerType: "Organization" }), livePage, strict, NOW).reason).toBe("large_oss");
  });

  it("설명에만 단서가 있는 개인 사이트를 거른다", () => {
    // 이름도 URL도 평범한데 설명이 스스로 밝히는 경우다
    for (const description of [
      "My very simple personal landing page app",
      "Personal blog build with Astro",
      "개인 블로그입니다",
    ]) {
      expect(judge(goodRepo({ description }), livePage, settings, NOW).reason, description).toBe("personal_site");
    }
  });

  it("설명에 personal이 스쳐도 한 단어로는 걸리지 않는다", () => {
    // personal-finance-tracker 같은 제품을 함께 버리면 안 된다
    const v = judge(goodRepo({ description: "Personal finance tracker for freelancers" }), livePage, settings, NOW);
    expect(v.state).toBe("approved");
  });

  it("문서 사이트는 배포된 서비스가 아니다", () => {
    for (const url of [
      "https://docs.datadoghq.com",
      "https://rocm.docs.amd.com/projects/intellikit/en/latest",
      "https://kestra.io/docs/api-reference/kestra-sdk",
    ]) {
      const v = judge(goodRepo(), { productUrl: url, status: 200 }, settings, NOW);
      expect(v.reason, url).toBe("not_a_product");
    }
    // 이름에 docs가 들어간 제품까지 거르면 안 된다
    expect(judge(goodRepo(), { productUrl: "https://docsend.test", status: 200 }, settings, NOW).state).toBe(
      "approved",
    );
  });

  it("배포 호스트도 패턴에 걸되 사이트 루트일 때만 본다", () => {
    // owner.github.io 루트는 개인 홈페이지다
    const root = judge(
      goodRepo({ repo: "someone/coolapp" }),
      { productUrl: "https://someone.github.io", status: 200 },
      settings,
      NOW,
    );
    expect(root.reason).toBe("personal_site");

    // 개인 홈페이지 레포는 배포 URL이 어디든 이름으로 잡힌다
    const byName = judge(
      goodRepo({ repo: "someone/someone.github.io" }),
      { productUrl: "https://someone.dev", status: 200 },
      settings,
      NOW,
    );
    expect(byName.reason).toBe("personal_site");
  });

  it("이름에 구분자가 없어도 개인 사이트 패턴에 걸린다", () => {
    // 실데이터: 이름이 그냥 blog / personal-site 인 것들이 *-blog 를 통과했다
    for (const repo of ["someone/blog", "someone/portfolio", "someone/personal-site"]) {
      expect(judge(goodRepo({ repo }), livePage, settings, NOW).reason, repo).toBe("personal_site");
    }
  });

  it("패키지·모드 등록 페이지는 배포물이 아니다", () => {
    for (const url of [
      "https://www.npmjs.com/package/labby-mcp",
      "https://crates.io/crates/moadim",
      "https://modrinth.com/project/auto-storage",
      // 실제 수집에서 봇 확인 페이지("Client Challenge")가 제품 이름으로 발행됐다
      "https://pypi.org/project/claude-usage-tracker",
    ]) {
      const v = judge(goodRepo(), { productUrl: url, status: 200 }, settings, NOW);
      expect(v.reason, url).toBe("not_a_product");
    }
  });

  it("밑줄 변형도 같은 것으로 본다", () => {
    // my-portfolio는 걸리는데 my_portfolio는 통과하면 안 된다
    for (const repo of ["someone/my_portfolio", "someone/dev_blog"]) {
      expect(judge(goodRepo({ repo }), livePage, settings, NOW).reason, repo).toBe("personal_site");
    }
  });

  it("개인 홈페이지 패턴을 거른다", () => {
    for (const repo of [
      "someone/someone.github.io",
      "someone/dotfiles",
      "someone/awesome-ai-tools",
      "someone/my-portfolio",
      "someone/dev-blog",
    ]) {
      const v = judge(goodRepo({ repo }), livePage, settings, NOW);
      expect(v.reason, repo).toBe("personal_site");
    }
  });

  it("오래 방치된 프로젝트를 거른다", () => {
    const v = judge(goodRepo({ pushedAt: new Date("2025-01-01T00:00:00Z") }), livePage, settings, NOW);
    expect(v.reason).toBe("unreachable");
  });

  it("보관된 레포를 거른다", () => {
    expect(judge(goodRepo({ archived: true }), livePage, settings, NOW).state).toBe("rejected");
  });

  it("배포 URL이 죽어 있으면 거른다", () => {
    const v = judge(goodRepo(), { productUrl: "https://gone.test", status: 404 }, settings, NOW);
    expect(v).toMatchObject({ state: "rejected", reason: "unreachable" });
  });
});

describe("judge — 보류", () => {
  it("배포 URL을 아직 확인 못 했으면 판단을 미룬다", () => {
    const v = judge(goodRepo(), { productUrl: "https://my-app.test", status: null }, settings, NOW);
    expect(v).toMatchObject({ state: "needs_review", reason: "ambiguous" });
  });

  it("푸시 시각을 모르면 보류한다", () => {
    const v = judge(goodRepo({ pushedAt: null }), livePage, settings, NOW);
    expect(v.state).toBe("needs_review");
  });

  it("보류를 끄면 통과시킨다", () => {
    const relaxed = { ...settings, judge: { ...settings.judge, holdAmbiguous: false } };
    expect(judge(goodRepo({ pushedAt: null }), livePage, relaxed, NOW).state).toBe("approved");
  });

  it("GitHub Pages 프로젝트 페이지는 사람에게 넘긴다", () => {
    // 웹앱일 수도, CLI·데스크톱 도구의 소개 페이지일 수도 있어 규칙으로 못 가른다
    const page = { productUrl: "https://someone.github.io/coolapp", status: 200 };
    const v = judge(goodRepo({ repo: "someone/coolapp" }), page, settings, NOW);
    expect(v).toMatchObject({ state: "needs_review", reason: "ambiguous" });

    // 보류를 끄면 거부 쪽으로 떨어진다
    const strict = { ...settings, judge: { ...settings.judge, holdAmbiguous: false } };
    expect(judge(goodRepo({ repo: "someone/coolapp" }), page, strict, NOW).reason).toBe("personal_site");
  });
});

describe("설정이 판정을 바꾼다 — 화면에서 조정하는 값들", () => {
  it("스타 상한을 올리면 대형 OSS도 통과한다", () => {
    const loose = { ...settings, judge: { ...settings.judge, maxStars: 100_000 } };
    expect(judge(goodRepo({ stars: 15_000 }), livePage, loose, NOW).state).toBe("approved");
  });

  it("조직 제외를 끄면 조직 레포도 통과한다", () => {
    const loose = { ...settings, judge: { ...settings.judge, excludeOrganizations: false } };
    expect(judge(goodRepo({ ownerType: "Organization" }), livePage, loose, NOW).state).toBe("approved");
  });

  it("방치 기준을 늘리면 오래된 것도 통과한다", () => {
    const loose = { ...settings, judge: { ...settings.judge, maxPushAgeDays: 3650 } };
    const old = goodRepo({ pushedAt: new Date("2025-01-01T00:00:00Z") });
    expect(judge(old, livePage, loose, NOW).state).toBe("approved");
  });

  it("차단 도메인을 비우면 GitHub 링크도 통과한다", () => {
    const loose = { ...settings, judge: { ...settings.judge, blockedHomepageDomains: [] } };
    const v = judge(goodRepo(), { productUrl: "https://github.com/a/b", status: 200 }, loose, NOW);
    expect(v.state).toBe("approved");
  });
});

describe("보조 함수", () => {
  it("와일드카드 패턴", () => {
    expect(matchesPattern("someone.github.io", "*.github.io")).toBe(true);
    expect(matchesPattern("dotfiles", "dotfiles")).toBe(true);
    expect(matchesPattern("awesome-lists", "awesome-*")).toBe(true);
    expect(matchesPattern("my-awesome-app", "awesome-*")).toBe(false);
    // 하이픈과 밑줄은 같게 본다
    expect(matchesPattern("my_portfolio", "*-portfolio")).toBe(true);
    expect(matchesPattern("dev_blog", "*-blog")).toBe(true);
  });

  it("와일드카드가 비면 붙은 구분자도 사라진다", () => {
    expect(matchesPattern("blog", "*-blog")).toBe(true);
    expect(matchesPattern("portfolio", "*-portfolio")).toBe(true);
    expect(matchesPattern("awesome", "awesome-*")).toBe(true);
    // 한 글자만 앞에 와도 걸려야 한다 (치환을 두 번 훑으면 여기서 깨진다)
    expect(matchesPattern("a-blog", "*-blog")).toBe(true);
    // 구분자 없이 이어 붙은 것은 다른 이름이다
    expect(matchesPattern("weblog", "*-blog")).toBe(false);
    expect(matchesPattern("awesomeness", "awesome-*")).toBe(false);
  });

  it("차단 호스트는 서브도메인도 잡고 www는 무시한다", () => {
    expect(isBlockedHost("https://github.com/a", ["github.com"])).toBe(true);
    expect(isBlockedHost("https://gist.github.com/a", ["github.com"])).toBe(true);
    expect(isBlockedHost("https://www.github.com/a", ["github.com"])).toBe(true);
    expect(isBlockedHost("https://mygithub.com/a", ["github.com"])).toBe(false);
    expect(isBlockedHost("깨진URL", ["github.com"])).toBe(true);
  });

  it("레포 메타에서 사실만 추린다", () => {
    const facts = factsFromRepoMeta("a/b", {
      stargazers_count: 42,
      fork: true,
      archived: false,
      pushed_at: "2026-08-01T00:00:00Z",
      owner: { type: "Organization" },
      description: "설명",
      기타필드: "무시됨",
    });
    expect(facts).toEqual({
      repo: "a/b",
      stars: 42,
      isFork: true,
      ownerType: "Organization",
      pushedAt: new Date("2026-08-01T00:00:00Z"),
      archived: false,
      description: "설명",
    });
  });

  it("메타가 비어도 안전한 기본값을 준다", () => {
    const facts = factsFromRepoMeta("a/b", {});
    expect(facts).toMatchObject({ stars: 0, isFork: false, ownerType: "User", pushedAt: null });
  });

  it("잘못된 날짜를 null로 처리한다", () => {
    expect(factsFromRepoMeta("a/b", { pushed_at: "날짜아님" }).pushedAt).toBeNull();
  });
});

describe("설정 스키마", () => {
  it("기본값이 스키마를 만족한다", () => {
    expect(crawlSettingsSchema.safeParse(DEFAULT_CRAWL_SETTINGS).success).toBe(true);
  });

  it("범위를 벗어난 값을 거부한다", () => {
    const bad = { ...settings, judge: { ...settings.judge, maxStars: -1 } };
    expect(crawlSettingsSchema.safeParse(bad).success).toBe(false);
  });

  it("검색 신호가 하나도 없으면 거부한다", () => {
    const bad = { ...settings, discover: { ...settings.discover, queries: [] } };
    expect(crawlSettingsSchema.safeParse(bad).success).toBe(false);
  });

  it("한 틱 페이지 수 상한을 강제한다 — rate limit 보호", () => {
    const bad = { ...settings, discover: { ...settings.discover, pagesPerTick: 100 } };
    expect(crawlSettingsSchema.safeParse(bad).success).toBe(false);
  });
});

describe("resolveCanonical — 리다이렉트를 어디까지 따라가나", () => {
  it("도메인이 바뀌면 목적지를 쓴다", () => {
    // hibicalc.vercel.app → hibicalc.com. 안 따라가면 같은 제품이 두 번 등록된다
    expect(resolveCanonical("https://shim.test", "https://real.test/")).toBe("https://real.test");
  });

  it("같은 도메인 안의 경로 이동은 입력 주소를 지킨다", () => {
    // ko.wikipedia.org → ko.wikipedia.org/wiki/... 를 저장하면 안 된다
    expect(resolveCanonical("https://site.test", "https://site.test/welcome")).toBe("https://site.test");
    expect(resolveCanonical("https://site.test", "https://site.test/a/b?c=1")).toBe("https://site.test");
  });

  it("finalUrl이 없거나 깨지면 입력 주소를 쓴다", () => {
    expect(resolveCanonical("https://site.test", undefined)).toBe("https://site.test");
    expect(resolveCanonical("https://site.test", "ht!tp://깨짐")).toBe("https://site.test");
  });

  it("www 차이는 같은 도메인으로 본다 (정규화가 먼저 걷어낸다)", () => {
    expect(resolveCanonical("https://site.test", "https://www.site.test/x")).toBe("https://site.test");
  });
});
