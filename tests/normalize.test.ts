import { describe, it, expect } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import {
  normalizeUrl,
  normalizeHttpUrl,
  isValidHostname,
  slugifyName,
  extractOgImage,
  extractVerifyMeta,
  extractPageMeta,
  detectSiteGenerator,
} from "@/lib/net/normalize";

describe("normalizeUrl — 중복 등록 방지의 기준값", () => {
  it("같은 사이트의 여러 표기를 하나로 모은다", () => {
    const expected = "https://example.com";
    for (const input of [
      "https://example.com",
      "https://example.com/",
      "http://example.com",
      "https://WWW.Example.com/",
      "example.com",
      "https://example.com?utm_source=x",
      "https://example.com#top",
    ]) {
      expect(normalizeUrl(input), input).toBe(expected);
    }
  });

  it("경로는 유지하되 후행 슬래시는 제거한다", () => {
    expect(normalizeUrl("https://example.com/app/")).toBe("https://example.com/app");
  });

  it("http(s)가 아닌 스킴을 거부한다", () => {
    for (const input of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      expect(normalizeUrl(input), input).toBeNull();
    }
  });

  it("allowPrivate일 때만 localhost의 http와 포트를 보존한다", () => {
    expect(normalizeUrl("http://localhost:8899", true)).toBe("http://localhost:8899");
    expect(normalizeUrl("http://localhost:8899", false)).toBe("https://localhost:8899");
  });

  it("후행 점을 제거해 같은 사이트가 두 번 등록되지 않게 한다", () => {
    // example.com. 과 example.com 은 같은 호스트다
    expect(normalizeUrl("https://example.com.")).toBe(normalizeUrl("https://example.com"));
  });

  it("형식이 깨진 호스트를 그럴듯한 URL로 변형하지 않는다", () => {
    // https://를 무턱대고 덧붙이면 ht!tp가 호스트명이 된 URL이 만들어진다
    expect(normalizeUrl("ht!tp://깨진")).toBeNull();
    expect(normalizeUrl("https://-bad.com")).toBeNull();
    expect(normalizeUrl("https://example..com")).toBeNull();
    expect(normalizeUrl("https://.example.com")).toBeNull();
  });

  it("정상 도메인·IDN·IP는 계속 통과시킨다", () => {
    expect(normalizeUrl("https://sub.example.co.kr")).toBe("https://sub.example.co.kr");
    expect(normalizeUrl("https://한글.kr")).toBe("https://xn--bj0bj06e.kr");
    expect(normalizeUrl("https://192.168.1.1")).toBe("https://192.168.1.1");
    expect(normalizeUrl("https://exa--mple.com")).toBe("https://exa--mple.com");
  });
});

describe("isValidHostname", () => {
  it("IP 리터럴을 허용한다 (사설 여부 판단은 SSRF 가드의 몫)", () => {
    expect(isValidHostname("8.8.8.8")).toBe(true);
    expect(isValidHostname("[::1]")).toBe(true);
    expect(isValidHostname("[not-an-ip]")).toBe(false);
  });

  it("단일 라벨 호스트를 허용한다 (localhost 등)", () => {
    expect(isValidHostname("localhost")).toBe(true);
  });

  it("규격상 무효인 라벨을 거부한다", () => {
    for (const host of ["-lead.com", "trail-.com", "a..b", "", "ht!tp", "a".repeat(64) + ".com"]) {
      expect(isValidHostname(host), host).toBe(false);
    }
  });

  it("실제로 쓰이는 밑줄은 허용한다 — 지나친 엄격함이 멀쩡한 제품을 거부한다", () => {
    expect(isValidHostname("a_b.com")).toBe(true);
  });
});

describe("normalizeHttpUrl — repo_url XSS 차단 (1차 리뷰 F3 회귀)", () => {
  it("javascript:/data: URI를 거부한다", () => {
    for (const input of [
      "javascript:fetch('/api/products/x',{method:'DELETE'})",
      "JavaScript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
    ]) {
      expect(normalizeHttpUrl(input), input).toBeNull();
    }
  });

  it("정상 http(s) URL은 통과시킨다", () => {
    expect(normalizeHttpUrl("https://github.com/a/b")).toBe("https://github.com/a/b");
  });
});

describe("slugifyName", () => {
  it("공백과 특수문자를 하이픈으로 정리한다", () => {
    expect(slugifyName("My App")).toBe("my-app");
    expect(slugifyName("simpleHWP")).toBe("simplehwp");
    expect(slugifyName("  --Hello!! World--  ")).toBe("hello-world");
  });

  it("사용할 문자가 없으면 기본값을 준다", () => {
    expect(slugifyName("한글만")).toBe("product");
    expect(slugifyName("!!!")).toBe("product");
  });
});

describe("HTML 추출", () => {
  it("og:image를 절대경로로 바꾼다", () => {
    const html = `<meta property="og:image" content="/img/cover.png">`;
    expect(extractOgImage(html, "https://example.com/page")).toBe("https://example.com/img/cover.png");
  });

  it("속성 순서가 뒤집혀도 찾는다", () => {
    const html = `<meta content="https://cdn.example.com/a.png" property="og:image">`;
    expect(extractOgImage(html, "https://example.com")).toBe("https://cdn.example.com/a.png");
  });

  it("검증 메타태그 값을 읽는다", () => {
    const html = `<meta name="nomorevibe-verify" content="nmv_verify_abc">`;
    expect(extractVerifyMeta(html, "nomorevibe-verify")).toBe("nmv_verify_abc");
    expect(extractVerifyMeta("<html></html>", "nomorevibe-verify")).toBeNull();
  });
});

