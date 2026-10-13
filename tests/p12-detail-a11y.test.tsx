import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FactsStrip } from "@/components/product-detail/FactsStrip";
import { IntroSection } from "@/components/product-detail/IntroSection";
import { UnclaimedOwnerContact } from "@/components/product-detail/UnclaimedOwnerContact";
import { englishLang, ProductTagline } from "@/components/ProductTagline";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";

const product: ProductDetailView["product"] = {
  id: 1, slug: "infisical", url: "https://infisical.example", accessMode: "website", name: "Infisical",
  tagline: "Infisical is the all-in-one identity security platform.", taglineSource: "maker",
  description: "Open-source secret management for teams.", category: "Security", builder: "Codex", stack: [],
  ogImage: null, makerName: null, repoUrl: "https://github.com/infisical/infisical", status: "seeded", source: "crawler",
  claimedAt: null, verifiedAt: null, createdAt: new Date("2026-07-01T00:00:00.000Z"), updatedAt: new Date("2026-08-19T03:00:00.000Z"),
  aiEvidence: true, takedownPending: false, taglineKo: null,
};

const repository: NonNullable<ProductDetailView["repository"]> = {
  provider: "github", sourceUrl: product.repoUrl!, state: "ok", observedAt: product.updatedAt, lastSuccessAt: product.updatedAt, lastFailureAt: null,
  facts: {
    repositoryKey: "infisical/infisical", repositoryUrl: product.repoUrl!, createdAt: "2025-01-01T00:00:00.000Z",
    pushedAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z", stars: 100, forks: 18, public: true,
    archived: false, fork: false, homepage: null, contributors: { count: 12, incomplete: false, cap: 500 },
    license: { value: "MIT", spdxId: "MIT", url: null, sourceLabel: "GitHub에서 확인" }, languages: [],
    latestRelease: { tagName: "v1.0.0", name: "First", url: null, notesUrl: null, publishedAt: "2026-08-15T00:00:00.000Z" },
    relationshipState: "bidirectional",
  },
};
const license: ProductDetailView["license"] = {
  state: "observed_only", label: "GitHub에서 확인", maker: null,
  observed: { value: "MIT", spdxId: "MIT", url: null, sourceLabel: "GitHub에서 확인" },
};
const health: ProductDetailView["health"] = { uptime30d: 99.9, latencyMs: 120, checkedAt: new Date(), down: false, lastCheckSucceeded: true };
const visits: ProductDetailView["visits"] = {
  periodDays: 7, validVisits: 0, uniqueVisitors: null, uniqueChangePercent: null, collectionStartedAt: null, collecting: true,
};

/** dl 안에 <div>{dt,dd}</div> 묶음만 있는지 — dt·dd 를 지우면 빈 div 만 남아야 한다 */
function onlyTermGroups(html: string): boolean {
  const lists = [...html.matchAll(/<dl[^>]*>([\s\S]*?)<\/dl>/g)].map((match) => match[1]);
  expect(lists.length).toBeGreaterThan(0);
  return lists.every((inner) => inner
    .replace(/<dt[^>]*>[\s\S]*?<\/dt>/g, "")
    .replace(/<dd[^>]*>[\s\S]*?<\/dd>/g, "")
    .replace(/<div[^>]*><\/div>/g, "") === "");
}

describe("사실 표의 dl 구조(A11Y-04)", () => {
  it("격자 칸의 덧말도 dd 안에 있다 — dl 에 span 이 바로 섞이지 않는다", () => {
    const html = renderToStaticMarkup(<FactsStrip product={product} repository={repository} license={license} health={health} visits={visits} />);
    expect(onlyTermGroups(html)).toBe(true);
    expect(html).toMatch(/<dd[^>]*>30일 가동률 99.9%<\/dd>/);
    expect(html).toMatch(/<dd[^>]*>저장소 생성 2025년 1월<\/dd>/);
  });

  it("칸이 적어 한 줄로 적을 때도 같은 구조다", () => {
    const html = renderToStaticMarkup(<FactsStrip product={product} repository={null} license={{ ...license, observed: null }}
      health={{ ...health, checkedAt: null }} visits={visits} />);
    expect(onlyTermGroups(html)).toBe(true);
  });
});

