import { describe, expect, it } from "vitest";
import { classifyRepoResponse, decideGoneRepository, pageConclusive, relatedRepositoryLinks, repositoryKey,
  type RepoReviewPage } from "@/lib/domain/products/repo-review";

const page = (over: Partial<RepoReviewPage> = {}): RepoReviewPage => ({
  status: 200, finalUrl: "https://honsulmap.vercel.app/", title: "Honsul Map", text: "Honsul Map helps you find bars.", githubLinks: [], complete: true, ...over,
});
const listing = { repo: "jinu/honsul-map", name: "Honsul Map", url: "https://honsulmap.vercel.app", renamedTo: null };

describe("저장소 주소", () => {
  it("github.com/owner/repo 꼴만 소문자 키로 읽는다", () => {
    expect(repositoryKey("https://github.com/Jinu/Honsul-Map")).toBe("jinu/honsul-map");
    expect(repositoryKey("https://www.github.com/jinu/honsul-map.git")).toBe("jinu/honsul-map");
    expect(repositoryKey("https://github.com/jinu/honsul-map/")).toBe("jinu/honsul-map");
    expect(repositoryKey("https://github.com/jinu")).toBeNull();
    expect(repositoryKey("https://gitlab.com/jinu/honsul-map")).toBeNull();
    expect(repositoryKey(null)).toBeNull();
  });
});

describe("github.com 응답", () => {
  it("404·451 은 공개 소스가 없다, 200 은 같은 주소면 살아 있고 다른 주소로 넘어갔으면 옮겨 갔다", () => {
    expect(classifyRepoResponse("jinu/honsul-map", 404, "https://github.com/jinu/honsul-map")).toEqual({ state: "gone" });
    expect(classifyRepoResponse("jinu/honsul-map", 451, "https://github.com/jinu/honsul-map")).toEqual({ state: "gone" });
    expect(classifyRepoResponse("jinu/honsul-map", 200, "https://github.com/Jinu/Honsul-Map")).toEqual({ state: "alive" });
    expect(classifyRepoResponse("sandrisestudio/musterd", 200, "https://github.com/musterd-io/musterd"))
      .toEqual({ state: "moved", to: "musterd-io/musterd" });
  });

  it("막힘·오류·로그인 화면은 정하지 않는다", () => {
    expect(classifyRepoResponse("jinu/honsul-map", 429, "https://github.com/jinu/honsul-map")).toEqual({ state: "unknown" });
    expect(classifyRepoResponse("jinu/honsul-map", 503, "https://github.com/jinu/honsul-map")).toEqual({ state: "unknown" });
    expect(classifyRepoResponse("jinu/honsul-map", 200, "https://github.com/login?return_to=x")).toEqual({ state: "unknown" });
  });
});

describe("같은 프로젝트로 보이는 링크", () => {
  it("주인·이름이 옛 저장소·제품 이름·사이트 주소와 겹치는 것만 연다 — 남의 라이브러리는 뺀다", () => {
    const links = ["mrdoob/three.js", "jinu/honsul-map", "jinu/honsul-map-v2", "honsulmap/app", "datadog/browser-sdk", "jinu"];
    expect(relatedRepositoryLinks(listing, page({ githubLinks: links }))).toEqual(["jinu/honsul-map-v2", "honsulmap/app"]);
  });

  it("사이트 주소의 이름으로 원본 저장소를 알아본다(재검수의 browserless·sglang·copse)", () => {
    expect(relatedRepositoryLinks({ repo: "andriolihub/browserless-scrape", name: "The Browser Your AI Agents Run On", url: "https://browserless.io", renamedTo: null },
      page({ finalUrl: "https://www.browserless.io/", githubLinks: ["browserless/browserless"] }))).toEqual(["browserless/browserless"]);
    expect(relatedRepositoryLinks({ repo: "hmlerner/copse-agents", name: "copse", url: "https://pawdelta.com/copse", renamedTo: null },
      page({ finalUrl: "https://pawdelta.com/brindle", githubLinks: ["pawdelta/brindle"] }))).toEqual(["pawdelta/brindle"]);
  });

  it("두 글자 이름도 알아본다(uv → neworg/uv)", () => {
    expect(relatedRepositoryLinks({ repo: "me/uv", name: "UV", url: "https://uv.example", renamedTo: null },
      page({ finalUrl: "https://uv.example/", githubLinks: ["neworg/uv", "mrdoob/three.js"] }))).toEqual(["neworg/uv"]);
  });

  it("하루 확인이 적어 둔 새 이름을 맨 앞에 둔다 — 자르지 않는다(몇 개를 열지는 잡이 정한다)", () => {
    const links = ["jinu/a", "jinu/b", "jinu/c", "jinu/d"];
    expect(relatedRepositoryLinks({ ...listing, renamedTo: "Jinu/Honsul" }, page({ githubLinks: links })))
      .toEqual(["jinu/honsul", "jinu/a", "jinu/b", "jinu/c", "jinu/d"]);
  });
});