describe("detectSiteGenerator — 문서 사이트 가르기", () => {
  // 찾을 이름은 설정이 갖는다. 여기서는 그 목록을 넘겨 찾기만 한다
  const GENERATORS = DEFAULT_CRAWL_SETTINGS.judge.docsGenerators;

  it("generator 메타태그를 읽는다", () => {
    expect(detectSiteGenerator(`<meta name="generator" content="mkdocs-1.6.1, mkdocs-material-9.5">`, GENERATORS)).toBe(
      "mkdocs",
    );
    expect(detectSiteGenerator(`<meta name="generator" content="VitePress v1.6.4">`, GENERATORS)).toBe("vitepress");
  });

  it("태그가 없으면 자산 경로에서 찾는다 — 실측 23건 중 4건만 태그를 달고 있었다", () => {
    expect(detectSiteGenerator(`<script src="/pkgdown.js"></script>`, GENERATORS)).toBe("pkgdown");
    expect(detectSiteGenerator(`<link href="/assets/css/docusaurus.min.css">`, GENERATORS)).toBe("docusaurus");
  });

  it("본문 텍스트는 보지 않는다 — 만들었다고 적어둔 제품까지 문서로 볼 수는 없다", () => {
    expect(detectSiteGenerator(`<html><body><p>docusaurus로 만든 문서를 지원합니다</p></body></html>`, GENERATORS)).toBeNull();
  });

  it("설정에 없는 이름은 찾지 않는다 — 목록은 설정 하나가 갖는다", () => {
    // 어드민이 추가하면 그 즉시 감지된다. 예전에는 목록이 두 군데라 추가해도 무효였다
    const html = `<meta name="generator" content="Mintlify">`;
    expect(detectSiteGenerator(html, GENERATORS)).toBeNull();
    expect(detectSiteGenerator(html, [...GENERATORS, "mintlify"])).toBe("mintlify");
  });

  it("범용 생성기는 신호로 쓰지 않는다 — GitHub Pages의 기본 빌더다", () => {
    expect(detectSiteGenerator(`<meta name="generator" content="Jekyll v4.3.2">`, GENERATORS)).toBeNull();
    expect(detectSiteGenerator(`<meta name="generator" content="Hugo 0.120">`, GENERATORS)).toBeNull();
  });
});

describe("extractPageMeta — 수집한 제품의 이름·소개 재료", () => {
  it("og:*를 <title>보다 먼저 본다", () => {
    // <title>에는 "Home | 서비스" 같은 것이 흔하다. og:title은 공유용으로 손본 값이다
    const html = `
      <title>Home | 헬로앱</title>
      <meta property="og:title" content="헬로앱">
      <meta property="og:description" content="한 줄 소개">
      <meta name="description" content="긴 설명">
      <meta property="og:image" content="/cover.png">`;
    expect(extractPageMeta(html, "https://hello.test")).toEqual({
      title: "헬로앱",
      description: "한 줄 소개",
      ogImage: "https://hello.test/cover.png",
      generator: null,
    });
  });

  it("og:*가 없으면 <title>과 description으로 내려간다", () => {
    const html = `<title>  헬로앱\n  </title><meta name="description" content="설명">`;
    expect(extractPageMeta(html, "https://hello.test")).toMatchObject({
      title: "헬로앱",
      description: "설명",
    });
  });

  it("실체 참조를 되돌린다 — 안 그러면 &amp;가 제품 이름에 남는다", () => {
    const html = `<title>Rock &amp; Roll</title>`;
    expect(extractPageMeta(html, "https://a.test").title).toBe("Rock & Roll");
  });

  it("숫자 참조도 되돌린다", () => {
    // 실제 수집에서 DRYL &#x2014; … 가 그대로 들어와 slug가 dryl-x2014-… 가 됐다
    expect(extractPageMeta(`<title>DRYL &#x2014; UI</title>`, "https://a.test").title).toBe("DRYL — UI");
    expect(extractPageMeta(`<title>A &#8212; B</title>`, "https://a.test").title).toBe("A — B");
    expect(extractPageMeta(`<title>It&#39;s fine</title>`, "https://a.test").title).toBe("It's fine");
  });

  it("범위를 벗어난 참조는 원문을 지킨다 — 하나 깨졌다고 제목을 잃지 않는다", () => {
    expect(extractPageMeta(`<title>X &#x999999; Y</title>`, "https://a.test").title).toBe("X &#x999999; Y");
  });

  it("없으면 없는 대로 null을 남긴다 — 지어내지 않는다", () => {
    expect(extractPageMeta("<html><body>본문뿐</body></html>", "https://a.test")).toEqual({
      title: null,
      description: null,
      ogImage: null,
      generator: null,
    });
    // 빈 값도 없는 것으로 본다
    expect(extractPageMeta(`<title>   </title>`, "https://a.test").title).toBeNull();
  });

  it("저장 상한을 넘기지 않게 자른다", () => {
    const html = `<title>${"가".repeat(500)}</title><meta name="description" content="${"나".repeat(800)}">`;
    const meta = extractPageMeta(html, "https://a.test");
    expect(meta.title).toHaveLength(300);
    expect(meta.description).toHaveLength(500);
  });
});