describe("요청 폼(A11Y-01·A11Y-03)", () => {
  const html = renderToStaticMarkup(<UnclaimedOwnerContact repoUrl={product.repoUrl} slug={product.slug} />);

  it("이유 칸에 보이는 이름표가 이어져 있다", () => {
    const labelFor = html.match(/<label for="([^"]+)"[^>]*>요청 이유 /)?.[1];
    expect(labelFor).toBeTruthy();
    expect(html).toMatch(new RegExp(`<textarea id="${labelFor}"[^>]*name="reason"`));
    // 보이는 이름표가 이름이 되도록 aria-label 은 두지 않는다
    expect(html).not.toContain('aria-label="요청 이유"');
    expect(html).toContain("(선택)");
  });

  it("오류는 alert, 접수는 status 로 알린다", () => {
    const source = readFileSync("app/(public)/[locale]/(content)/p/[slug]/TakedownForm.tsx", "utf8");
    expect(source).toMatch(/<p role="alert"[^>]*>\{error\}<\/p>/);
    expect(source).toMatch(/<p role="status"[^>]*>\s*\{intro \? INTRO_REQUEST_RECEIVED : TAKEDOWN_RECEIVED\}/);
  });

  it("상자·폼의 글 속 링크는 밑줄이 늘 있다", () => {
    expect(html).toMatch(/<a [^>]*href="\/policy#takedown"[^>]*class="[^"]*\bunderline\b[^"]*"|<a [^>]*class="[^"]*\bunderline\b[^"]*"[^>]*href="\/policy#takedown"/);
    const inline = html.match(/<a [^>]*href="\/policy#contact"[^>]*>/)?.[0] ?? "";
    expect(inline).toMatch(/class="[^"]*(?<!:)\bunderline\b/);
  });
});

describe("영어 원문 표시(A11Y-06)", () => {
  it("한글이 없고 거의 영문 알파벳이면 en, 아니면 표시하지 않는다", () => {
    expect(englishLang("Infisical is the all-in-one identity security platform.")).toBe("en");
    expect(englishLang("Next.js 16 + Supabase starter")).toBeUndefined();
    expect(englishLang("한국어 소개입니다")).toBeUndefined();
    expect(englishLang("Claude Code로 만든 도구")).toBeUndefined();
    expect(englishLang("日本語のツール")).toBeUndefined();
    expect(englishLang("Привет мир")).toBeUndefined();
    expect(englishLang("v2")).toBeUndefined();
    expect(englishLang("")).toBeUndefined();
    expect(englishLang(null)).toBeUndefined();
  });

  it("상세 한 줄 소개 — 한국어 줄이 없으면 원문 줄에, 있으면 '원문 보기' 안의 원문에만 단다", () => {
    const only = renderToStaticMarkup(<ProductTagline tagline={product.tagline} original="toggle" />);
    expect(only).toMatch(/<p [^>]*lang="en"[^>]*>Infisical is/);
    const both = renderToStaticMarkup(<ProductTagline tagline={product.tagline} taglineKo="올인원 신원 보안 플랫폼" original="toggle" />);
    expect(both).toMatch(/<p(?![^>]*lang=)[^>]*>올인원 신원 보안 플랫폼<\/p>/);
    expect(both).toMatch(/<details[\s\S]*<p lang="en"[^>]*>Infisical is/);
    const korean = renderToStaticMarkup(<ProductTagline tagline="브라우저에서 HWP 를 엽니다" original="toggle" />);
    expect(korean).not.toContain("lang=");
  });

  it("소개 설명과 README 발췌가 영어면 en, 한국어면 표시 없음", () => {
    const english = renderToStaticMarkup(<IntroSection product={product} profile={null} readmeExcerpt="Infisical lets teams sync secrets." unclaimed />);
    expect(english).toMatch(/<p lang="en"[^>]*>Open-source secret management/);
    expect(english).toMatch(/<blockquote lang="en"/);
    const korean = renderToStaticMarkup(<IntroSection product={{ ...product, description: "팀의 비밀값을 관리합니다." }} profile={null}
      readmeExcerpt="비밀값을 동기화합니다." unclaimed />);
    expect(korean).not.toContain("lang=");
  });
});
