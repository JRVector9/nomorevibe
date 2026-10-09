import { existsSync, readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuildTools } from "@/components/product-detail/BuildTools";
import { DetailSkeleton } from "@/components/product-detail/DetailSkeleton";
import { EvidenceCard } from "@/components/product-detail/EvidenceCard";
import { FactsStrip } from "@/components/product-detail/FactsStrip";
import { InfoCard } from "@/components/product-detail/InfoCard";
import { IntroSection } from "@/components/product-detail/IntroSection";
import { LanguageBar } from "@/components/product-detail/LanguageBar";
import { PreviewFigure } from "@/components/product-detail/PreviewFigure";
import { ProductHero } from "@/components/product-detail/ProductHero";
import { RelatedRow } from "@/components/product-detail/RelatedRow";
import { SaveButton } from "@/components/product-detail/SaveButton";
import { SourceBadge } from "@/components/product-detail/SourceBadge";
import { UpdateTimeline } from "@/components/product-detail/UpdateTimeline";
import { UnclaimedOwnerContact } from "@/components/product-detail/UnclaimedOwnerContact";
import { LAST_CODE_UPDATE_LABEL, LATEST_VERSION_LABEL, SITE_REPO_RELATION_LABEL, UNCLAIMED_HINT } from "@/lib/copy/terms";
import { AI_LEVEL_LABELS } from "@/lib/domain/evidence/ai-level-labels";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { TAKEDOWN_PROMISE } from "@/lib/domain/products/takedown-view";
import type { ProductListItem } from "@/lib/domain/products/view";

