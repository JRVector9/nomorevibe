import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  normalizeHttpUrl,
  isValidHostname,
  slugifyName,
  extractOgImage,
  extractVerifyMeta,
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
