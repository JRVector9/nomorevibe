import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuildProvenance } from "@/components/product-detail/BuildProvenance";
import { EvidenceSummary } from "@/components/product-detail/EvidenceSummary";
import { FreshnessPanel } from "@/components/product-detail/FreshnessPanel";
import { ProductFacts } from "@/components/product-detail/ProductFacts";
import { ProductGallery } from "@/components/product-detail/ProductGallery";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { ProductIntroduction } from "@/components/product-detail/ProductIntroduction";
import { ProductMetrics } from "@/components/product-detail/ProductMetrics";
import { RepositoryEvidence } from "@/components/product-detail/RepositoryEvidence";
import { SourceBadge } from "@/components/product-detail/SourceBadge";
import { UpdateTimeline } from "@/components/product-detail/UpdateTimeline";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";

const observedAt = new Date("2026-08-19T03:00:00.000Z");
const product: ProductDetailView["product"] = {
  id: 1,
  slug: "simple-hwp",
  url: "https://simplehwp.example",
  name: "simpleHWP",
  tagline: "별도 뷰어 없이 HWP 문서를 브라우저에서 엽니다.",
  description: "파일 분석은 WebAssembly로 사용자 기기에서 처리됩니다.",
  category: "Productivity",
  builder: "Codex",
  stack: ["React", "WASM", "Rust"],
  ogImage: null,
  makerName: "Simple Tools",
  repoUrl: "https://github.com/example/simple-hwp",
  status: "verified",
  source: "skill",
  claimedAt: new Date("2026-07-01T00:00:00.000Z"),
  verifiedAt: new Date("2026-07-02T00:00:00.000Z"),
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: observedAt,
};

const profile: NonNullable<ProductDetailView["profile"]> = {
  slug: product.slug,
  problem: "설치 없이 HWP 문서를 확인하기 어렵습니다.",
  targetUsers: "Mac·Linux 사용자와 공공 문서를 자주 받는 사람",
  keyFeatures: ["브라우저 열람", "텍스트 검색", "복사"],
  useCases: ["첨부 문서 확인", "문서 내용 검색"],
  pricingModel: "free",
  pricingUrl: null,
  lifecycle: "ga",
  platforms: ["Web"],
  privacySummary: "문서는 사용자 기기에서 처리되고 서버로 업로드되지 않습니다.",
  longDescriptionMarkdown: "## 설치 없이 바로 열기\n\n[공식 사이트](https://simplehwp.example)에서 HWP를 확인합니다.\n\n![외부 추적](https://tracker.example/pixel.png)\n\n<script>alert(1)</script>",
  team: [{ name: "Simple Tools", role: "Maker" }],
  makerLicense: { value: "MIT", spdxId: "MIT" },
  updatedAt: observedAt,
};

const links: ProductDetailView["links"] = [
  {
    id: 1,
    kind: "repository",
    url: "https://github.com/example/simple-hwp",
    declarationSource: "maker",
    verificationState: "ok",
    relationshipState: "bidirectional",
    verifiedAt: observedAt,
    evidenceLabel: "공식 출처에서 확인",
  },
  {
    id: 2,
    kind: "npm",
    url: "https://www.npmjs.com/package/simple-hwp",
    declarationSource: "maker",
    verificationState: "unobserved",
    relationshipState: null,
    verifiedAt: null,
    evidenceLabel: "메이커 제공·미검증",
  },
];

const freshness: ProductDetailView["freshness"] = [{
  kind: "repository",
  provider: "github",
  state: "current",
  label: "최신",
  lastSuccessAt: observedAt,
  lastFailureAt: null,
  nextAttemptAt: new Date("2026-08-20T03:00:00.000Z"),
}];