describe("페이지를 믿을 수 있나", () => {
  const now = new Date("2026-10-13T00:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  it("끝까지 읽은 2xx·3xx 와 사이트 없음(404·410)만 믿는다", () => {
    expect(pageConclusive(page(), null, now)).toBe(true);
    expect(pageConclusive(page({ status: 404 }), null, now)).toBe(true);
    expect(pageConclusive(page({ status: 200, complete: false }), null, now)).toBe(false);
    for (const status of [0, 401, 403, 429, 503]) expect(pageConclusive(page({ status, complete: status !== 0 }), null, now)).toBe(false);
  });
  it("200 이어도 봇 확인 화면이거나 링크가 모으기 상한에 닿았으면 믿지 않는다", () => {
    expect(pageConclusive(page({ title: "Just a moment...", text: "Checking your browser before accessing." }), null, now)).toBe(false);
    expect(pageConclusive(page({ title: "Vercel Security Checkpoint" }), null, now)).toBe(false);
    expect(pageConclusive(page({ githubLinks: Array.from({ length: 20 }, (_, index) => `lib/${index}`) }), null, now)).toBe(false);
  });

  it("못 연 페이지라도 사이트가 사흘 넘게 죽어 있으면 믿는다", () => {
    expect(pageConclusive(page({ status: 0, complete: false }), daysAgo(4), now)).toBe(true);
    expect(pageConclusive(page({ status: 503 }), daysAgo(1), now)).toBe(false);
  });
});

describe("옛 저장소가 없을 때", () => {
  it("같은 프로젝트로 보이는 저장소가 살아 있으면 사람, 못 연 것이 있으면 다음에, 아무것도 없으면 내린다", () => {
    expect(decideGoneRepository([])).toEqual({ decision: "delist_candidate", reason: "repo_gone", note: null });
    expect(decideGoneRepository([{ key: "jinu/old", check: { state: "gone" } }])).toMatchObject({ decision: "delist_candidate" });
    expect(decideGoneRepository([{ key: "jinu/old", check: { state: "gone" } }, { key: "jinu/new", check: { state: "alive" } }]))
      .toEqual({ decision: "human", reason: "repo_link_alive", note: "github.com/jinu/new" });
    expect(decideGoneRepository([{ key: "jinu/new", check: { state: "moved", to: "org/new" } }]))
      .toMatchObject({ decision: "human", note: "github.com/org/new" });
    expect(decideGoneRepository([{ key: "jinu/new", check: { state: "unknown" } }])).toBeNull();
    // 열어 보지 못한 링크가 남았으면 내리지 않는다
    expect(decideGoneRepository([{ key: "jinu/a", check: { state: "gone" } }], ["jinu/d"]))
      .toEqual({ decision: "human", reason: "repo_links_unchecked", note: "github.com/jinu/d" });
  });
});