const observedAt = new Date("2026-08-19T03:00:00.000Z");
const product: ProductDetailView["product"] = {
  id: 1,
  slug: "simple-hwp",
  url: "https://simplehwp.example",
  accessMode: "website",
  name: "simpleHWP",
  tagline: "별도 뷰어 없이 HWP 문서를 브라우저에서 엽니다.",
  taglineSource: "maker" as const,
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
  aiEvidence: false,
  takedownPending: false, taglineKo: null,
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

const observedRepository: NonNullable<ProductDetailView["repository"]> = {
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
};

const observedLicense: ProductDetailView["license"] = {
  state: "observed_only",
  label: "GitHub에서 확인",
  maker: null,
  observed: { value: "GNU GPLv3", spdxId: "GPL-3.0", url: null, sourceLabel: "GitHub에서 확인" },
};

const conflictLicense: ProductDetailView["license"] = {
  state: "conflict",
  label: "정보 충돌",
  maker: { value: "MIT", spdxId: "MIT", url: null, sourceLabel: "메이커 제공·미검증" },
  observed: { value: "GNU GPLv3", spdxId: "GPL-3.0", url: null, sourceLabel: "GitHub에서 확인" },
};

const collectingVisits: ProductDetailView["visits"] = {
  periodDays: 7,
  validVisits: 0,
  uniqueVisitors: null,
  uniqueChangePercent: null,
  collectionStartedAt: null,
  collecting: true,
};

const unchecked: ProductDetailView["health"] = { uptime30d: null, latencyMs: null, checkedAt: null, down: false };

/** 히어로는 기본 픽스처로 그리고, 케이스마다 바뀌는 값만 덮어쓴다 */
function renderHero(overrides: Partial<ComponentProps<typeof ProductHero>> = {}) {
  return renderToStaticMarkup(<ProductHero product={product} unclaimed={false} risingRank={null} health={unchecked} languages={[]} {...overrides} />);
}

function renderFacts(overrides: Partial<ComponentProps<typeof FactsStrip>> = {}) {
  return renderToStaticMarkup(<FactsStrip product={product} repository={observedRepository} license={observedLicense} health={unchecked} visits={collectingVisits} {...overrides} />);
}

function renderIntro(overrides: Partial<ComponentProps<typeof IntroSection>> = {}) {
  return renderToStaticMarkup(<IntroSection product={product} profile={null} readmeExcerpt={null} unclaimed={false} {...overrides} />);
}

function renderTools(overrides: Partial<ComponentProps<typeof BuildTools>> = {}) {
  return renderToStaticMarkup(<BuildTools product={product} unclaimed={false} agents={[]} observedAgentFacts={[]} skills={[]} aiLevel={{ checked: true, level: null }} {...overrides} />);
}

/** 태그를 걷어낸 글자만 — 알약 안의 숫자처럼 span 으로 나뉜 문구를 한 줄로 확인한다 */
const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

const observedFact: ProductDetailView["observedAgentFacts"][number] = {
  label: "모델 설정 확인", clientLabel: "Claude Code", modelLabel: "glm-4.7", gatewayLabel: "Z.AI",
  role: "sonnet", scope: "", sourceUrl: "https://github.com/acme/app/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/.claude/settings.json",
  sourcePath: ".claude/settings.json", commitSha: "a".repeat(40), observedAt,
  coverageLabel: "일부 미확인", relationshipLabel: "제품과 저장소 관계 미확인", executionVerified: false,
};

describe("evidence product detail components", () => {
  it("renders the name, the unclaimed mark, save and share, and a 44px outbound action", () => {
    const html = renderHero({ unclaimed: true, health: { uptime30d: 99, latencyMs: 84, checkedAt: new Date(), down: false } });

    expect(html).toContain(`>${product.name}</h1>`);
    // 옛 '미클레임' 대신 용어표의 말(UX-14)과 툴팁
    expect(textOf(html)).toContain("운영자 미확인");
    expect(html).not.toContain("미클레임");
    expect(html).toContain(`title="${UNCLAIMED_HINT}"`);
    expect(html).toMatch(/<a href="\/go\/simple-hwp"[^>]*class="[^"]*min-h-11[^"]*"[^>]*>제품 방문하기<\/a>/);
    expect(html).not.toContain('href="https://simplehwp.example"');
    expect(html).toContain(`href="${product.repoUrl}"`);
    // 응답 시간(ms)은 툴팁으로만
    expect(textOf(html)).toContain("온라인");
    expect(textOf(html)).not.toContain("84ms");
    expect(html).toContain('title="응답 시간 84ms"');
    expect(html).toContain('aria-label="simpleHWP 저장"');
    // 시즌 순위·검증 배지·운영 단계는 히어로에서 뺐다 — 머리는 이름·소개·메타 한 줄만
    expect(html).not.toContain("이번 시즌");
  });

  it("keeps four buttons — visit, GitHub, share with a label, save — and drops the duplicate domain link (UX-31)", () => {
    const html = renderHero();
    expect(html).toMatch(/<a [^>]*aria-label="GitHub 저장소"[^>]*>GitHub<\/a>/);
    // 공유는 바깥 링크 화살표(↗)가 아니라 공유 아이콘과 '공유' 글자 — 접근 이름도 '공유'
    expect(html).toMatch(/<button type="button"[^>]*><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>공유<\/button>/);
    expect(html).not.toContain('aria-label="공유"');
    // 단추 줄의 차례 — 방문 · GitHub · 공유 · 저장
    const order = ["제품 방문하기</a>", ">GitHub</a>", "공유</button>", 'aria-label="simpleHWP 저장"'].map((needle) => html.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    // 같은 사이트로 가는 도메인 글자 링크는 없다 — 사이트 주소는 정보 카드의 '웹사이트' 줄
    expect(textOf(html)).not.toContain("simplehwp.example");
    expect(html.match(/href="\/go\/simple-hwp"/g)).toHaveLength(1);
  });

  it("names the current repository owner as the operator, not the account in an old repository URL (UX-15, amontlabs/lcu)", () => {
    // 등록한 주소는 0xpolarzero/lcu, GitHub 이 넘겨준 정식 주소는 amontlabs/lcu(2026-10-08 감사)
    const lcu = { ...product, repoUrl: "https://github.com/0xpolarzero/lcu" };
    const moved = { ...observedRepository, facts: { ...observedRepository.facts!, repositoryKey: "amontlabs/lcu", repositoryUrl: "https://github.com/amontlabs/lcu" } };
    const hero = textOf(renderHero({ product: lcu, repositoryUrl: moved.facts.repositoryUrl }));
    expect(hero).toContain("GitHub @amontlabs");
    expect(hero).not.toContain("@0xpolarzero");
    const info = renderToStaticMarkup(<InfoCard product={lcu} repository={moved} freshness={freshness} unclaimed />);
    expect(textOf(info)).toContain("운영 주체@amontlabs ↗GitHub 저장소 소유자");
    expect(textOf(info)).toContain("주요 기여자@0xpolarzero ↗이전 저장소 주소의 계정");
    expect(info).toContain('href="https://github.com/amontlabs"');
    expect(info).toContain('href="https://github.com/amontlabs/lcu"');
    // 저장소를 아직 읽지 않았으면 등록한 주소의 계정이 운영 주체, 기여자 줄은 없다
    const unread = textOf(renderToStaticMarkup(<InfoCard product={lcu} repository={null} freshness={[]} unclaimed />));
    expect(unread).toContain("운영 주체@0xpolarzero ↗");
    expect(unread).not.toContain("주요 기여자");
  });

  it("shows the rising rank badge only inside the top twenty", () => {
    expect(renderHero({ risingRank: 5 })).toContain("지금 뜨는 5위");
    expect(renderHero({ risingRank: 21 })).not.toContain("지금 뜨는");
    expect(renderHero({ risingRank: null })).not.toContain("지금 뜨는");
  });

  it("puts category, stars, top languages, owner and status in one meta line without a large image", () => {
    const html = renderHero({ product: { ...product, stars: 40064 }, languages: ["Rust", "TypeScript"] });
    expect(html).toContain("생산성");
    expect(html).toContain("★ 40,064");
    expect(html).toContain("Rust · TypeScript");
    expect(html).toContain("GitHub @example");
    expect(html).toContain("가동 상태 확인 전");
    expect(html).not.toContain("product-hero-media");
    expect(html).not.toContain("<figure");
  });

  it("저장소가 사라졌다고 확정되면 저장소로 보내거나 설치하라고 하지 않고 그렇다고 알린다", () => {
    // 웹사이트: 제품 방문은 그대로, GitHub 저장소 단추·★ 는 빼고 한 줄로 알린다(★ 는 detail-view 가 이미 비운다)
    const website = renderHero({ product: { ...product, repoGone: true, stars: null } });
    expect(website).toContain("제품 방문하기");
    expect(website).not.toContain(`href="${product.repoUrl}"`);
    expect(website).not.toContain("★");
    expect(textOf(website)).toContain("GitHub 저장소가 사라졌습니다(삭제 또는 비공개).");
    // 설치형: 저장소 열기·설치 프롬프트 대신
    const installable = textOf(renderHero({ product: { ...product, accessMode: "installable", repoGone: true, stars: null } }));
    expect(installable).toContain("저장소가 사라졌습니다");
    expect(installable).not.toContain("GitHub 저장소 열기");
    expect(installable).not.toContain("설치 프롬프트 복사");
    // 확정 전에는 그대로
    expect(textOf(renderHero({ product: { ...product, accessMode: "installable" } }))).toContain("설치 프롬프트 복사");
    // 정보 카드의 저장소 줄도 링크 없이
    const info = renderToStaticMarkup(<InfoCard product={{ ...product, repoGone: true }} repository={observedRepository} freshness={freshness} unclaimed={false} />);
    expect(info).not.toContain('href="https://github.com/example/simple-hwp"');
    expect(textOf(info)).toContain("사라짐 · 삭제 또는 비공개");
  });

  it("shows only an internal icon copy, never an external image URL", () => {
    // 우리 사본을 화면 크기로 줄인 WebP 로(og-variants.ts)
    expect(renderHero({ product: { ...product, ogImage: "/api/og-cache/simple-hwp?thumbnail=site_icon&w=64&h=64" } }))
      .toContain('src="/api/og-cache/simple-hwp.webp?thumbnail=site_icon&amp;w=64&amp;h=64&amp;size=192"');
    // 대표 이미지(OG 배너)는 정사각 아이콘 자리에 잘라 넣지 않는다 — 모노그램이 대신한다(UX-32)
    expect(renderHero({ product: { ...product, ogImage: "/api/og-cache/simple-hwp" } })).not.toContain("<img");
    expect(renderHero({ product: { ...product, ogImage: "https://tracker.example/og.png" } })).not.toContain("tracker.example");
  });

  it("still says when the one-line intro was written by AI rather than the maker", () => {
    // 지은 소개를 메이커가 쓴 것처럼 두지 않는다(사용자 결정 2026-09-20)
    expect(renderHero({ product: { ...product, taglineSource: "ai_readme" } })).toContain("AI가 요약 · README에서");
    expect(renderHero()).not.toContain("AI가 요약");
  });

  it("does not call a nineteen-day-old health observation online", () => {
    const health = { uptime30d: 99, latencyMs: 84, checkedAt: new Date(Date.now() - 19 * 86400000), down: false };
    const html = renderHero({ health });
    expect(html).not.toContain("온라인");
    expect(html).toContain("가동 상태 재확인 필요");
    const facts = renderFacts({ health });
    expect(facts).not.toContain("온라인");
    expect(facts).toContain("재확인 필요");
  });

  it("does not label a fresh failed health check online before the down threshold", () => {
    const health = { uptime30d: 99, latencyMs: null, checkedAt: new Date(), down: false, lastCheckSucceeded: false };
    const html = renderHero({ health });
    expect(html).not.toContain("온라인");
    expect(html).toContain("최근 접속 확인 실패");
    expect(html).not.toContain("접속 불안정");
    const facts = renderFacts({ health });
    expect(facts).not.toContain("온라인");
    expect(facts).toContain("접속 확인 실패");
    expect(facts).not.toContain("접속 불안정");
  });

  it("toggles the saved list through a labelled pressed state", () => {
    const html = renderToStaticMarkup(<SaveButton slug="simple-hwp" name="simpleHWP" />);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="simpleHWP 저장"');
  });

  it("shows visits only when NoMoreVibe actually measured some", () => {
    expect(renderFacts({ visits: { ...collectingVisits, collecting: true } })).not.toContain("유효 방문");
    const measured = renderFacts({ visits: { ...collectingVisits, collecting: false, validVisits: 12, uniqueVisitors: 9, uniqueChangePercent: 50 } });
    expect(measured).toContain("유효 방문 · 최근 7일");
    expect(measured).toContain("고유 9 · +50%");
    // NoMoreVibe 에서 나간 방문만 센다 — 서비스 전체 트래픽처럼 읽히는 말은 쓰지 않는다
    expect(measured).not.toMatch(/전체 트래픽|총 방문자|서비스 전체/);
  });

  it("renders code update, version, contributors, license and listing as the facts", () => {
    const html = renderFacts({ health: { uptime30d: 99, latencyMs: 84, checkedAt: new Date(), down: false } });
    for (const label of [LAST_CODE_UPDATE_LABEL, LATEST_VERSION_LABEL, "기여자", "라이선스", "nomorevibe 등록"]) expect(html).toContain(label);
    // 옛 영어 용어(UX-14)
    expect(html).not.toMatch(/최근 push|최신 release|GitHub 릴리스 기준/);
    expect(html).toContain("가동 상태");
    expect(html).toContain("30일 가동률 99%");
    expect(textOf(html)).not.toContain("84ms");
    expect(html).toContain('title="응답 시간 84ms"');
    expect(html.match(/<dt/g)).toHaveLength(6);
    expect(html).toContain("8월 18일");
    expect(html).toContain("활성 저장소");
    expect(html).toContain("v1.6.0");
    expect(html).toContain("12명");
    expect(html).toContain("포크 18");
    expect(html).toContain("GPL-3.0");
    expect(html).toContain("저장소 생성 2025년 1월");
    expect(renderFacts({ product: { ...product, accessMode: "installable" } })).toContain("이용 방식");
  });

  it("names both licenses when the maker and the repository disagree", () => {
    const html = renderFacts({ license: conflictLicense });
    expect(html).toContain("정보 충돌");
    expect(html).toContain("MIT");
    expect(html).toContain("GPL-3.0");
    expect(html).toContain("두 값을 모두 확인하세요");
  });

  it("does not invent activity, a release, or a license from an unread repository — empty cells fold into one line (UX-16)", () => {
    const missing: ProductDetailView["license"] = { state: "missing", label: "라이선스 확인 안 됨", maker: null, observed: null };
    const unread = renderFacts({ repository: null, license: missing });
    // 값이 없는 칸은 그리지 않고, 셋보다 적게 남으면 격자 대신 한 줄
    expect(unread).not.toContain("grid");
    expect(unread.match(/<dt/g)).toHaveLength(1);
    expect(textOf(unread)).toContain("nomorevibe 등록7월 1일");
    expect(textOf(unread)).toContain("저장소 정보는 아직 수집하지 않았습니다.");
    expect(unread).not.toContain(">—<");
    expect(unread).not.toMatch(/확인 안 됨|확인 전|가동 상태/);
    expect(unread).not.toContain("활성");
    expect(unread).not.toContain("없음");
    // 저장소가 없는 제품은 '수집 전'이라고 하지 않는다
    expect(renderFacts({ product: { ...product, repoUrl: null }, repository: null, license: missing })).not.toContain("수집하지 않았습니다");
    // 확인한 가동 상태 하나가 더해져도 둘 — 아직 한 줄
    const checked = { uptime30d: null, latencyMs: null, checkedAt: new Date(), down: false };
    const two = renderFacts({ repository: null, license: missing, health: checked });
    expect(two).not.toContain("grid");
    expect(textOf(two)).toContain("가동 상태온라인");
    // 셋이면 격자
    const three = renderFacts({ repository: null, license: observedLicense, health: checked });
    expect(three).toContain("grid");
    expect(three.match(/<dt/g)).toHaveLength(3);
    // 라이선스를 읽지 못했으면 그 칸만 빠진다
    const noLicense = renderFacts({ license: missing });
    expect(noLicense).not.toContain("라이선스");
    expect(noLicense).toContain("grid");

    const unknown = renderFacts({ repository: { ...observedRepository, facts: { ...observedRepository.facts!, archived: null, fork: null } } });
    expect(unknown).not.toContain("활성");
    expect(unknown).toContain("상태 미확인");
  });

  it("previews the first internal copy, else a wide internal image, and nothing for an icon", () => {
    const media: ProductDetailView["media"] = [
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
    ];
    const first = renderToStaticMarkup(<PreviewFigure product={product} media={media} />);
    expect(first).toContain(`src="/api/media/${"a".repeat(64)}"`);
    expect(first).not.toContain("b".repeat(64));
    expect(first).not.toContain("https://");
    expect(first).toContain('width="960"');
    expect(first).toContain('height="600"');
    expect(first).toContain("simpleHWP 문서 뷰어 화면");
    expect(first).toContain("사본 갱신 8월 19일");
    expect(renderToStaticMarkup(<PreviewFigure product={product} media={[media[1]]} />)).toContain("원본 없음 · 보관 이미지");

    // 화면 사본이 없으면 넓은 대표 이미지 — 내부 사본 주소만
    const wideSrc = "/api/og-cache/simple-hwp?thumbnail=repository_image&w=1200&h=400&v=1";
    const wide = textOf(renderToStaticMarkup(<PreviewFigure product={{ ...product, ogImage: wideSrc }} media={[]} />));
    expect(renderToStaticMarkup(<PreviewFigure product={{ ...product, ogImage: wideSrc }} media={[]} />))
      .toContain('src="/api/og-cache/simple-hwp.webp?thumbnail=repository_image&amp;w=1200&amp;h=400&amp;v=1&amp;size=1200"');
    expect(wide).toContain("GitHub 저장소 이미지");
    expect(wide).not.toContain("사본 갱신");

    // 아이콘뿐이거나 바깥 주소면 아무것도 그리지 않는다
    for (const ogImage of [null, "/api/og-cache/simple-hwp?thumbnail=site_icon&w=96&h=96", "https://cdn.example/og.png", "//cdn.example/og.png"]) {
      expect(renderToStaticMarkup(<PreviewFigure product={{ ...product, ogImage }} media={[]} />), String(ogImage)).toBe("");
    }
  });

  it("drops the description line when it repeats the tagline word for word", () => {
    const html = renderIntro({ product: { ...product, description: `  ${product.tagline}  ` } });
    // 소개는 히어로의 한 줄 한 번만 — 소개 구획에는 아예 없고 README 로 가라는 한 줄이 선다
    expect(html).not.toContain(product.tagline);
    expect(html).toContain("메이커가 쓴 소개는 위의 한 줄이 전부입니다");
    expect(html).toContain(`href="${product.repoUrl}"`);
  });

  it("keeps the description when it says something the tagline does not", () => {
    const html = renderIntro();
    expect(html).toContain(product.description);
    expect(html).not.toContain("위의 한 줄이 전부입니다");
  });

  it("adds a readme excerpt when the intro is a single line", () => {
    const html = renderIntro({ product: { ...product, description: product.tagline }, readmeExcerpt: "The README says more.\n\nSecond paragraph." });
    expect(html).toContain("README에서");
    expect(html).toContain("Second paragraph");
    expect(html).toContain("README 전문 보기");
    expect(html).not.toContain("위의 한 줄이 전부입니다");
  });

  it("shows structured introduction and safe markdown without raw scripts", () => {
    const html = renderIntro({ profile });
    expect(html).toContain(">소개<");
    expect(html).toContain("해결하는 문제");
    expect(html).toContain("주요 기능");
    expect(html).toContain("메이커 제공·미검증");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("tracker.example");

    const unclaimed = renderIntro({ profile, unclaimed: true });
    expect(unclaimed).toContain("저장소 README에서 가져옴");
    expect(unclaimed).not.toContain("메이커 제공·미검증");
  });

  it("draws the top three languages and folds the rest into one share", () => {
    const languages = [["C", 71.4], ["Swift", 12.8], ["Python", 7.5], ["Objective-C", 5], ["Shell", 3.3]]
      .map(([name, percent]) => ({ name: name as string, bytes: 1, percent: percent as number }));
    const html = renderToStaticMarkup(<LanguageBar repository={{ ...observedRepository, facts: { ...observedRepository.facts!, languages } }} />);
    expect(html).toContain("언어 구성");
    expect(html).toContain("Swift");
    expect(html).toContain("Objective-C 외");
    expect(html).toContain("8.3%");
    expect(html).not.toContain("Shell");
    expect(renderToStaticMarkup(<LanguageBar repository={null} />)).toBe("");
  });

  it("renders objective facts as one info card: owner, site, repository, connection, category, access, stack, last refresh", () => {
    const html = renderToStaticMarkup(<InfoCard product={product} repository={observedRepository} freshness={freshness} unclaimed={false} />);
    const text = textOf(html);
    for (const label of ["정보", "운영 주체", "웹사이트", "저장소", SITE_REPO_RELATION_LABEL, "분야", "이용 방식", "기술 스택", "정보 갱신"]) expect(text).toContain(label);
    // '확인'은 AI 흔적 검사와 헷갈린다 — 정보를 읽은 때는 '정보 갱신'(UX-16), 옛 '서비스 연결'(UX-14)도 없다
    expect(text).not.toMatch(/마지막 확인|서비스 연결|주요 기여자/);
    expect(html).toContain('href="https://github.com/example"');
    expect(text).toContain("@example ↗");
    expect(text).toContain("GitHub 저장소 소유자");
    expect(html).toContain('href="https://github.com/example/simple-hwp"');
    expect(text).toContain("example/simple-hwp ↗");
    expect(text).toContain("공개 · 활성");
    expect(text).toContain("서로 주소를 적어 둠");
    expect(html).toContain('href="/go/simple-hwp"');
    expect(text).toContain("simplehwp.example ↗");
    expect(text).toContain("생산성");
    expect(text).toContain("웹사이트");
    expect(text).toContain("React · WASM · Rust");
    expect(text).toContain("8월 19일");
    expect(text).toContain("GitHub");
    // 작은 글자 링크는 모두 진한 코랄
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html.match(/<a [^>]*text-accent-ink/g)).toHaveLength(3);

    // GitHub 저장소가 아니면 소유자 대신 메이커 — 미클레임이면 신고값이 아니라 우리 추정
    const unclaimed = textOf(renderToStaticMarkup(<InfoCard product={{ ...product, repoUrl: "https://gitlab.com/example/simple-hwp" }} repository={null} freshness={[]} unclaimed />));
    expect(unclaimed).toContain("Simple Tools");
    expect(unclaimed).toContain("우리 추정");
    expect(unclaimed).not.toContain("신고값");
    expect(unclaimed).not.toContain(SITE_REPO_RELATION_LABEL);
    // 아직 아무것도 읽지 않았으면 갱신 줄이 없다 — '확인 전'이라고 하지 않는다
    expect(unclaimed).not.toContain("정보 갱신");
    expect(unclaimed).not.toContain("확인 전");

    const installable = textOf(renderToStaticMarkup(<InfoCard product={{ ...product, accessMode: "installable" }} repository={observedRepository} freshness={freshness} unclaimed={false} />));
    expect(installable).toContain("없음 · 저장소가 제품 페이지");
    expect(installable).toContain("직접 설치");
    expect(installable).not.toContain("simplehwp.example");
  });

  it("운영자 안내에는 소유자 정보를 되풀이하지 않고 확인 명령과 내려달라는 요청을 남긴다", () => {
    const html = renderToStaticMarkup(<UnclaimedOwnerContact
      repoUrl="https://github.com/AgentWorkforce/relay"
      slug="agent-relay"
    />);
    expect(html).toContain("이 프로젝트의 운영자인가요?");
    expect(html).toContain("/nomorevibe verify");
    // 막다른 안내가 아니다 — 확인 순서(/launch#verify)와 사이트 안 요청(/policy#contact)으로 보낸다(UX-18, C5·C6)
    expect(html).toMatch(/<a [^>]*href="\/launch#verify"[^>]*>1분 만에 확인하기<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/policy#contact"[^>]*>관리자에게 요청<\/a>/);
    expect(textOf(html)).toContain("CLI를 쓰지 않나요? GitHub 로그인으로 확인하는 방법은 준비 중입니다.");
    // 공개 이메일은 두지 않는다(D5)
    expect(html).not.toMatch(/mailto:|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(html).not.toContain("운영 주체와 연락");
    // 내려달라는 요청 — 갈래 둘, 운영자 확인 방법, 처리 약속과 절차 링크, 연락처 칸 없음(UX-19, D5)
    expect(html.match(/<input type="radio"[^>]*name="kind"/g)).toHaveLength(2);
    expect(textOf(html)).toContain("운영자 요청 · 운영자가 목록에서 빼 달라는 요청");
    expect(textOf(html)).toContain("스팸·악성 신고 · 스팸이거나 악성 코드·사기로 이어지는 프로젝트");
    expect(textOf(html)).toContain("저장소에 이 요청을 적은 이슈를 열거나 저장소에 파일을 하나 더한 뒤");
    expect(textOf(html)).toContain(TAKEDOWN_PROMISE);
    expect(html).toMatch(/<a [^>]*href="\/policy#takedown"[^>]*>처리 절차 보기<\/a>/);
    expect(html).not.toMatch(/type="email"|연락처|이메일/);
    expect(html).not.toContain("@AgentWorkforce");
    expect(html).not.toContain("https://github.com/AgentWorkforce");
    expect(html).not.toContain("<img");
    expect(html).toContain("목록에서 내려달라고 요청하기");

    expect(renderToStaticMarkup(<UnclaimedOwnerContact repoUrl="https://gitlab.com/acme/app" slug="app" />))
      .toBe("");
  });

  it("정보 카드와 운영자 안내를 함께 보여줘도 저장소 소유자 프로필은 한 번만 나온다", () => {
    const html = renderToStaticMarkup(<>
      <InfoCard product={product} repository={observedRepository} freshness={freshness} unclaimed />
      <UnclaimedOwnerContact repoUrl={product.repoUrl} slug={product.slug} />
    </>);
    expect(textOf(html).match(/@example ↗/g)).toHaveLength(1);
    expect(html.match(/href="https:\/\/github.com\/example"/g)).toHaveLength(1);
    expect(html).toContain("GitHub 저장소 소유자");
    expect(html).toContain("이 프로젝트의 운영자인가요?");
  });

  it("설치형 프로젝트의 소유권 확인 안내는 지원하지 않는 도메인 확인 명령을 권하지 않는다", () => {
    const html = renderToStaticMarkup(<UnclaimedOwnerContact repoUrl={product.repoUrl} slug={product.slug} installable />);
    expect(textOf(html)).toContain("설치형 프로젝트는 배포 도메인이 없어 명령으로 소유를 확인할 수 없습니다.");
    expect(html).toMatch(/<a [^>]*href="\/policy#contact"[^>]*>관리자에게 요청<\/a>/);
    expect(textOf(html)).toContain("GitHub 로그인으로 저장소 주인을 확인하는 방법은 준비 중입니다.");
    expect(html).toContain("목록에서 내려달라고 요청하기");
    expect(html).not.toContain("/nomorevibe verify");
    expect(html).not.toContain("/launch#verify");
  });

  it("renders one chip per observed tool with its citation while preserving maker reporting", () => {
    const html = renderTools({
      observedAgentFacts: [observedFact, { ...observedFact, label: "커밋 기여 표기 확인", commitSha: "b".repeat(40) }],
      agents: [{
        id: 1, slug: product.slug, provider: "OpenAI", client: "Codex", model: "GPT-5", roles: ["planning", "implementation", "review"],
        commitFrom: null, commitTo: null, dateFrom: null, dateTo: null, sourceUrl: null, evidenceLevel: "maker_reported",
        createdAt: observedAt, evidenceLabel: "메이커 제공",
      }],
      skills: [{
        id: 1, slug: product.slug, namespace: "openai", name: "review", version: "1.0.0", source: null, hash: "b".repeat(64),
        commit: null, evidenceLevel: "maker_reported", createdAt: observedAt, evidenceLabel: "메이커 제공",
      }],
    });
    expect(html).toContain("무엇으로 만들었나");
    expect(html).toContain("메이커 신고");
    expect(html).toContain("● Codex");
    expect(html).toContain("OpenAI · Codex · GPT-5");
    expect(html).toContain("openai/review@1.0.0");
    // 같은 도구의 흔적 둘은 알약 하나 — 첫 흔적과 근거 링크, 나머지는 '외 1'
    expect(html).toContain("Claude Code");
    expect(html).toContain("모델 설정 확인");
    expect(html).toContain(`href="${observedFact.sourceUrl}"`);
    expect(html).toContain("근거 aaaaaaa");
    expect(html).toContain("외 1");
    expect(html).toContain("일부 미확인 · 제품과 저장소 관계 미확인");
    // 흔적은 사용 주장일 뿐 — 미클레임이면 메이커 신고값을 쓰지 않는다
    expect(renderTools({ unclaimed: true, observedAgentFacts: [observedFact] })).not.toContain("메이커 신고");
  });

  it("names a known model after the tool and leaves an unknown one out", () => {
    expect(textOf(renderTools({ observedAgentFacts: [{ ...observedFact, modelLabel: "claude-sonnet-4" }] }))).toContain("Claude Code · claude-sonnet-4");
    for (const modelLabel of ["미확인", "미확인 (자동 선택)"]) {
      const html = textOf(renderTools({ observedAgentFacts: [{ ...observedFact, modelLabel }] }));
      expect(html, modelLabel).toContain("Claude Code");
      expect(html, modelLabel).not.toContain("Claude Code ·");
    }
    // 같은 도구의 흔적 중 모델을 아는 것이 하나라도 있으면 그 이름
    const mixed = textOf(renderTools({ observedAgentFacts: [{ ...observedFact, modelLabel: "미확인" }, { ...observedFact, modelLabel: "glm-4.7" }] }));
    expect(mixed).toContain("Claude Code · glm-4.7");
  });

  it("says the AI-trace scan is pending, or that no trace was found, instead of omitting the section", () => {
    const empty = { product: { ...product, builder: null }, agents: [], observedAgentFacts: [], skills: [] };
    const unchecked = { checked: false, level: null };
    // 정보 카드의 '정보 갱신'과 다른 일 — '확인'이라 부르지 않는다(UX-16)
    const pending = renderTools({ ...empty, aiLevel: unchecked });
    expect(pending).toContain("AI 흔적 검사 대기 중");
    expect(pending).not.toContain("확인하지 않았습니다");
    // 검사했지만 근거가 없다 — AI 없이 만들었다는 말로 읽히지 않게
    expect(renderTools({ ...empty, aiLevel: { checked: true, level: null } }))
      .toContain("검사에서 AI 코딩 도구 흔적을 찾지 못했습니다 — AI 없이 만들었다는 뜻은 아닙니다.");
    // GitHub 저장소가 없거나 사라졌으면 기다릴 검사가 없다 — 남아 있는 단계도 보이지 않는다
    for (const changed of [{ repoUrl: "https://gitlab.com/acme/app" }, { repoUrl: null }, { repoGone: true }]) {
      for (const aiLevel of [unchecked, { checked: true, level: 2 as const }]) {
        const html = renderTools({ ...empty, product: { ...empty.product, ...changed }, aiLevel });
        expect(html, JSON.stringify(changed)).toContain("AI 흔적 검사를 할 수 없습니다");
        expect(html, JSON.stringify(changed)).not.toContain("대기 중");
        expect(html, JSON.stringify(changed)).not.toContain("단계");
      }
    }
  });

  it.each([1, 2, 3] as const)("names AI level %i and its description without links or tool names", (level) => {
    const html = renderTools({ product: { ...product, builder: null }, aiLevel: { checked: true, level } });
    const text = textOf(html);
    expect(text).toContain(`AI 제작 근거 ${level}단계 · ${AI_LEVEL_LABELS[level].title}`);
    expect(text).toContain(AI_LEVEL_LABELS[level].description);
    expect(html).not.toContain("<a ");
    expect(text).not.toContain("찾지 못했습니다");
    expect(text).not.toContain("대기 중");
  });

  it("keeps the maker-reported builder next to the AI level line", () => {
    const text = textOf(renderTools({ aiLevel: { checked: true, level: 1 } }));
    expect(text).toContain("메이커 신고");
    expect(text).toContain(`AI 제작 근거 1단계 · ${AI_LEVEL_LABELS[1].title}`);
    // 신고값만 있고 검사 전이면 지금처럼 신고값만
    const pending = textOf(renderTools({ aiLevel: { checked: false, level: null } }));
    expect(pending).toContain("메이커 신고");
    expect(pending).not.toContain("대기 중");
  });

  it.each([null, "maker_reported"] as const)("does not invent activity or a verified direction from unknown repository facts (%s)", (relationshipState) => {
    const html = renderToStaticMarkup(<InfoCard product={product} freshness={[]} unclaimed={false} repository={{
      provider: "github", sourceUrl: "https://github.com/acme/app", state: "ok", observedAt, lastSuccessAt: observedAt, lastFailureAt: null,
      facts: { repositoryKey: "acme/app", repositoryUrl: "https://github.com/acme/app", createdAt: null, pushedAt: null, updatedAt: null,
        stars: null, forks: null, public: null, archived: null, fork: null, homepage: null, contributors: null, license: null,
        languages: [], latestRelease: null, relationshipState },
    }} />);
    expect(html).not.toContain("활성");
    expect(html).not.toContain("일부 방향만 확인");
    expect(html).not.toContain("공개 ·");
    expect(html).toContain("상태 미확인");
    // 누가 누구의 주소를 적었는지 모르면 줄째 없다 — 메이커가 알려 준 것은 그렇다고 적는다
    if (relationshipState) expect(textOf(html)).toContain(`${SITE_REPO_RELATION_LABEL}메이커가 알려 줌 · 확인 전`);
    else expect(html).not.toContain(SITE_REPO_RELATION_LABEL);
  });

  it("renders compact evidence and freshness empty states without inventing data", () => {
    const counted = textOf(renderToStaticMarkup(<EvidenceCard links={links} freshness={freshness} />));
    expect(counted).toContain("근거");
    expect(counted).toContain("GitHub에서 확인 1");
    expect(counted).toContain("공식 출처 1");
    expect(counted).toContain("메이커 제공 1");
    expect(counted).not.toContain("확인 필요");

    // 저장소만 읽었고 그 정보가 오래됐으면 — 링크 수는 0, 문제 수는 따로
    const stale = textOf(renderToStaticMarkup(<EvidenceCard links={[]} freshness={[{ ...freshness[0], state: "stale", label: "오래된 정보" }]} />));
    expect(stale).toContain("GitHub에서 확인 1");
    expect(stale).toContain("공식 출처 0");
    expect(stale).toContain("메이커 제공 0");
    expect(stale).toContain("확인 필요 1");

    // 링크가 응답만 했거나 자동으로 찾은 것이면 그 수도 숨기지 않는다
    const automatic = textOf(renderToStaticMarkup(<EvidenceCard freshness={[]}
      links={[{ ...links[0], verificationState: "stale", declarationSource: "discovered", evidenceLabel: "자동 감지" }]} />));
    expect(automatic).toContain("자동 감지 1");
    expect(automatic).toContain("GitHub에서 확인 0");

    const empty = renderToStaticMarkup(<EvidenceCard links={[]} freshness={[]} />);
    expect(empty).toContain("연결된 외부 출처가 없습니다");
    expect(empty).not.toContain(">0<");
  });

  it("offers maker/automatic filters without a connecting timeline line", () => {
    const older: ProductDetailView["updates"] = [
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
    ];
    const html = renderToStaticMarkup(<UpdateTimeline updates={older} now={new Date()} />);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-selected="true"[^>]*>전체</);
    expect(html).toContain("메이커");
    expect(html).toContain("자동 감지");
    expect(html).toContain("v1.6.0 공개");
    expect(html).toContain("GitHub 릴리스 ↗");
    // 최근 30일 안의 것이 없으면 전체 건수만
    expect(html).not.toContain("최근 30일");
    expect(html).toContain(">2건<");
    expect(html).not.toContain("모두 보기");
    const source = readFileSync("components/product-detail/UpdateTimeline.tsx", "utf8");
    expect(source).not.toMatch(/border-l(?:-|\s)|before:|after:/);
  });

  it("shows the thirty-day count in the heading and only eight rows before the toggle", () => {
    const recent: ProductDetailView["updates"] = Array.from({ length: 10 }, (_, index) => ({
      id: 10 + index,
      sourceKind: "github_release" as const,
      sourceLabel: "자동 감지" as const,
      canonicalUrl: `https://github.com/example/simple-hwp/releases/tag/v2.${index}.0`,
      title: `v2.${index}.0`,
      summary: null,
      beforeAfter: null,
      publishedAt: new Date(Date.now() - (index + 1) * 86_400_000),
      observedAt: new Date(),
      makerEditedAt: null,
    }));
    const old = { ...recent[0], id: 99, title: "v1.0.0", publishedAt: new Date(Date.now() - 60 * 86_400_000) };
    const html = renderToStaticMarkup(<UpdateTimeline updates={[...recent, old]} now={new Date()} />);
    expect(html).toContain("최근 30일 10건");
    expect(html.match(/<li/g)).toHaveLength(8);
    expect(html).toContain("11건 모두 보기");
    expect(html).not.toContain("v2.8.0");
  });

  it("keeps source badges explicit and every touched visible font at least 13px", () => {
    expect(renderToStaticMarkup(<SourceBadge label="메이커 제공·미검증" />)).toContain("메이커 제공·미검증");
    const files = [
      "ProductHero.tsx",
      "FactsStrip.tsx",
      "IntroSection.tsx",
      "LanguageBar.tsx",
      "BuildTools.tsx",
      "UpdateTimeline.tsx",
      "InfoCard.tsx",
      "PreviewFigure.tsx",
      "EvidenceCard.tsx",
      "SourceBadge.tsx",
      "UnclaimedOwnerContact.tsx",
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
    expect(source).toContain("risingRank={detail.risingRank}");
    expect(source).not.toContain("<ProductGallery");
    expect(source).not.toContain("<EvidenceCard");
    // 홈과 같은 폭 — 상세만의 1220px 틀은 버렸다
    expect(source).toContain('<main className="wrap pb-14">');
    expect(source).not.toContain("max-w-[1220px]");
    // 분야 총수는 꾸밈 — 세다가 실패해도 페이지는 선다
    // 30초 읽기 캐시(publicRead)로 감싸도 실패는 null 로 삼킨다
    expect(source).toMatch(/countProducts\(\{[^}]*excludeDown: true[^}]*\}\)\)?\.catch\(\(\) => null\)/);
    // 없는 제품은 진짜 404 — 기본 정보로 notFound() 를 먼저 부르고, 본문만 Suspense 안에서 머리 골격을 보이며 채운다.
    // 구간 loading.tsx 는 응답을 먼저 흘려 상태를 200 으로 굳히므로 두지 않는다(UX-38)
    expect(existsSync("app/p/[slug]/loading.tsx")).toBe(false);
    const notFoundAt = source.indexOf("if (!identity) notFound();");
    expect(notFoundAt).toBeGreaterThan(-1);
    expect(notFoundAt).toBeLessThan(source.indexOf("<Suspense fallback={<DetailSkeleton />}>"));
    expect(renderToStaticMarkup(<DetailSkeleton />)).toContain('aria-busy="true"');
    // 읽기 순서: 히어로 → 핵심 사실 → 무엇으로 만들었나 → 소개 → 언어 → 업데이트 → 정보 → 미리보기 → 운영자 → 같은 분야
    const order = [
      "<ProductHero",
      "<FactsStrip",
      "<BuildTools",
      "<IntroSection",
      "<LanguageBar",
      "<UpdateTimeline",
      "<InfoCard",
      "<PreviewFigure",
      "<UnclaimedOwnerContact",
      "<RelatedRow",
    ].map((needle) => source.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("ends with the rising projects of the same category, linking to that category's rising list", () => {
    const item = (slug: string): ProductListItem => ({
      slug, name: slug, tagline: `${slug} does things`, taglineSource: "maker", category: "Productivity",
      builder: null, builderClaim: "guessed", stack: [], ogImage: null, makerName: null,
      repoUrl: `https://github.com/acme/${slug}`, listedAt: new Date("2026-10-02T00:00:00Z"), status: "seeded",
      unclaimed: true, stars: 990, starsAt: new Date("2026-10-02T00:00:00Z"), starsPrevious: 980,
      starsPreviousAt: new Date("2026-10-01T00:00:00Z"),
    });
    // total 은 그 분야에서 지금 뜨는 수다 — 분야 전체가 아니다
    const html = renderToStaticMarkup(<RelatedRow category="Productivity" items={[item("alpha"), item("beta")]} total={37} />);
    expect(html).toContain("생산성 분야에서 지금 뜨는");
    expect(html).toContain("하루 평균");
    expect(html).toContain("스타 2천 미만");
    // 홈의 기본 정렬('추천')이 같은 급상승 순서다 — 최신순(sort=recent)으로 보내지 않는다
    // 분야는 정식 주소(/c/<소문자>)로 보낸다 — 옛 /?category= 는 307 로 넘어간다(UX-40)
    expect(html).toContain('href="/c/productivity"');
    expect(html).not.toContain("sort=recent");
    expect(textOf(html)).toContain("37개 모두 보기 ›");
    expect(html).toContain('href="/p/alpha"');
    expect(html).toContain('href="/p/beta"');
    // 총수를 못 세면 숫자 없이, 추천이 없으면 구획째 없다
    const uncounted = textOf(renderToStaticMarkup(<RelatedRow category="Productivity" items={[item("alpha")]} total={null} />));
    expect(uncounted).toContain("모두 보기 ›");
    expect(uncounted).not.toContain("개 모두 보기");
    expect(renderToStaticMarkup(<RelatedRow category="Productivity" items={[]} total={3} />)).toBe("");
  });
});


it("offers an installation prompt instead of a visit CTA or a website uptime claim", () => {
  const installable = { ...product, accessMode: "installable" as const, url: product.repoUrl! };
  const health = { uptime30d: null, latencyMs: null, checkedAt: null, down: false };
  const html = renderHero({ product: installable, unclaimed: true, health });
  expect(html).toContain("직접 설치");
  expect(html).toContain("GitHub 저장소 열기");
  expect(html).toContain("설치 프롬프트 복사");
  // 자동 복사가 막혀도 직접 골라 복사할 칸이 남는다
  expect(html).toContain(">설치 프롬프트</label>");
  expect(html).toContain("Claude·ChatGPT");
  expect(html).toContain(product.repoUrl);
  expect(html).not.toContain("제품 방문하기");
  expect(html).not.toContain("가동 상태 확인 전");
  const facts = renderFacts({ product: installable, health });
  expect(facts).not.toContain("30일 가동률");
  expect(facts).not.toContain("가동 상태");
  expect(facts).toContain("사용자 환경에서 실행");
});