describe("evidence product detail components", () => {
  it("renders the current stored rank, verification, lifecycle, and a 44px outbound action", () => {
    const html = renderToStaticMarkup(<ProductHero
      product={product}
      unclaimed={false}
      lifecycle="ga"
      rank={{ seasonKey: "2026-W34", rank: 2, scoreMode: "unique_visitors" }}
      health={{ uptime30d: 99, latencyMs: 84, checkedAt: observedAt, down: false }}
    />);

    expect(html).toContain("이번 시즌 #2");
    expect(html).toContain("도메인 검증됨");
    expect(html).toContain("정식 운영");
    expect(html).toContain("Productivity");
    expect(html).toContain('href="/go/simple-hwp"');
    expect(html).not.toContain('href="https://simplehwp.example"');
    expect(html).toContain("min-h-11");
    expect(html).toContain("공유");
  });

  it("labels only NoMoreVibe-originated seven-day visits and preserves collecting states", () => {
    const rich = renderToStaticMarkup(<ProductMetrics
      visits={{
        periodDays: 7,
        validVisits: 12,
        uniqueVisitors: 8,
        uniqueChangePercent: 24,
        collectionStartedAt: new Date("2026-08-01T00:00:00.000Z"),
        collecting: false,
      }}
      health={{ uptime30d: 99, latencyMs: 84, checkedAt: observedAt, down: false }}
    />);
    expect(rich).toContain("고유 유입자 · 최근 7일");
    expect(rich).toContain("유효 방문 · 최근 7일");
    expect(rich).toContain("고유 유입자 변동");
    expect(rich).toContain("+24%");
    expect(rich).toContain("30일 가동률");
    expect(rich).not.toMatch(/전체 트래픽|총 방문자|서비스 전체/);

    const collecting = renderToStaticMarkup(<ProductMetrics
      visits={{
        periodDays: 7,
        validVisits: 0,
        uniqueVisitors: null,
        uniqueChangePercent: null,
        collectionStartedAt: null,
        collecting: true,
      }}
      health={{ uptime30d: null, latencyMs: null, checkedAt: null, down: false }}
    />);
    expect(collecting).toContain("집계 중");
    expect(collecting).toContain("유효 방문 · 최근 7일");
    expect(collecting).toContain(">0<");
    expect(collecting).toContain("고유 식별자 집계 전에도 측정");
  });

  it("uses only internal mirrored gallery URLs and keeps useful missing-source copies", () => {
    const html = renderToStaticMarkup(<ProductGallery name={product.name} media={[
      {
        id: 1,
        hash: "a".repeat(64),
        src: `/api/media/${"a".repeat(64)}`,
        thumbnailSrc: `/api/media/${"a".repeat(64)}?variant=thumbnail`,
        width: 960,
        height: 600,
        thumbnailWidth: 480,
        thumbnailHeight: 300,
        altText: "simpleHWP 문서 뷰어 화면",
        position: 0,
        sourceMissing: false,
        lastSuccessAt: observedAt,
      },
      {
        id: 2,
        hash: "b".repeat(64),
        src: `/api/media/${"b".repeat(64)}`,
        thumbnailSrc: `/api/media/${"b".repeat(64)}?variant=thumbnail`,
        width: 800,
        height: 500,
        thumbnailWidth: 400,
        thumbnailHeight: 250,
        altText: "검색 결과 화면",
        position: 1,
        sourceMissing: true,
        lastSuccessAt: observedAt,
      },
    ]} />);

    expect(html).toContain(`/api/media/${"a".repeat(64)}`);
    expect(html).not.toContain("https://");
    expect(html).toContain('width="960"');
    expect(html).toContain('height="600"');
    expect(html).toContain('fetchPriority="high"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("원본 출처는 사라졌지만 마지막 내부 사본을 표시합니다");
  });

  it("shows structured introduction and safe markdown without raw scripts", () => {
    const html = renderToStaticMarkup(<ProductIntroduction product={product} profile={profile} unclaimed={false} />);
    expect(html).toContain("상세 소개");
    expect(html).toContain("해결하는 문제");
    expect(html).toContain("주요 기능");
    expect(html).toContain("메이커 제공·미검증");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("tracker.example");

    const unclaimed = renderToStaticMarkup(<ProductIntroduction product={product} profile={profile} unclaimed />);
    expect(unclaimed).toContain("자동 감지");
    expect(unclaimed).not.toContain("메이커 제공·미검증");
  });

  it("renders objective facts, repository evidence, both conflicting licenses, agents, and skills", () => {
    const facts = renderToStaticMarkup(<ProductFacts product={product} profile={profile} links={links} unclaimed={false} />);
    expect(facts).toContain("객관적 정보");
    expect(facts).toContain("npm");
    expect(facts).toContain("메이커 제공·미검증");
    expect(facts).toContain("공식 출처에서 확인");

    const unclaimedFacts = renderToStaticMarkup(<ProductFacts product={product} profile={profile} links={[]} unclaimed />);
    expect(unclaimedFacts).toContain("우리 추정");
    expect(unclaimedFacts).not.toContain("신고값");

    const repository = renderToStaticMarkup(<RepositoryEvidence
      repository={{
        provider: "github",
        sourceUrl: "https://github.com/example/simple-hwp",
        state: "ok",
        observedAt,
        lastSuccessAt: observedAt,
        lastFailureAt: null,
        facts: {
          repositoryKey: "example/simple-hwp",
          repositoryUrl: "https://github.com/example/simple-hwp",
          createdAt: "2025-01-01T00:00:00.000Z",
          pushedAt: "2026-08-18T00:00:00.000Z",
          updatedAt: "2026-08-18T00:00:00.000Z",
          stars: 146,
          forks: 18,
          public: true,
          archived: false,
          fork: false,
          homepage: "https://simplehwp.example",
          contributors: { count: 12, incomplete: false, cap: 500 },
          license: { value: "GNU GPLv3", spdxId: "GPL-3.0", url: null, sourceLabel: "GitHub에서 확인" },
          languages: [{ name: "TypeScript", bytes: 82_000, percent: 82 }],
          latestRelease: {
            tagName: "v1.6.0",
            name: "v1.6.0",
            url: "https://github.com/example/simple-hwp/releases/tag/v1.6.0",
            notesUrl: null,
            publishedAt: "2026-08-15T00:00:00.000Z",
          },
          relationshipState: "bidirectional",
        },
      }}
      license={{
        state: "conflict",
        label: "정보 충돌",
        maker: { value: "MIT", spdxId: "MIT", url: null, sourceLabel: "메이커 제공·미검증" },
        observed: { value: "GNU GPLv3", spdxId: "GPL-3.0", url: null, sourceLabel: "GitHub에서 확인" },
      }}
    />);
    expect(repository).toContain("저장소 생성일");
    expect(repository).toContain("최근 push");
    expect(repository).toContain("최신 release");
    expect(repository).toContain("146");
    expect(repository).toContain("정보 충돌");
    expect(repository).toContain("법률 자문이나 사용 허가를 보증하지 않습니다");

    const collectingRepository = renderToStaticMarkup(<RepositoryEvidence
      repository={{
        provider: "github",
        sourceUrl: "https://github.com/example/pending",
        state: "unobserved",
        observedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        facts: null,
      }}
      license={{ state: "missing", label: "라이선스 확인 안 됨", maker: null, observed: null }}
    />);
    expect(collectingRepository).toContain("저장소 정보를 수집하고 있습니다");
    expect(collectingRepository).not.toContain("GitHub에서 확인");

    const provenance = renderToStaticMarkup(<BuildProvenance
      product={product}
      profile={profile}
      unclaimed={false}
      agents={[{
        id: 1,
        slug: product.slug,
        provider: "OpenAI",
        client: "Codex",
        model: "GPT-5",
        roles: ["planning", "implementation", "review"],
        commitFrom: null,
        commitTo: null,
        dateFrom: null,
        dateTo: null,
        sourceUrl: null,
        evidenceLevel: "maker_reported",
        createdAt: observedAt,
        evidenceLabel: "메이커 제공",
      }]}
      skills={[{
        id: 1,
        slug: product.slug,
        namespace: "openai",
        name: "review",
        version: "1.0.0",
        source: null,
        hash: "b".repeat(64),
        commit: null,
        evidenceLevel: "maker_reported",
        createdAt: observedAt,
        evidenceLabel: "메이커 제공",
      }]}
    />);
    expect(provenance).toContain("어떤 AI로 만들었나");
    expect(provenance).toContain("Codex");
    expect(provenance).toContain("사용한 스킬");
    expect(provenance).toContain("review");
    expect(provenance).toContain("동일한 바이트를 가리킬 뿐 저작자를 증명하지 않습니다");
  });

  it("renders compact evidence and freshness empty states without inventing data", () => {
    const summary = renderToStaticMarkup(<EvidenceSummary
      links={links}
      freshness={freshness}
      profileUpdatedAt={profile.updatedAt}
    />);
    expect(summary).toContain("근거 요약");
    expect(summary).toContain("공식 출처 1");
    expect(summary).toContain("메이커 제공·미검증 1");

    const empty = renderToStaticMarkup(<FreshnessPanel freshness={[]} />);
    expect(empty).toContain("연결된 외부 출처가 없습니다");
    expect(empty).not.toContain(">0<");
  });

  it("offers maker/automatic filters without a connecting timeline line", () => {
    const html = renderToStaticMarkup(<UpdateTimeline updates={[
      {
        id: 1,
        sourceKind: "maker",
        sourceLabel: "메이커 업데이트",
        canonicalUrl: null,
        title: "표가 포함된 문서의 텍스트 추출을 개선했습니다",
        summary: "병합된 셀의 읽기 순서를 보존합니다.",
        beforeAfter: null,
        publishedAt: new Date("2026-08-17T00:00:00.000Z"),
        observedAt,
        makerEditedAt: null,
      },
      {
        id: 2,
        sourceKind: "github_release",
        sourceLabel: "자동 감지",
        canonicalUrl: "https://github.com/example/simple-hwp/releases/tag/v1.6.0",
        title: "v1.6.0 공개",
        summary: "공개 저장소의 최신 release를 확인했습니다.",
        beforeAfter: { stars: { before: 128, after: 146 } },
        publishedAt: new Date("2026-08-14T00:00:00.000Z"),
        observedAt,
        makerEditedAt: null,
      },
    ]} />);
    expect(html).toContain("전체");
    expect(html).toContain("메이커");
    expect(html).toContain("자동 감지");
    expect(html).toContain("v1.6.0 공개");
    const source = readFileSync("components/product-detail/UpdateTimeline.tsx", "utf8");
    expect(source).not.toMatch(/border-l(?:-|\s)|before:|after:/);
  });

  it("keeps source badges explicit and every touched visible font at least 13px", () => {
    expect(renderToStaticMarkup(<SourceBadge label="메이커 제공·미검증" />)).toContain("메이커 제공·미검증");
    const files = [
      "ProductHero.tsx",
      "ProductMetrics.tsx",
      "EvidenceSummary.tsx",
      "ProductGallery.tsx",
      "ProductIntroduction.tsx",
      "ProductFacts.tsx",
      "RepositoryEvidence.tsx",
      "BuildProvenance.tsx",
      "FreshnessPanel.tsx",
      "UpdateTimeline.tsx",
      "SourceBadge.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(`components/product-detail/${file}`, "utf8");
      expect(source, file).not.toMatch(/text-xs|text-\[(?:[0-9]|1[0-2](?:\.\d+)?)px\]/);
    }
  });

  it("composes the dynamic page from the safe detail model in the mobile reading order", () => {
    const source = readFileSync("app/p/[slug]/page.tsx", "utf8");
    expect(source).toContain('export const dynamic = "force-dynamic"');
    expect(source).toContain("getProductDetail(slug)");
    expect(source).not.toContain("findBySlug");
    expect(source).not.toMatch(/댓글|comment/i);
    const order = [
      "<ProductHero",
      "<ProductMetrics",
      "<EvidenceSummary",
      "<ProductGallery",
      "<ProductIntroduction",
      "<ProductFacts",
      "<RepositoryEvidence",
      "<BuildProvenance",
      "<FreshnessPanel",
      "<UpdateTimeline",
    ].map((needle) => source.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});
