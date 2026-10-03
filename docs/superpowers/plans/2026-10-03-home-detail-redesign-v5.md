# 홈·상세 리디자인 5차 반영 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시안 5차(`docs/design/redesign-v5/home.html`, `product.html`)대로 홈과 상세를 바꾼다 — 히어로 없이 들어오자마자 프로젝트, 아이콘 타일 카드, 애플식 중립 팔레트에 코랄 포인트 하나, 상세는 큰 이미지 없이 사실로 채운다.

**Architecture:** 데이터 계층(`lib/domain/products/*`)에 홈 띠·상세 배지에 필요한 조회 넷을 더하고(급상승 상위·이번 주 새로 공개·급상승 순위·같은 분야 급상승), 화면은 기존 서버 컴포넌트 구성을 유지한 채 구획별 컴포넌트를 갈아 끼운다. 홈은 `app/home.css`를 다시 쓰고, 상세는 Tailwind 유틸리티와 `globals.css` 토큰만 바꾼다. 네 PR로 나눠 각 PR이 홀로 배포 가능하게 한다.

**Tech Stack:** Next.js 16 App Router(서버 컴포넌트), Drizzle + PostgreSQL 17, Tailwind v4(`@theme inline` 토큰), Vitest(단위·통합), Playwright(e2e).

---

## 0. 읽고 시작할 것

| 무엇 | 어디 | 왜 |
|---|---|---|
| 시안 홈 | `docs/design/redesign-v5/home.html` | 인라인 style 값이 곧 치수·색이다. 브라우저로 열면 그대로 보인다 |
| 시안 상세 | `docs/design/redesign-v5/product.html` | 같음 (Madeira 기준) |
| 현재 홈 구성 | `app/page.tsx:234-444` (`HomeContent`) | 정렬·대체 목록·검색 스트리밍 로직은 그대로 둔다 |
| 현재 상세 구성 | `app/p/[slug]/page.tsx` | |
| 목록 조회 | `lib/domain/products/repository.ts:53-200` | `rising` 정렬·조건이 이미 있다 |
| 홈 집계 | `lib/domain/products/home-pulse.ts` | `tools`(제작 도구)·`active`·`born`이 이미 있다 |
| 토큰 규칙 | `app/globals.css` 머리말, `tests/ui-contract.test.ts` | 색은 이름으로만, 글자 13px 이상 |

시안 → 코드 치수 대응 (시안에서 쓴 값 그대로):

| 토큰 | 값 | 쓰는 곳 |
|---|---|---|
| 바탕 | `#ffffff` / 부드러운 바탕 `#f5f5f7` / 호버 `#f0f0f3` | 페이지 / 타일·카드 / 호버 |
| 선 | `#e8e8ed` (칸 안 `#e0e0e5`) | 헤어라인 |
| 글자 | `#1d1d1f` / 보조 `#6e6e73` | 본문 / 설명·메타 (흰 바탕 4.9:1, `#f5f5f7` 바탕 4.6:1) |
| 포인트 | `#d63a40` (연한 면 `rgba(214,58,64,.10)`) | 주 버튼·텍스트 링크·강조 단어·로고 점·급상승 배지 |
| 증가 | `#1e7b3c` | 스타 증가, 가동 상태 점 |
| 모서리 | 알약 `980px` / 카드 `18px` / 작은 카드 `16px` / 아이콘 `16px`(64) `12px`(44) `8px`(28) | |
| 글자 크기 | h1 26 · 구획 22 · 카드 이름 17 · 작은 카드 이름 15 · 본문 14~15 · 메타·캡션 13 · 보조 12 | 12px는 장식 캡션·보조 줄에만. UI 글자 최소 13px(`ui-contract` 테스트) |
| 서체 | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", "Pretendard", system-ui, "Helvetica Neue", sans-serif` | Inter 웹폰트 제거 |
| 타일 바탕 6색 | `#f2f2f7 #eef3fb #f5efe8 #edf5ef #f6eef3 #f0eff8` | `coverArtFor(slug)` 의 여섯 값에 대응 |

## 1. 파일 지도

**PR 1 — 데이터 (화면 변화 없음)**
- Modify `lib/domain/products/repository.ts` — `ListOptions`에 `listedSince`·`minStars`, `getRisingRank(slug)`
- Modify `lib/domain/products/view.ts` — `BrowseOptions`에 `offset`·`listedSince`·`minStars`, `getNewThisWeek`, `getRelatedRising`
- Modify `lib/domain/products/popular.ts` — `fields`에 `ogImage`, 홈 묶음은 구간당 3개
- Modify `lib/domain/products/home-pulse.ts` — `active` 행에 `ogImage`
- Create `lib/domain/products/readme-excerpt.ts` — README 본문에서 소개 발췌
- Modify `lib/domain/products/detail-view.ts` — `readmeExcerpt`·`risingRank`·`related`·`toolScan`
- Create `tests/readme-excerpt.test.ts`, `tests/integration/home-rows.test.ts`

**PR 2 — 토큰·껍데기·홈**
- Modify `app/globals.css`, `app/layout.tsx` (서체·토큰), `tests/ui-contract.test.ts`
- Delete `app/@topbar/page.tsx`, `app/@topbar/default.tsx`, `app/@topbar/[...catchAll]/page.tsx`, `components/home/PulseStrip.tsx`; Modify `tests/home-slots.test.ts`, `tests/home-pulse.test.ts`
- Modify `components/home/SiteHeader.tsx`, `components/home/MobileNav.tsx`, `components/home/SiteFooter.tsx`
- Create `components/home/IntroLine.tsx`, `components/home/CompactCard.tsx`, `components/home/CompactRow.tsx`, `components/home/ToolsBoard.tsx`, `components/home/ActiveList.tsx`, `components/home/NewsList.tsx`, `components/home/LaunchBand.tsx`, `components/home/ProjectTile.tsx`
- Modify `components/home/ProjectCard.tsx`, `components/home/PopularTiers.tsx`, `components/BrowseFilters.tsx`, `app/page.tsx`
- Delete `components/home/HomeHero.tsx`, `components/home/HomePulse.tsx`, `components/home/HomeAside.tsx`, `components/home/ProjectCover.tsx` (`coverArtFor`는 `ProjectTile.tsx`로 옮김), `components/home/AutoSubmitSelect.tsx`
- Rewrite `app/home.css`
- Modify `tests/home-project-card.test.tsx`, `tests/home-unclaimed.test.tsx`, `tests/e2e/home-redesign.spec.ts`

**PR 3 — 상세**
- Create `components/product-detail/FactsStrip.tsx`, `BuildTools.tsx`, `IntroSection.tsx`, `LanguageBar.tsx`, `InfoCard.tsx`, `EvidenceCard.tsx`, `PreviewFigure.tsx`, `RelatedRow.tsx`
- Modify `components/product-detail/ProductHero.tsx`, `UpdateTimeline.tsx`, `InstallPrompt.tsx`, `app/p/[slug]/page.tsx`
- Delete `components/product-detail/ProductMetrics.tsx`, `ProductFacts.tsx`, `RepositoryEvidence.tsx`, `FreshnessPanel.tsx`, `BuildProvenance.tsx`, `ProductIntroduction.tsx`, `EvidenceSummary.tsx`, `ProductGallery.tsx`
- Modify `tests/product-detail-components.test.tsx`, `tests/ui-contract.test.ts`, `tests/e2e/product-detail.spec.ts`

**PR 4 — 운영 확인**
- 배포(web-m3·web-mini), 제작 도구 흔적 표시 설정, 측정, 죽은 코드 정리

각 PR 끝에 `npm run lint && npx tsc --noEmit && npm test`; 통합 테스트는 `npm run test:integration`(로컬 테스트 DB 필요, `tests/integration/setup.ts` 참고). e2e는 PR 2·3에서만.

---

## PR 1 — 데이터 계층

### Task 1: 목록 조건에 `listedSince`·`minStars` 추가

**Files:**
- Modify: `lib/domain/products/repository.ts:55-76` (`ListOptions`), `:156-170` (`listConditions`)
- Modify: `lib/domain/products/view.ts:92-102` (`BrowseOptions`)
- Test: `tests/integration/home-rows.test.ts`

- [ ] **Step 1: 실패하는 통합 테스트**

```ts
// tests/integration/home-rows.test.ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { products, type ProductStatus } from "@/lib/db/schema";
import { getRisingRank } from "@/lib/domain/products/repository";
import { getNewThisWeek, getPublicList, getRelatedRising } from "@/lib/domain/products/view";
import { ensureSchema, resetTables } from "./setup";

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

/** 공개 제품 하나 — 스타는 "어제 → 오늘" 두 번 확인한 값으로 넣는다(starGain 이 계산되게) */
async function product(slug: string, options: {
  category?: string; status?: ProductStatus; createdAt?: Date; stars?: number; starsPrevious?: number;
} = {}) {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "t", description: "d",
    category: options.category ?? "Dev", status: options.status ?? "seeded", source: "crawler",
    verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    createdAt: options.createdAt ?? daysAgo(30),
    stars: options.stars ?? null, starsAt: options.stars === undefined ? null : daysAgo(0),
    starsPrevious: options.starsPrevious ?? null, starsPreviousAt: options.starsPrevious === undefined ? null : daysAgo(1),
  });
}

beforeAll(ensureSchema);
beforeEach(resetTables);

describe("이번 주 새로 공개된 프로젝트", () => {
  it("최근 7일에 등재됐고 스타가 기준 이상인 것만, 최신순", async () => {
    await product("old", { createdAt: daysAgo(10), stars: 500, starsPrevious: 500 });
    await product("new-small", { createdAt: daysAgo(2), stars: 10, starsPrevious: 10 });
    await product("new-a", { createdAt: daysAgo(3), stars: 120, starsPrevious: 120 });
    await product("new-b", { createdAt: daysAgo(1), stars: 80, starsPrevious: 80 });
    const rows = await getNewThisWeek(5, daysAgo(7));
    expect(rows.map((row) => row.slug)).toEqual(["new-b", "new-a"]);
  });
});

describe("급상승 순위", () => {
  it("스타 2천 미만에서 증가폭 순서의 자리를 준다", async () => {
    await product("first", { stars: 990, starsPrevious: 1 });
    await product("second", { stars: 1512, starsPrevious: 1273 });
    await product("third", { stars: 819, starsPrevious: 622 });
    await product("big", { stars: 40_000, starsPrevious: 30_000 });
    await product("flat", { stars: 100, starsPrevious: 100 });
    expect(await getRisingRank("second")).toBe(2);
    expect(await getRisingRank("third")).toBe(3);
    expect(await getRisingRank("big")).toBeNull();
    expect(await getRisingRank("flat")).toBeNull();
    expect(await getRisingRank("missing")).toBeNull();
  });
});

describe("같은 분야에서 뜨는", () => {
  it("자기 자신을 빼고 같은 분야의 급상승을 준다", async () => {
    await product("me", { category: "Games", stars: 1180, starsPrevious: 1014 });
    await product("g1", { category: "Games", stars: 317, starsPrevious: 297 });
    await product("g2", { category: "Games", stars: 405, starsPrevious: 391 });
    await product("dev", { category: "Dev", stars: 500, starsPrevious: 1 });
    const rows = await getRelatedRising("me", "Games", 5);
    expect(rows.map((row) => row.slug)).toEqual(["g1", "g2"]);
  });
});

describe("급상승 띠와 피드의 이어짐", () => {
  it("offset 으로 띠 다음부터 받는다", async () => {
    for (const [slug, gain] of [["a", 50], ["b", 40], ["c", 30], ["d", 20]] as const) {
      await product(slug, { stars: 100 + gain, starsPrevious: 100 });
    }
    const strip = await getPublicList(2, { sort: "rising", rising: true });
    const feed = await getPublicList(10, { sort: "rising", rising: true, offset: 2 });
    expect(strip.map((row) => row.slug)).toEqual(["a", "b"]);
    expect(feed.map((row) => row.slug)).toEqual(["c", "d"]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm run test:integration -- tests/integration/home-rows.test.ts`
Expected: FAIL — `getNewThisWeek`, `getRisingRank`, `getRelatedRising` is not exported.

- [ ] **Step 3: `ListOptions`·`listConditions`에 두 조건 추가**

`lib/domain/products/repository.ts` — `ListOptions`의 `rising?: boolean;` 아래에:

```ts
  /** 이 시각 이후에 등재된 것만(listedAt) — 홈 '이번 주 새로 나온' */
  listedSince?: Date;
  /** GitHub 스타가 이만큼 이상인 것만 */
  minStars?: number;
```

`listConditions` 시그니처와 본문:

```ts
function listConditions({ statuses, category, query, builder, hasRepository, excludeDown, introNeedsEditor: needsEditor, rising, listedSince, minStars }: Omit<ListOptions, "limit" | "sort" | "offset">) {
  const conditions = [inArray(products.status, statuses)];
  if (excludeDown) conditions.push(notDown);
  if (needsEditor) conditions.push(introNeedsEditor);
  if (rising) conditions.push(risingStars);
  if (listedSince) conditions.push(sql`${listedAt} >= ${listedSince.toISOString()}::timestamptz`);
  if (minStars !== undefined) conditions.push(sql`${products.stars} >= ${minStars}`);
  if (category) conditions.push(eq(products.category, category));
  if (builder) conditions.push(and(eq(products.builder, builder), builderIsReported)!);
  if (hasRepository) {
    conditions.push(isNotNull(products.repoUrl));
    conditions.push(sql`btrim(${products.repoUrl}) <> ''`);
  }
  if (hasSearchQuery(query)) conditions.push(productSearchPredicate(query!)!);
  return conditions;
}
```

`lib/domain/products/view.ts` — `BrowseOptions`:

```ts
export type BrowseOptions = {
  sort?: ProductSort;
  category?: Category;
  query?: SearchQuery;
  builder?: string;
  hasRepository?: boolean;
  /** 마지막 확인 사이에 스타가 는 제품만(repository.ts) */
  rising?: boolean;
  /** 앞을 건너뛴다 — 홈의 급상승 띠가 보여 준 만큼 피드가 이어 받을 때 */
  offset?: number;
  listedSince?: Date;
  minStars?: number;
};
```

`getPublicList`는 `...options`로 이미 전부 넘기므로 손대지 않는다.

- [ ] **Step 4: 홈·상세용 조회 셋**

`lib/domain/products/view.ts` 끝에:

```ts
/** 홈 '이번 주 새로 나온' — 등재 7일 안·스타 NEW_THIS_WEEK_MIN_STARS 이상, 최신순 */
export const NEW_THIS_WEEK_MIN_STARS = 50;
export async function getNewThisWeek(limit: number, since: Date): Promise<ProductListItem[]> {
  return getPublicList(limit, { sort: "recent", listedSince: since, minStars: NEW_THIS_WEEK_MIN_STARS });
}

/** 상세 끝의 '같은 분야에서 지금 뜨는' — 자기 자신은 뺀다 */
export async function getRelatedRising(slug: string, category: Category, limit: number): Promise<ProductListItem[]> {
  const rows = await getPublicList(limit + 1, { sort: "rising", rising: true, category });
  return rows.filter((row) => row.slug !== slug).slice(0, limit);
}
```

`lib/domain/products/repository.ts` 의 `countProducts` 아래에:

```ts
/**
 * 급상승 순위 — 홈 '지금 뜨는'과 같은 조건(risingStars)·같은 순서(starGain desc) 안에서 몇 번째인가.
 * 조건 밖(스타 2천 이상, 증가 없음, 비공개)이면 null. 동률은 같은 순위.
 */
export async function getRisingRank(slug: string): Promise<number | null> {
  const [row] = await db.execute<{ rank: number | null }>(sql`
    with me as (
      select ${starGain} as gain from ${products}
       where ${products.slug} = ${slug} and ${products.status} in ('verified', 'seeded') and ${risingStars})
    select case when me.gain is null then null
                else (select count(*)::int + 1 from ${products}
                       where ${products.status} in ('verified', 'seeded') and ${risingStars} and ${starGain} > me.gain) end as rank
      from me`);
  return row?.rank ?? null;
}
```

- [ ] **Step 5: 통과 확인**

Run: `npm run test:integration -- tests/integration/home-rows.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: 커밋**

```bash
git add lib/domain/products/repository.ts lib/domain/products/view.ts tests/integration/home-rows.test.ts
git commit -m "feat(products): rising rank, new-this-week and related-rising queries for the v5 home and detail"
```

### Task 2: 인기 구간·활발한 목록에 아이콘, 구간당 3개

**Files:**
- Modify: `lib/domain/products/popular.ts:10-13` (`fields`), `:31` (`getPopularGroups`)
- Modify: `lib/domain/products/home-pulse.ts:35` (`active` 타입), `:152-157` (쿼리), `:181-187` (매핑)
- Test: `tests/integration/home-pulse.test.ts` (기존), `tests/e2e/popular-projects.spec.ts` (기존)

- [ ] **Step 1: `popular.ts` 수정**

```ts
export type PopularProduct=StarObservation&{slug:string;name:string;tagline:string;category:string;repoUrl:string|null;ogImage:string|null;stars:number;ownerType:'User'|'Organization'|null;starsAt:string|null};
const fields={slug:products.slug,name:products.name,tagline:products.tagline,category:products.category,repoUrl:products.repoUrl,ogImage:products.ogImage,
 starsPrevious:products.starsPrevious,starsPreviousAt:sql<string|null>`${products.starsPreviousAt}::text`,
 stars:sql<number>`${products.stars}`,ownerType:products.ownerType,starsAt:sql<string|null>`${products.starsAt}::text`};
```

`getPopularGroups`의 `items(t.key,personal,5)` → `items(t.key,personal,3)`. (`/popular` 페이지는 `getPopularPage`를 쓰므로 영향 없음.)

- [ ] **Step 2: `home-pulse.ts` 의 `active`에 `ogImage`**

타입: `active: { slug: string; name: string; category: Category; releases: number; stars: number | null; ogImage: string | null }[];`

쿼리의 select 목록에 `p.og_image as og_image` 를 더하고 제네릭에 `og_image: string | null` 을 추가:

```ts
    db.execute<{ slug: string; name: string; category: Category; releases: number; stars: number | null; og_image: string | null }>(sql`
      select p.slug, p.name, p.category, p.og_image, u.releases, (d.repo_meta->>'stargazers_count')::int as stars
```

매핑에 `ogImage: row.og_image ?? null,` 한 줄.

- [ ] **Step 3: 기존 테스트가 깨지는지 확인**

Run: `npm test -- tests/home-pulse.test.ts tests/home-pulse-cache.test.ts && npm run test:integration -- tests/integration/home-pulse.test.ts`
Expected: 단위 테스트의 `samplePulse()` 는 `active` 항목 리터럴을 만든다 — 타입 에러가 나면 각 항목에 `ogImage: null` 을 넣는다. 통합 테스트 PASS.

- [ ] **Step 4: 커밋**

```bash
git add lib/domain/products/popular.ts lib/domain/products/home-pulse.ts tests/home-pulse.test.ts
git commit -m "feat(home): carry og images into popular tiers and the active list; three per tier"
```

### Task 3: README 발췌

**Files:**
- Create: `lib/domain/products/readme-excerpt.ts`
- Test: `tests/readme-excerpt.test.ts`

- [ ] **Step 1: 실패하는 테스트**

```ts
// tests/readme-excerpt.test.ts
import { describe, expect, it } from "vitest";
import { readmeExcerpt } from "@/lib/domain/products/readme-excerpt";

const tagline = "PostHog automatically diagnoses problems.";
const body = [
  "Docs - Community - Roadmap - Why PostHog? - Changelog - Bug reports",
  "",
  "PostHog is the open source platform for building self-driving products",
  "",
  "PostHog (https://posthog.com/) provides every tool you need to build a successful product, and captures all the context agents need to proactively diagnose problems, uncover opportunities, and ship fixes:",
  "",
  "- Self-driving mode (https://posthog.com/docs/self-driving): Turn signals in your product data into researched reports and pull requests you review and merge.",
  "- Product analytics (https://posthog.com/product-analytics): Autocapture or manually instrument event-based analytics to understand user behavior",
].join("\n");

describe("README 발췌", () => {
  it("링크 나열 줄은 건너뛰고 첫 문단부터 600자 안에서 문단 경계로 자른다", () => {
    const text = readmeExcerpt(body, tagline)!;
    expect(text.startsWith("PostHog is the open source platform")).toBe(true);
    expect(text).toContain("Self-driving mode");
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toContain("Docs - Community");
  });
  it("괄호 안의 주소는 지운다", () => {
    expect(readmeExcerpt(body, tagline)).not.toContain("https://posthog.com/docs");
  });
  it("소개와 같거나 80자 미만이면 없다", () => {
    expect(readmeExcerpt(tagline, tagline)).toBeNull();
    expect(readmeExcerpt("Short.", tagline)).toBeNull();
    expect(readmeExcerpt(null, tagline)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- tests/readme-excerpt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: 구현**

```ts
// lib/domain/products/readme-excerpt.ts
/**
 * 상세 '소개'를 채우는 README 발췌.
 *
 * 공개 제품의 43%는 설명이 한 줄 소개와 같고 메이커 프로필은 없다(2026-10-02 실측). 검색용으로 저장한
 * README 본문(products.search_readme)은 88%에 있으므로 그 첫 문단들을 소개 자리에 쓴다.
 * 자르는 규칙: 뱃지·링크 나열 줄(문장이 아닌 짧은 줄)은 건너뛰고, 문단 단위로 600자까지, 괄호 안 주소는 지운다.
 */
const MAX = 600;
const MIN = 80;

export function readmeExcerpt(readme: string | null | undefined, tagline: string): string | null {
  if (!readme) return null;
  const paragraphs = readme
    .replace(/\s*\((?:https?:\/\/)[^)\s]+\)/g, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0 && !isNavigation(paragraph));
  const picked: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    if (length + paragraph.length + (picked.length ? 2 : 0) > MAX) break;
    picked.push(paragraph);
    length += paragraph.length + 2;
  }
  const text = picked.join("\n\n").trim();
  if (text.length < MIN || text === tagline.trim()) return null;
  return text;
}

/** "Docs - Community - Roadmap" 같은 메뉴 줄 — 구분 기호가 많고 마침표가 없다 */
function isNavigation(paragraph: string): boolean {
  const separators = (paragraph.match(/\s[-|·•]\s/g) ?? []).length;
  return separators >= 2 && !/[.!?]\s|[.!?]$/.test(paragraph) && paragraph.length < 160;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- tests/readme-excerpt.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: 커밋**

```bash
git add lib/domain/products/readme-excerpt.ts tests/readme-excerpt.test.ts
git commit -m "feat(products): readme excerpt for the detail introduction"
```

### Task 4: 상세 뷰모델에 네 가지 추가

**Files:**
- Modify: `lib/domain/products/detail-view.ts:168-189` (타입), `:619-696` (`getProductDetail`)
- Test: `tests/integration/home-rows.test.ts` (추가 케이스)

- [ ] **Step 1: 실패하는 통합 테스트 추가** — `tests/integration/home-rows.test.ts` 끝에:

```ts
import { getProductDetail } from "@/lib/domain/products/detail-view";

describe("상세 뷰모델", () => {
  it("급상승 순위·같은 분야 추천·README 발췌·도구 조사 상태를 준다", async () => {
    await product("me", { category: "Games", stars: 1180, starsPrevious: 1014 });
    await product("g1", { category: "Games", stars: 317, starsPrevious: 297 });
    await db.update(products).set({
      repoUrl: "https://github.com/willfaust/Madeira",
      searchReadme: "Madeira runs Windows games on iOS.\n\nIt combines FEX-Emu, Wine and DXMT into one app so that x86-64 titles start on a jailed device without a computer.",
    }).where(eq(products.slug, "me"));
    const detail = (await getProductDetail("me"))!;
    expect(detail.risingRank).toBe(1);
    expect(detail.related.map((row) => row.slug)).toEqual(["g1"]);
    expect(detail.readmeExcerpt).toContain("FEX-Emu");
    expect(detail.toolScan).toBe("none");
  });
});
```

파일 머리에 `import { eq } from "drizzle-orm";` 추가.

- [ ] **Step 2: 실패 확인**

Run: `npm run test:integration -- tests/integration/home-rows.test.ts`
Expected: FAIL — `risingRank` is undefined.

- [ ] **Step 3: 타입과 조립**

`ProductDetailView` 에 네 필드:

```ts
  freshness: FreshnessView[];
  /** 홈 '지금 뜨는'과 같은 순위 — 조건 밖이면 null (repository.ts getRisingRank) */
  risingRank: number | null;
  /** 같은 분야에서 지금 뜨는, 자기 자신 제외, 최대 5 */
  related: ProductListItem[];
  /** README 첫 문단들 — 소개가 한 줄뿐일 때 상세 본문이 된다 */
  readmeExcerpt: string | null;
  /** 저장소의 AI 도구 흔적 조사 — 없으면 '확인 전'이라고 말해야 한다 */
  toolScan: "none" | "scanned";
```

import 에 `ProductListItem`·`getRelatedRising`(`./view`), `getRisingRank`(`./repository`), `readmeExcerpt`(`./readme-excerpt`), `normalizeAgentRepositoryKey`(이미 쓰는 `@/lib/domain/evidence/agents/repository` 의 `getLatestRepositoryAgentScan` 과 같은 모듈) 를 더한다.

`getProductDetail` 의 `Promise.all` 에 네 조회를 덧붙인다 (기존 열 개 뒤):

```ts
  const [rank, visitMap, health, profile, links, sources, media, updates, provenance, settings,
    risingRank, related, readmeRow, toolScanRow] = await Promise.all([
    activeRank(slug),
    visitMetrics([slug], { windowHours: METRICS_WINDOW_DAYS * 24, minimumPreviousUniqueVisitors: 5 }),
    detailHealth(slug),
    db.query.productProfiles.findFirst({ where: eq(productProfiles.slug, slug) }),
    visibleLinks(slug),
    evidenceSources(slug),
    visibleMedia(slug),
    visibleUpdates(slug),
    visibleProvenance(slug),
    currentEvidenceSettings(),
    getRisingRank(slug),
    getRelatedRising(slug, product.category as Category, 5),
    db.select({ readme: products.searchReadme }).from(products).where(eq(products.slug, slug)).then((rows) => rows[0] ?? null),
    product.repoUrl ? getLatestRepositoryAgentScan(repositoryKeyOf(product.repoUrl)) : Promise.resolve(null),
  ]);
```

파일 안에 작은 헬퍼:

```ts
/** github.com/owner/repo → owner/repo (끝의 .git·슬래시 제거). 다른 호스트면 빈 문자열 → 조사 없음 */
function repositoryKeyOf(url: string): string {
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(url);
  return match ? `${match[1]}/${match[2].replace(/\.git$/, "")}` : "";
}
```

반환 객체 끝에:

```ts
    freshness: sources.map((source) => sourceFreshness(source, settings, now)),
    risingRank,
    related,
    readmeExcerpt: readmeExcerpt(readmeRow?.readme ?? null, currentProduct.tagline),
    toolScan: toolScanRow ? "scanned" : "none",
```

`Category` 타입이 이 파일에 없으면 `import type { Category } from "./schema";`.

- [ ] **Step 4: 통과 확인**

Run: `npm run test:integration -- tests/integration/home-rows.test.ts && npx tsc --noEmit`
Expected: PASS. `tests/product-detail-components.test.tsx` 가 `ProductDetailView` 리터럴을 만든다면 타입 에러가 난다 — 그 픽스처에 `risingRank: null, related: [], readmeExcerpt: null, toolScan: "none"` 을 넣는다(PR 3에서 다시 손본다).

- [ ] **Step 5: 커밋**

```bash
git add lib/domain/products/detail-view.ts tests/integration/home-rows.test.ts tests/product-detail-components.test.tsx
git commit -m "feat(products): rising rank, related rising, readme excerpt and tool-scan state in the detail view"
```

PR 1 을 연다: 제목 `feat(products): data for the v5 home and detail`. 화면은 바뀌지 않는다.

---

## PR 2 — 토큰·껍데기·홈

### Task 5: 토큰과 서체

**Files:**
- Modify: `app/globals.css:11-28` (`:root`), `:31-48` (dark), `:76-86` (`@theme`)
- Modify: `app/layout.tsx:3-11`, `:56`
- Modify: `tests/ui-contract.test.ts:46-56`

- [ ] **Step 1: 테스트의 기대값을 새 토큰으로**

`tests/ui-contract.test.ts` 의 `"uses light tokens unconditionally…"` 안:

```ts
    expect(root).toContain("--bg: #ffffff");
    expect(root).toContain("--bg-card: #ffffff");
    expect(root).toContain("--accent: #d63a40");
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- tests/ui-contract.test.ts`
Expected: FAIL on `--bg: #ffffff`.

- [ ] **Step 3: 토큰 교체** — `app/globals.css` `:root`:

```css
:root {
  color-scheme: light;

  --bg: #ffffff;
  --bg-soft: #f5f5f7;
  --bg-card: #ffffff;
  --bg-hover: #f0f0f3;
  --border: #e8e8ed;
  --text: #1d1d1f;
  --text-2: #6e6e73;
  --text-3: #6e6e73;
  --up: #1e7b3c;
  --down: #c62430;
  --warn: #a2650f;
  --accent: #d63a40;
  --accent-solid: #d63a40;
  --accent-soft: rgba(214, 58, 64, 0.1);
  --star: #1d1d1f;
}
```

다크 블록은 `--accent: #ff6b70; --accent-solid: #d63a40; --accent-soft: rgba(255, 107, 112, 0.16);` 세 줄만 바꾼다(그 외 그대로). `@theme inline` 의 두 줄:

```css
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Apple SD Gothic Neo", "Pretendard", system-ui, "Helvetica Neue", sans-serif;
  --font-mono: "SF Mono", ui-monospace, Menlo, monospace;
```

`body` 블록에 `text-rendering: optimizeLegibility;` 한 줄 추가.

- [ ] **Step 4: 웹폰트 제거** — `app/layout.tsx`:

삭제: `import { Inter, JetBrains_Mono } from "next/font/google";` 와 `const inter = …`, `const jetbrains = …` 두 줄.
`<body className="flex min-h-screen flex-col font-sans">` 로.

- [ ] **Step 5: 확인**

Run: `npm test -- tests/ui-contract.test.ts && npx tsc --noEmit`
Expected: PASS. "keeps 13px muted text AA-readable" 케이스가 `--text-3`(#6e6e73) 를 각 바탕에 재는데 흰 바탕 4.9:1, `#f5f5f7` 4.6:1 로 통과한다.

- [ ] **Step 6: 커밋**

```bash
git add app/globals.css app/layout.tsx tests/ui-contract.test.ts
git commit -m "feat(ui): neutral palette with a single coral accent and the system font stack"
```

### Task 6: 상단 띠 슬롯 제거, 헤더·푸터·모바일 탭

**Files:**
- Delete: `app/@topbar/page.tsx`, `app/@topbar/default.tsx`, `app/@topbar/[...catchAll]/page.tsx`, `components/home/PulseStrip.tsx`
- Modify: `app/layout.tsx:44-66`, `tests/home-slots.test.ts:4-16`, `tests/home-pulse.test.ts` (PulseStrip 케이스 삭제)
- Modify: `components/home/SiteHeader.tsx:54-94`, `components/home/MobileNav.tsx`, `components/home/SiteFooter.tsx`

- [ ] **Step 1: 슬롯 테스트에서 topbar 제거**

`tests/home-slots.test.ts`: `NoTopbarCatchAll`·`NoTopbarDefault` import 두 줄 삭제, `const SLOTS = ["@seasonfooter"] as const;`, 그 두 컴포넌트를 쓰는 expect 줄 삭제.
`tests/home-pulse.test.ts`: `PulseStrip` import 와 `describe("메뉴 위 한 줄"…)`(또는 PulseStrip 을 렌더하는 it) 블록 삭제.

- [ ] **Step 2: 슬롯 파일 삭제, 레이아웃에서 떼기**

```bash
git rm -r app/@topbar components/home/PulseStrip.tsx
```

`app/layout.tsx` 의 `RootLayout` 매개변수에서 `topbar` 제거, `{topbar}` 줄 삭제. 주석의 "topbar·seasonfooter는" 을 "seasonfooter는" 으로.

- [ ] **Step 3: 헤더** — `components/home/SiteHeader.tsx` 의 반환부:

```tsx
  return (
    <header className="nmb-header">
      <div className="wrap header-row">
        <Link className="brand" href="/" aria-label="nomorevibe 홈">
          <i className="brand-dot" aria-hidden="true" />
          nomorevibe
        </Link>
        <nav className="navigation" aria-label="주 메뉴">
          <Link href="/#rising" className={home ? "active" : undefined}>급상승</Link>
          <Link href="/#projects">발견하기</Link>
          <Link href="/#popular">인기</Link>
          <Link href="/#new">새로 나온</Link>
        </nav>
        <form className="header-search" action="/" method="get" role="search">
          <Icon name="search" />
          <input
            ref={input}
            id="search"
            type="search"
            name="q"
            placeholder="프로젝트, 도구, 아이디어 검색"
            aria-label="프로젝트 검색"
            autoComplete="off"
            maxLength={200}
            defaultValue={home ? params.get("q") ?? "" : ""}
            key={home ? params.get("q") ?? "" : "away"}
          />
          <kbd className="key">⌘K</kbd>
        </form>
        <button type="button" className="saved-nav" onClick={openSaved} aria-label="저장한 프로젝트">
          <Icon name="bookmark" />
          <i className={`saved-dot${hasSaved ? " on" : ""}`} />
        </button>
        <Link className="primary" href="/launch">프로젝트 공개</Link>
      </div>
    </header>
  );
```

(⌘K 포커스·저장 점·hydration 처리는 그대로.)

- [ ] **Step 4: 모바일 탭** — `components/home/MobileNav.tsx` 의 둘째 항목을 `<Link href="/#popular"><Icon name="grid" />인기</Link>` 로 바꾸고 레이블 "발견"은 그대로. (`AI 소식` 링크 제거 — 소식은 홈 맨 아래 13px 목록이라 탭을 줄 가치가 없다.)

- [ ] **Step 5: 푸터** — `components/home/SiteFooter.tsx` 의 오른쪽 항목을 `데이터와 집계 기준 · 프로젝트 공개 · 게재 기준(/launch#policy)` 로. `<span>AI로 만든 제품의 마켓 데이터베이스</span>` 삭제.

- [ ] **Step 6: 확인**

Run: `npm test -- tests/home-slots.test.ts tests/home-pulse.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: 커밋**

```bash
git add -A app/@topbar app/layout.tsx components/home/PulseStrip.tsx components/home/SiteHeader.tsx components/home/MobileNav.tsx components/home/SiteFooter.tsx tests/home-slots.test.ts tests/home-pulse.test.ts
git commit -m "feat(home): drop the pulse strip slot; header carries the search and the four home sections"
```

### Task 7: 아이콘 타일과 카드

**Files:**
- Create: `components/home/ProjectTile.tsx`
- Modify: `components/home/ProjectCard.tsx`
- Delete: `components/home/ProjectCover.tsx`
- Test: `tests/home-project-card.test.tsx`

- [ ] **Step 1: 카드 테스트를 새 모양으로** — 기존 세 케이스를 유지하고 두 개 추가:

```ts
  it("renders an icon tile instead of a cover and no internal status badge", () => {
    const html = render(baseProduct);
    expect(html).toContain('class="project-tile tile-');
    expect(html).not.toContain("미클레임");
    expect(html).not.toContain("tiny-tag");
  });

  it("marks installable projects on the tile", () => {
    expect(render({ ...baseProduct, accessMode: "installable" })).toContain("직접 설치");
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- tests/home-project-card.test.tsx`
Expected: FAIL — `project-tile` 없음.

- [ ] **Step 3: 타일 컴포넌트**

```tsx
// components/home/ProjectTile.tsx
import { ProductIcon } from "@/components/ProductIcon";

/**
 * 카드 커버 — 옅은 바탕 타일 위 아이콘 하나.
 *
 * 공개 제품의 54%는 256px 사이트 아이콘·GitHub 아바타뿐이고 메이커 스크린샷은 0이다(2026-10-02).
 * 이미지 종류가 달라도 카드 모양이 같아야 하므로 어떤 이미지든 작은 아이콘으로 줄여 쓴다.
 * 바탕색은 slug 로 정해 같은 제품은 늘 같은 색이다.
 */
const TINTS = ["paper", "day", "invoice", "form", "hue", "note"] as const;
export type TileTint = (typeof TINTS)[number];

export function tileTintFor(slug: string): TileTint {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash + slug.charCodeAt(index) * (index + 1)) % TINTS.length;
  }
  return TINTS[hash];
}

export function ProjectTile({ slug, name, ogImage, size, installable = false }: {
  slug: string;
  name: string;
  ogImage: string | null;
  /** 아이콘 한 변 — 큰 카드 64, 작은 카드 44 */
  size: 64 | 44;
  installable?: boolean;
}) {
  return (
    <span className={`project-tile tile-${tileTintFor(slug)} tile-${size}`}>
      <span className="tile-icon"><ProductIcon name={name} ogImage={ogImage?.startsWith("/") ? ogImage : null} size={size} /></span>
      {installable && <span className="tile-flag">직접 설치</span>}
    </span>
  );
}
```

- [ ] **Step 4: 카드 교체** — `components/home/ProjectCard.tsx` 전체:

```tsx
import { StarMetric } from "@/components/StarMetric";
import Link from "next/link";
import type { BrowseState } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { ProjectTile } from "@/components/home/ProjectTile";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { HomeCardProduct } from "@/components/home/types";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";

/**
 * 홈 카드 — 타일 · 이름 · 한 줄 · "분야 · @소유자" / ★ 증가.
 *
 * 미클레임·저장소·관심 수는 방문자에게 뜻이 없어 뺐다(상세에서 밝힌다). 메이커가 신고한 제작 도구만
 * 메타 줄 끝에 붙는다 — 수집기 추정값은 공개 뷰모델에서 이미 null 이다(view.ts toListItem).
 */
export function ProjectCard({ product, saved, onToggleSave }: {
  product: HomeCardProduct;
  saved: boolean;
  onToggleSave: (slug: string) => void;
  browseState: BrowseState;
}) {
  const owner = githubOwnerFromRepositoryUrl(product.repoUrl);
  const maker = owner ? `@${owner.login}` : product.makerName ? `@${product.makerName.replace(/^@/, "")}` : null;

  return (
    <article className="project-card">
      <Link href={`/p/${product.slug}`} className="card-visual" aria-label={`${product.name} 상세 보기`}>
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={64} installable={product.accessMode === "installable"} />
      </Link>
      <div className="project-body">
        <div className="project-title-row">
          <h3 className="project-title"><Link href={`/p/${product.slug}`}>{product.name}</Link></h3>
          <button
            type="button"
            className={`cover-saved${saved ? " active" : ""}`}
            aria-label={`${product.name} ${saved ? "저장 취소" : "저장"}`}
            aria-pressed={saved}
            onClick={() => onToggleSave(product.slug)}
          >
            <Icon name="bookmark" size={16} />
          </button>
        </div>
        <p className="project-tagline" title={product.tagline}>{product.tagline}</p>
        <div className="project-bottom">
          <span className="project-meta">
            {categoryLabel(product.category)}
            {maker && (owner ? <> · <a href={owner.profileUrl} target="_blank" rel="noopener noreferrer" title="GitHub 저장소 소유자">{maker}</a></> : <> · {maker}</>)}
            {product.builder && product.builderClaim === "reported" && <> · {product.builder}</>}
            {product.health?.down && <> · <span className="meta-down">응답 없음</span></>}
          </span>
          <StarMetric value={product} />
        </div>
      </div>
    </article>
  );
}
```

`components/home/ProjectCover.tsx` 삭제 (`git rm`). `coverArtFor` 를 쓰던 곳은 `app/p/[slug]` 의 `ProductHero`(PR 3에서 교체) 뿐이다 — PR 2 안에서는 `ProductHero.tsx` 의 import 를 `import { ProjectTile } from "@/components/home/ProjectTile";` 로 바꾸고 `<ProjectCover …/>` 자리를 `<ProjectTile slug={product.slug} name={product.name} ogImage={safeIcon} size={64} />` 로 둔다(PR 3이 지운다).

- [ ] **Step 5: 확인**

Run: `npm test -- tests/home-project-card.test.tsx && npx tsc --noEmit`
Expected: PASS (5 tests). "links an unclaimed project's creator label…" 는 `@AgentWorkforce`·`GitHub 저장소 소유자`·`href` 가 그대로 있어 통과한다.

- [ ] **Step 6: 커밋**

```bash
git add components/home/ProjectTile.tsx components/home/ProjectCard.tsx components/home/ProjectCover.tsx components/product-detail/ProductHero.tsx tests/home-project-card.test.tsx
git commit -m "feat(home): icon-tile project cards without internal status badges"
```

### Task 8: 작은 카드와 가로 띠

**Files:**
- Create: `components/home/CompactCard.tsx`, `components/home/CompactRow.tsx`
- Test: `tests/home-compact-row.test.tsx`

- [ ] **Step 1: 테스트**

```tsx
// tests/home-compact-row.test.tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompactRow } from "@/components/home/CompactRow";
import type { ProductListItem } from "@/lib/domain/products/view";

const item = (slug: string, extra: Partial<ProductListItem> = {}): ProductListItem => ({
  slug, name: slug, tagline: `${slug} does things`, taglineSource: "maker", category: "Games",
  builder: null, builderClaim: "guessed", stack: [], ogImage: null, makerName: null,
  repoUrl: `https://github.com/acme/${slug}`, listedAt: new Date("2026-10-02T00:00:00Z"), status: "seeded",
  unclaimed: true, stars: 990, starsAt: new Date("2026-10-02T00:00:00Z"), starsPrevious: 1,
  starsPreviousAt: new Date("2026-10-01T00:00:00Z"), ...extra,
});

describe("가로 띠", () => {
  it("제목·설명·보기 링크와 작은 카드를 그린다", () => {
    const html = renderToStaticMarkup(createElement(CompactRow, {
      id: "rising", title: "지금 뜨는 프로젝트", note: "마지막 확인 사이 스타가 가장 많이 늘었습니다",
      more: { href: "/?sort=weekly", label: "1,574개 모두 보기" }, items: [item("a"), item("b")], trailing: "category",
    }));
    expect(html).toContain('id="rising"');
    expect(html).toContain("지금 뜨는 프로젝트");
    expect(html).toContain("1,574개 모두 보기");
    expect(html).toContain("★ 990");
    expect(html).toContain("+989");
    expect(html).toContain("게임");
  });
  it("아무것도 없으면 구획 자체를 내지 않는다", () => {
    expect(renderToStaticMarkup(createElement(CompactRow, { id: "new", title: "x", items: [], trailing: "listed" }))).toBe("");
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- tests/home-compact-row.test.tsx` → FAIL (module not found).

- [ ] **Step 3: 구현**

```tsx
// components/home/CompactCard.tsx
import Link from "next/link";
import { StarMetric } from "@/components/StarMetric";
import { ProjectTile } from "@/components/home/ProjectTile";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { ProductListItem } from "@/lib/domain/products/view";

/** 등재일을 "10.02" 로 — 가로 띠의 '새로 나온' 카드가 쓴다 */
function listedLabel(at: Date): string {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" })
    .format(at).replace(/\. ?/g, ".").replace(/\.$/, "");
}

/** 가로 띠용 작은 카드 — 타일 84px · 이름 한 줄 · 소개 한 줄 · ★과 꼬리말 */
export function CompactCard({ product, trailing }: { product: ProductListItem; trailing: "category" | "listed" }) {
  return (
    <article className="compact-card">
      <Link href={`/p/${product.slug}`} className="compact-visual" aria-label={`${product.name} 상세 보기`}>
        <ProjectTile slug={product.slug} name={product.name} ogImage={product.ogImage} size={44} installable={product.accessMode === "installable"} />
      </Link>
      <div className="compact-body">
        <h3 className="compact-title"><Link href={`/p/${product.slug}`}>{product.name}</Link></h3>
        <p className="compact-tagline" title={product.tagline}>{product.tagline}</p>
        <p className="compact-meta">
          <StarMetric value={product} />
          <span> · {trailing === "category" ? categoryLabel(product.category) : `${categoryLabel(product.category)} · ${listedLabel(product.listedAt)}`}</span>
        </p>
      </div>
    </article>
  );
}
```

```tsx
// components/home/CompactRow.tsx
import Link from "next/link";
import { CompactCard } from "@/components/home/CompactCard";
import type { ProductListItem } from "@/lib/domain/products/view";

/** 홈의 가로 띠 — '지금 뜨는'·'이번 주 새로 나온'·상세의 '같은 분야에서 지금 뜨는' 이 같은 모양을 쓴다 */
export function CompactRow({ id, title, note, more, items, trailing }: {
  id: string;
  title: string;
  note?: string;
  more?: { href: string; label: string };
  items: ProductListItem[];
  trailing: "category" | "listed";
}) {
  if (items.length === 0) return null;
  return (
    <section id={id} className="row-section" aria-labelledby={`${id}-title`}>
      <div className="row-head">
        <div>
          <h2 id={id}-title className="row-title">{title}</h2>
          {note && <p className="row-note">{note}</p>}
        </div>
        {more && <Link className="row-more" href={more.href}>{more.label} ›</Link>}
      </div>
      <div className="compact-grid">
        {items.map((product) => <CompactCard key={product.slug} product={product} trailing={trailing} />)}
      </div>
    </section>
  );
}
```

(`id={id}-title` 은 오타 방지를 위해 `id={`${id}-title`}` 로 쓴다.)

- [ ] **Step 4: 확인** — `npm test -- tests/home-compact-row.test.tsx` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add components/home/CompactCard.tsx components/home/CompactRow.tsx tests/home-compact-row.test.tsx
git commit -m "feat(home): compact cards and the horizontal row used by rising, new-this-week and related"
```

### Task 9: 나머지 홈 구획 컴포넌트

**Files:**
- Create: `components/home/IntroLine.tsx`, `components/home/ToolsBoard.tsx`, `components/home/ActiveList.tsx`, `components/home/NewsList.tsx`, `components/home/LaunchBand.tsx`
- Modify: `components/home/PopularTiers.tsx`, `components/BrowseFilters.tsx`
- Delete: `components/home/HomeHero.tsx`, `components/home/HomePulse.tsx`, `components/home/HomeAside.tsx`, `components/home/AutoSubmitSelect.tsx`
- Test: `tests/home-sections.test.tsx`

- [ ] **Step 1: 테스트**

```tsx
// tests/home-sections.test.tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveList } from "@/components/home/ActiveList";
import { IntroLine } from "@/components/home/IntroLine";
import { ToolsBoard } from "@/components/home/ToolsBoard";
import { emptyHomePulse } from "@/lib/domain/products/home-pulse";

const now = new Date("2026-10-02T03:00:00+09:00");

describe("홈 소개 줄", () => {
  it("타이틀 한 줄과 세 숫자를 낸다", () => {
    const pulse = { ...emptyHomePulse(now), total: 25183, born: { current: 157, previous: 100, change: 57 }, updates: { projects: 3483, releases: 17553 } };
    const html = renderToStaticMarkup(createElement(IntroLine, { pulse, state: { sort: "weekly" } }));
    expect(html).toContain("AI로 만든 것들이");
    expect(html).toContain("25,183");
    expect(html).toContain("157");
    expect(html).toContain("3,483");
    expect(html).toContain("10.02 00:00 KST");
  });
});

describe("무엇으로 만들었나", () => {
  it("도구 집계가 없으면 구획을 내지 않는다", () => {
    expect(renderToStaticMarkup(createElement(ToolsBoard, { tools: null, state: { sort: "weekly" } }))).toBe("");
  });
  it("도구 알약과 조사 범위를 낸다", () => {
    const html = renderToStaticMarkup(createElement(ToolsBoard, {
      tools: { scanned: 20864, withTool: 16650, rows: [{ label: "Claude Code", count: 11798 }, { label: "Codex", count: 788 }] }, state: { sort: "weekly" },
    }));
    expect(html).toContain("Claude Code");
    expect(html).toContain("11,798");
    expect(html).toContain("20,864개 중 16,650개");
  });
});

describe("이번 주 가장 활발한", () => {
  it("다섯 줄까지만, 새 버전 수와 함께", () => {
    const active = Array.from({ length: 7 }, (_, index) => ({ slug: `p${index}`, name: `P${index}`, category: "Dev", releases: 70 - index, stars: null, ogImage: null }));
    const html = renderToStaticMarkup(createElement(ActiveList, { active, projects: 3483 }));
    expect(html).toContain("70건");
    expect(html).toContain("P4");
    expect(html).not.toContain("P5");
    expect(html).toContain("3,483개 중 상위 5");
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- tests/home-sections.test.tsx` → FAIL.

- [ ] **Step 3: 구현**

```tsx
// components/home/IntroLine.tsx
import Link from "next/link";
import { metricHref, type BrowseState } from "@/components/home/browse-state";
import { formatAsOfKst, type HomePulse } from "@/lib/domain/products/home-pulse";

const num = (value: number) => value.toLocaleString("ko-KR");

/** 히어로 대신 한 줄 — 타이틀과 이번 주 숫자. 숫자를 누르면 집계 기준이 열린다 */
export function IntroLine({ pulse, state }: { pulse: HomePulse; state: BrowseState }) {
  return (
    <section className="intro-line" aria-label="소개">
      <h1 className="intro-title">AI로 만든 것들이 <em>제품</em>이 되는 곳.</h1>
      <p className="intro-stats">
        공개 <b>{num(pulse.total)}</b>
        {" · "}<Link href={metricHref(state, "born")}>이번 주 태어난 <b>{num(pulse.born.current)}</b></Link>
        {" · "}<Link href={metricHref(state, "updates")}>새 버전 낸 프로젝트 <b>{num(pulse.updates.projects)}</b></Link>
        {" · "}{formatAsOfKst(pulse.asOf).replace(" 기준", "")}
      </p>
    </section>
  );
}
```

```tsx
// components/home/ToolsBoard.tsx
import Link from "next/link";
import { metricHref, type BrowseState } from "@/components/home/browse-state";
import type { HomePulse } from "@/lib/domain/products/home-pulse";

const num = (value: number) => value.toLocaleString("ko-KR");

/**
 * 무엇으로 만들었나 — 공개 프로젝트 저장소에서 찾은 AI 코딩 도구 흔적.
 *
 * 알약은 지금 걸러 보기로 이어지지 않는다 — `?builder=` 는 메이커가 신고한 값(3%)만 거르고 흔적은 다른 표다.
 * 흔적으로 거르는 조회가 생기기 전까지 집계 기준 창을 연다.
 */
export function ToolsBoard({ tools, state }: { tools: HomePulse["tools"]; state: BrowseState }) {
  if (!tools || tools.rows.length === 0) return null;
  return (
    <section className="tools-board" aria-labelledby="tools-title">
      <div className="row-head">
        <div>
          <h2 id="tools-title" className="row-title">무엇으로 만들었나</h2>
          <p className="row-note">공개 프로젝트의 저장소에서 찾은 AI 코딩 도구 흔적 · 확인한 {num(tools.scanned)}개 중 {num(tools.withTool)}개 · 한 저장소에 여러 도구</p>
        </div>
      </div>
      <ul className="chips">
        {tools.rows.slice(0, 8).map((tool, index) => (
          <li key={tool.label}>
            <Link href={metricHref(state, "tools")} className={`chip${index === 0 ? " chip-dark" : ""}`}>
              {tool.label} <span className="chip-count">{num(tool.count)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="row-foot">흔적은 설정 파일·커밋 서명에서 자동으로 찾습니다. 메이커가 신고한 값은 상세에서 따로 표시합니다.</p>
    </section>
  );
}
```

```tsx
// components/home/ActiveList.tsx
import Link from "next/link";
import { ProductIcon } from "@/components/ProductIcon";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { HomePulse } from "@/lib/domain/products/home-pulse";

const num = (value: number) => value.toLocaleString("ko-KR");

/** 이번 주 가장 활발한 — 새 버전 수 상위 5, 막대 없이 번호·아이콘·이름·숫자만 */
export function ActiveList({ active, projects }: { active: HomePulse["active"]; projects: number }) {
  const rows = active.slice(0, 5);
  return (
    <section className="active-list" aria-labelledby="active-title">
      <div className="row-head">
        <h2 id="active-title" className="row-title">이번 주 가장 활발한</h2>
        <span className="row-note">새 버전 수 · 7일</span>
      </div>
      {rows.length === 0 ? (
        <p className="row-foot">최근 7일에 새 버전을 낸 프로젝트가 없습니다.</p>
      ) : (
        <ol className="rank-list">
          {rows.map((item, index) => (
            <li key={item.slug} className="rank-row">
              <span className="rank-no">{index + 1}</span>
              <ProductIcon name={item.name} ogImage={item.ogImage} size={28} />
              <span className="rank-name">
                <Link href={`/p/${item.slug}`}>{item.name}</Link>
                <small>{categoryLabel(item.category)}{item.stars !== null && item.stars >= 100 ? ` · ★ ${num(item.stars)}` : ""}</small>
              </span>
              <b className="rank-value">{item.releases}건</b>
            </li>
          ))}
        </ol>
      )}
      <p className="row-foot">새 버전을 낸 {num(projects)}개 중 상위 5 · 새 버전 = GitHub 릴리스·제작자 업데이트</p>
    </section>
  );
}
```

```tsx
// components/home/NewsList.tsx
import type { HomeNewsItem } from "@/lib/news/repository";

function postedOn(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit" }).format(at).replace("-", ".");
}

/** 빌더를 위한 AI 소식 — 흥미가 낮아 맨 아래 13px 세 줄 */
export function NewsList({ news }: { news: HomeNewsItem[] }) {
  if (news.length === 0) return null;
  return (
    <section id="news" className="news-band" aria-labelledby="news-title">
      <div className="wrap">
        <div className="row-head">
          <h2 id="news-title" className="row-title row-title-sm">빌더를 위한 AI 소식</h2>
          <span className="row-note">회사 공식 피드 · 회사마다 최신 1건</span>
        </div>
        <ul className="news-list">
          {news.map((item) => (
            <li key={item.url}>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="news-row">
                <span className="news-source">{item.source}</span>
                <span className="news-title">{item.title}</span>
                <span className="news-date">{postedOn(item.publishedAt)} ↗</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
```

```tsx
// components/home/LaunchBand.tsx
import Link from "next/link";

/** 등록 안내 — 한 줄 가로형. 명령 한 줄과 버튼 하나 */
export function LaunchBand() {
  return (
    <section className="launch-band" aria-labelledby="launch-title">
      <div>
        <h2 id="launch-title" className="launch-title">만들었다면, 이제 <em>보여줄</em> 차례.</h2>
        <p className="launch-note">긴 등록 폼 대신 프로젝트 폴더에서 한 줄. AI 기능이 없어도, AI로 만들었다면 괜찮습니다.</p>
      </div>
      <div className="launch-actions">
        <code className="launch-command">/nomorevibe launch</code>
        <Link className="primary" href="/launch">등록 흐름 보기</Link>
      </div>
    </section>
  );
}
```

`components/home/PopularTiers.tsx` 의 각 `<li>` 를 번호·아이콘 행으로:

```tsx
   {group.items.length?<ol className="tier-list">{group.items.map((p,index)=>{
    const owner=githubOwnerFromRepositoryUrl(p.repoUrl);
    return <li key={p.slug} className="rank-row">
     <span className="rank-no">{index+1}</span>
     <ProductIcon name={p.name} ogImage={p.ogImage} size={28} />
     <span className="rank-name"><Link href={`/p/${p.slug}`} title={p.name}>{p.name}</Link>{owner?<small>@{owner.login}</small>:null}</span>
     <StarMetric value={p} />
    </li>;
   })}</ol>:<p className="popular-empty">아직 없음</p>}
```

머리는 `<h2>많이 쓰이는 프로젝트</h2><p>GitHub 스타 2천 이상 · 구간마다 상위 3</p>` 로 줄이고 `popular-eyebrow` 줄과 `popular-note` 는 `row-more` 링크(`집계 기준 ›`, `href="/?metric=popular#popular-projects"`)로 머리 오른쪽에 둔다. `import { ProductIcon } from "@/components/ProductIcon";` 추가.

`components/BrowseFilters.tsx`: `TABS` 에서 `open` 항목 삭제(주소 `?sort=open` 은 `parseHomeSort` 가 계속 받는다). 두 `<select>`(`AutoSubmitSelect`)와 `<form className="selects">` 를 지우고 분야 알약으로:

```tsx
      <nav className="chips chips-filter" aria-label="분야">
        <Link href={hrefWith(state, { category: undefined })} className={`chip${state.category ? "" : " chip-dark"}`} aria-current={state.category ? undefined : "true"}>전체</Link>
        {categories.map((category) => (
          <Link key={category} href={hrefWith(state, { category })} className={`chip${state.category === category ? " chip-dark" : ""}`} aria-current={state.category === category ? "true" : undefined}>
            {CATEGORY_LABELS[category]} <span className="chip-count">{(counts[category] ?? 0).toLocaleString("ko-KR")}</span>
          </Link>
        ))}
      </nav>
```

`categories` 는 `counts` 내림차순으로 정렬해 쓴다: `const categories = CATEGORIES.filter(...).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));`. `AutoSubmitSelect` import 삭제. `filter-summary` 는 그대로(개수·필터 초기화).

`HomeHero.tsx`·`HomePulse.tsx`·`HomeAside.tsx`·`AutoSubmitSelect.tsx` 는 `git rm`. `tests/home-pulse.test.ts` 에서 `HomePulse` 컴포넌트를 렌더하는 케이스를 삭제한다(집계 함수 테스트는 남긴다).

- [ ] **Step 4: 확인** — `npm test -- tests/home-sections.test.tsx tests/home-pulse.test.ts && npx tsc --noEmit`
Expected: PASS. `app/page.tsx` 가 지운 컴포넌트를 아직 import 하므로 tsc 는 다음 Task 까지 실패할 수 있다 — Task 10 과 같은 커밋으로 묶어도 된다.

- [ ] **Step 5: 커밋** (Task 10 과 함께)

### Task 10: 홈 조립

**Files:**
- Modify: `app/page.tsx:1-40` (import), `:234-444` (`HomeContent`)
- Test: `tests/home-unclaimed.test.tsx`, `tests/home-sort.test.ts`

- [ ] **Step 1: 홈 조립 테스트 보강** — `tests/home-unclaimed.test.tsx` 의 `describe("구획 제목")` 에 추가:

```ts
  it("첫 화면에 급상승 띠가 오고 피드는 그다음 항목부터 이어진다", async () => {
    categoryCounts.mockResolvedValue({ Dev: 3 });
    const rising = ["r1", "r2", "r3", "r4", "r5", "r6"].map(product);
    getPublicList.mockImplementation(async (limit: number, options: { offset?: number } = {}) => rising.slice(options.offset ?? 0, (options.offset ?? 0) + limit));
    const html = await render({});
    expect(html.indexOf("지금 뜨는 프로젝트")).toBeLessThan(html.indexOf("발견할 가치가 있는 프로젝트"));
    expect(getPublicList).toHaveBeenCalledWith(5, expect.objectContaining({ sort: "rising", rising: true }));
    expect(getPublicList).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ sort: "rising", offset: 5 }));
  });
```

(이 파일의 `render`·`product`·목 설정은 기존 것을 쓴다. 모듈 목은 새 export 를 알아야 한다 — `vi.mock("@/lib/domain/products/view", …)` 를 `({ getUnclaimedList, getVerifiedList, getPublicList, getNewThisWeek: vi.fn().mockResolvedValue([]), NEW_THIS_WEEK_MIN_STARS: 50 })` 로, `vi.mock("@/lib/domain/products/repository", …)` 를 `({ categoryCounts, countProducts, listBuilders, RISING_MAX_STARS: 2000 })` 로 넓힌다. `home-pulse` 목은 `importOriginal` 로 원본을 펼치고 `getHomePulse` 만 바꾸는 형태라 `completedWindows` 가 그대로 나온다. `verifiedTotal`(둘째 `countProducts` 호출) 이 0인 기존 케이스를 기준으로 한다.)

- [ ] **Step 2: 실패 확인** — `npm test -- tests/home-unclaimed.test.tsx` → FAIL.

- [ ] **Step 3: `HomeContent` 고치기**

import 를 바꾼다: `HomeHero`·`HomePulse`·`HomeAside`·`Icon` 제거; 추가:

```ts
import { ActiveList } from "@/components/home/ActiveList";
import { CompactRow } from "@/components/home/CompactRow";
import { IntroLine } from "@/components/home/IntroLine";
import { LaunchBand } from "@/components/home/LaunchBand";
import { NewsList } from "@/components/home/NewsList";
import { ToolsBoard } from "@/components/home/ToolsBoard";
import { completedWindows } from "@/lib/domain/products/home-pulse";
import { getNewThisWeek, type ProductListItem } from "@/lib/domain/products/view";
```

`HomeContent` 안, `asideLoad` 를 만든 뒤:

```ts
  /** 첫 화면의 급상승 띠 — 필터·검색이 없을 때만. 피드의 '추천'(대체 목록)은 띠 다음부터 이어 받는다 */
  const RISING_STRIP = 5;
  const filtered = Boolean(query || category || builder);
  const stripLoad = filtered ? Promise.resolve<ProductListItem[]>([]) : getPublicList(RISING_STRIP, { sort: "rising", rising: true }).catch(() => []);
  const newLoad = filtered ? Promise.resolve<ProductListItem[]>([]) : getNewThisWeek(5, completedWindows(now).weekStart).catch(() => []);
```

목록 조회에서 띠와 겹치지 않게:

```ts
    const stripShown = !filtered && fallback === "rising" ? RISING_STRIP : 0;
    const limit = publicCatalogue ? Math.min(requestedLimit, Math.max(0, matchingTotal - stripShown)) : verifiedTotal;
    list = fallback
      ? await getPublicList(limit, { ...listOptions, sort: fallback, offset: stripShown })
      : …(그대로)
    resultCount = publicCatalogue ? Math.max(0, matchingTotal - stripShown) : list.length;
```

(`const filtered = Boolean(query || category || builder);` 가 아래쪽에 이미 있으므로 그 줄은 지운다.)

`asideLoad` 를 받는 줄 다음에 `const [strip, fresh] = await Promise.all([stripLoad, newLoad]);`.

JSX — `<main className="wrap">` 안을 이 순서로:

```tsx
    <main className="wrap">
      {!query && <IntroLine pulse={pulse} state={state} />}
      {!filtered && (
        <CompactRow id="rising" title="지금 뜨는 프로젝트" note={`마지막 확인 사이 GitHub 스타가 가장 많이 늘었습니다 · 스타 ${RISING_MAX_STARS.toLocaleString("ko-KR")} 미만`}
          more={{ href: "#projects", label: `${resultCount.toLocaleString("ko-KR")}개 모두 보기` }} items={strip} trailing="category" />
      )}

      <section id="projects" aria-labelledby="projects-title" className="feed">
        <div className="row-head">
          <div>
            <h2 id="projects-title" className="row-title">{query ? `“${query}” 검색 결과` : "발견할 가치가 있는 프로젝트"}</h2>
            {translatedQuery && <p className="row-note">영어로 “{translatedQuery}”도 함께 찾았습니다.</p>}
            {!query && fallback === "rising" && <p className="row-note">마지막 확인 사이 GitHub 스타가 늘어난 순 · <Link href={metricHref(state, "rising")} scroll={false}>집계 기준</Link></p>}
            {!query && fallback === "stars" && <p className="row-note">GitHub 스타가 많은 순.</p>}
          </div>
        </div>
        <BrowseFilters state={state} counts={counts} total={total} resultCount={resultCount}
          listLabel={fallback === "rising" ? "스타 증가 순" : fallback === "stars" ? "스타 많은 순" : undefined} />
        {dbDown ? (…그대로…) : savedOnly || list.length > 0 ? (<ProjectGrid …그대로… />) : (<EmptyReason …그대로… />)}
        {!savedOnly && unclaimed.length > 0 && (…그대로…)}
      </section>

      {!query && (
        <Suspense fallback={<section className="popular-section" id="popular"><h2>많이 쓰이는 프로젝트</h2></section>}>
          <PopularTiers personal={firstValue(params.personal) === "1"} />
        </Suspense>
      )}
      {!filtered && (
        <CompactRow id="new" title="이번 주 새로 나온 프로젝트" note={`최근 7일에 처음 공개된 프로젝트 중 스타 ${NEW_THIS_WEEK_MIN_STARS} 이상`}
          more={{ href: "/?sort=recent", label: "최신순 모두 보기" }} items={fresh} trailing="listed" />
      )}
      {!query && (
        <div className="two-col">
          <ToolsBoard tools={pulse.tools} state={state} />
          <ActiveList active={pulse.active} projects={pulse.updates.projects} />
        </div>
      )}
      {!query && <NewsList news={news} />}
      {!query && <LaunchBand />}

      <Suspense><MethodologyDialog pulse={serializePulse(pulse)} rankingFallback={!rankingReady} /></Suspense>
    </main>
```

`RISING_MAX_STARS` 는 `@/lib/domain/products/repository` 에서, `NEW_THIS_WEEK_MIN_STARS` 는 `view` 에서 import. `PopularTiers` 의 `<section id="popular-projects">` 는 `id="popular"` 로 바꾼다(헤더 링크와 맞춤; `/popular` 페이지의 `#popular-projects` 되돌아가기 링크도 `#popular` 로). `content-layout`·`principle-box`·`all-link` 는 사라진다. `NewsList` 는 `.wrap` 밖 전폭 띠라 `<main className="wrap">` 안에서는 `wrap-break` 클래스로 좌우 여백을 상쇄한다(CSS 참고).

- [ ] **Step 4: 확인**

Run: `npm test -- tests/home-unclaimed.test.tsx tests/home-sort.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS. `home-sort` 의 "accepts the public sorts including products with repository links" 는 `parseHomeSort` 만 보므로 그대로 통과한다.

- [ ] **Step 5: 커밋**

```bash
git add app/page.tsx components/home components/BrowseFilters.tsx tests/home-sections.test.tsx tests/home-unclaimed.test.tsx tests/home-pulse.test.ts
git commit -m "feat(home): v5 composition — intro line, rising strip, feed, tiers, new-this-week, tools, active, news"
```

### Task 11: `app/home.css` 다시 쓰기

**Files:**
- Rewrite: `app/home.css`

- [ ] **Step 1: 남길 블록을 먼저 옮긴다** — 새 파일을 만들며 기존 파일에서 그대로 복사해 올 블록: `.skip`(7–16), `.saved-nav`·`.saved-dot`(202–220), `.text-button`(310–316), `.more-btn`(723–733), `.saved-banner`(734–741), `.empty-state`(742–760), `.unclaimed-block`(946–955), 모달 블록 `.modal-*`·`.formula`·`.method-*`·`.notice`·`.metric-links`·`.close-btn`(956–1082), `.secondary`(1083–1094), `.mobile-bottom` 과 반응형의 모바일 탭 부분(1414–1497 안의 `.mobile-bottom` 규칙), `.star-metric`·`.star-change-*`, `.popular-*`(1503–끝) 전부. 복사한 뒤 색 리터럴은 토큰으로 바꾼다(`#5c6373`→`var(--text-2)`, 보라 계열→`var(--accent)`/`var(--accent-soft)`).

삭제하는 블록(복사하지 않는다): `.pulse-strip*`·`.ps-*`, `.hero*`·`.eyebrow`, `.pulse-top`·`.section-eyebrow`·`.small-dot`·`.pulse-controls`, `.boards`·`.board*`·`.born`·`.info-btn`·`.scope-note`, `.content-layout`·`.feed-head`·`.all-link`, `.selects`·`.filter-apply`, `.card-visual`·`.cover-*`·`.project-cover`·`.tiny-tag*`·`.project-tags`·`.pill*`·`.maker*`·`.avatar`·`.card-actions`·`.save-count`·`.vote`, `.aside*`·`.source-pill`·`.news-item`·`.news-type`·`.mini-source`·`.news-meta`·`.brief-bottom`·`.build-*`·`.community-preview`·`.principle-box`, 커버 목업 전부(1095–1390: `.mock-window`…`.note-pill`).

- [ ] **Step 2: 새 블록을 쓴다** — 아래를 파일 머리(`.skip` 다음)에:

```css
/* nomorevibe 홈 — 시안 5차(docs/design/redesign-v5/home.html). UI 글자는 13px 이상, 12px 는 보조 캡션만. */

.wrap { max-width: 1120px; margin: 0 auto; padding: 0 32px; box-sizing: border-box; }
.wrap-break { margin-left: -32px; margin-right: -32px; }

/* 헤더 */
.nmb-header { position: sticky; top: 0; z-index: 10; background: rgba(255, 255, 255, 0.86); backdrop-filter: saturate(180%) blur(20px); -webkit-backdrop-filter: saturate(180%) blur(20px); border-bottom: 1px solid var(--border); }
.header-row { height: 56px; display: flex; align-items: center; gap: 24px; }
.brand { font-size: 18px; font-weight: 600; letter-spacing: -0.02em; color: var(--text); display: inline-flex; align-items: center; gap: 6px; height: 44px; flex-shrink: 0; }
.brand-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); display: inline-block; }
.navigation { display: flex; gap: 20px; font-size: 14px; flex-shrink: 0; }
.navigation a { color: var(--text-2); display: inline-flex; align-items: center; height: 44px; }
.navigation a.active { color: var(--text); font-weight: 500; }
.header-search { position: relative; flex: 1 1 200px; max-width: 420px; margin-left: auto; display: flex; align-items: center; }
.header-search svg { position: absolute; left: 14px; color: var(--text-2); pointer-events: none; }
.header-search input { width: 100%; box-sizing: border-box; height: 38px; border-radius: 980px; border: 0; padding: 0 48px 0 38px; font: inherit; font-size: 14px; color: var(--text); background: var(--bg-soft); outline: none; }
.header-search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.key { position: absolute; right: 10px; font-size: 11px; color: var(--text-2); border: 1px solid #d2d2d7; border-radius: 6px; padding: 1px 5px; background: white; font-family: inherit; }
.primary { display: inline-flex; align-items: center; justify-content: center; height: 36px; padding: 0 16px; border-radius: 980px; background: var(--text); color: white; font-size: 14px; font-weight: 500; white-space: nowrap; flex-shrink: 0; }
.primary:hover { color: white; opacity: 0.9; }

/* 소개 줄 */
.intro-line { display: flex; align-items: baseline; justify-content: space-between; gap: 16px 24px; flex-wrap: wrap; padding: 30px 0 6px; }
.intro-title { margin: 0; font-size: 26px; line-height: 1.2; font-weight: 600; letter-spacing: -0.025em; }
.intro-title em { font-style: normal; color: var(--accent); }
.intro-stats { margin: 0; font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.intro-stats b { color: var(--text); font-weight: 600; }
.intro-stats a { color: var(--text-2); }

/* 구획 머리 — 모든 구획이 같은 머리를 쓴다 */
.row-section { padding: 22px 0 40px; display: flex; flex-direction: column; gap: 16px; }
.row-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.row-title { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
.row-title-sm { font-size: 15px; }
.row-note { margin: 4px 0 0; font-size: 13px; color: var(--text-2); }
.row-note a { color: var(--accent); }
.row-more { font-size: 13px; color: var(--accent); display: inline-flex; align-items: center; height: 44px; white-space: nowrap; }
.row-foot { margin: 0; font-size: 12px; color: var(--text-2); line-height: 1.5; }

/* 타일 */
.project-tile { display: flex; align-items: center; justify-content: center; position: relative; width: 100%; }
.tile-64 { height: 112px; }
.tile-44 { height: 84px; }
.tile-paper { background: #f2f2f7; } .tile-day { background: #eef3fb; } .tile-invoice { background: #f5efe8; }
.tile-form { background: #edf5ef; } .tile-hue { background: #f6eef3; } .tile-note { background: #f0eff8; }
.tile-icon img, .tile-icon > span { border-radius: 15px; border: 0; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1); background: white; }
.tile-44 .tile-icon img, .tile-44 .tile-icon > span { border-radius: 12px; }
.tile-flag { position: absolute; left: 12px; top: 12px; font-size: 12px; font-weight: 500; color: white; background: rgba(29, 29, 31, 0.78); border-radius: 980px; padding: 4px 10px; }

/* 작은 카드 가로 띠 */
.compact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(188px, 100%), 1fr)); gap: 16px; }
.compact-card { background: var(--bg-soft); border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; }
.compact-visual { display: block; }
.compact-body { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.compact-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.compact-tagline { margin: 0; font-size: 13px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.compact-meta { margin: 4px 0 0; font-size: 13px; color: var(--text-2); font-variant-numeric: tabular-nums; }

/* 피드 */
.feed { padding: 8px 0 56px; display: flex; flex-direction: column; gap: 18px; scroll-margin-top: 72px; }
.tabs { display: inline-flex; background: var(--bg-soft); border-radius: 980px; padding: 2px; gap: 2px; }
.tab { display: inline-flex; align-items: center; height: 40px; padding: 0 16px; border-radius: 980px; color: var(--text-2); font-size: 14px; white-space: nowrap; }
.tab.active { background: white; color: var(--text); font-weight: 500; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08); }
.filter-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.filter-summary { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--text-2); }
.chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border-radius: 980px; background: var(--bg-soft); color: var(--text); font-size: 13px; white-space: nowrap; }
.chip-count { color: var(--text-2); font-variant-numeric: tabular-nums; }
.chip-dark { background: var(--text); color: white; font-weight: 500; }
.chip-dark .chip-count { color: #a1a1a6; }
.chip:hover { color: var(--text); background: var(--bg-hover); }
.chip-dark:hover { color: white; background: var(--text); }

.projects-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 20px; }
.project-card { background: var(--bg-soft); border-radius: 18px; overflow: hidden; display: flex; flex-direction: column; }
.card-visual { display: block; }
.project-body { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 6px; flex-grow: 1; min-width: 0; }
.project-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.project-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.3; min-width: 0; }
.cover-saved { width: 44px; height: 44px; margin: -8px -12px -8px 0; border: 0; background: transparent; color: var(--text-2); display: inline-flex; align-items: center; justify-content: center; border-radius: 980px; flex-shrink: 0; }
.cover-saved.active { color: var(--accent); }
.project-tagline { margin: 0; font-size: 14px; line-height: 1.45; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.project-bottom { margin-top: auto; padding-top: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--text-2); }
.project-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-meta a { color: var(--text-2); }
.meta-down { color: var(--down); }

/* 순위 행 — 인기 구간·활발한 목록이 같이 쓴다 */
.rank-list, .tier-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.rank-row { display: grid; grid-template-columns: 18px 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid var(--border); }
.rank-no { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.rank-name { min-width: 0; display: flex; flex-direction: column; }
.rank-name a { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rank-name small { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rank-value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }

/* 인기 구간 — 흰 타일 하나를 헤어라인으로 넷 */
.popular-section { background: var(--bg-soft); padding: 48px 0; margin: 0 -32px; scroll-margin-top: 72px; }
.popular-section > * { max-width: 1056px; margin-left: auto; margin-right: auto; padding: 0 32px; box-sizing: content-box; }
.popular-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 1px; background: var(--border); border-radius: 18px; overflow: hidden; margin-top: 18px; }
.popular-tier { background: white; padding: 18px 20px 14px; display: flex; flex-direction: column; min-width: 0; }
.popular-tier header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
.popular-tier h3 { margin: 0; font-size: 15px; font-weight: 600; }
.popular-tier header span { font-size: 12px; color: var(--text-2); }
.popular-all { margin-top: auto; padding-top: 8px; font-size: 13px; color: var(--accent); display: inline-flex; align-items: center; min-height: 44px; }

/* 도구·활발한 두 칸 */
.two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(420px, 100%), 1fr)); gap: 40px 48px; padding: 48px 0; }
.tools-board, .active-list { display: flex; flex-direction: column; gap: 12px; }

/* 소식 */
.news-band { background: var(--bg-soft); padding: 40px 0; margin: 0 -32px; }
.news-list { list-style: none; margin: 12px 0 0; padding: 0; }
.news-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 10px 0; border-top: 1px solid #e0e0e5; font-size: 13px; }
.news-list li:last-child .news-row { border-bottom: 1px solid #e0e0e5; }
.news-source, .news-date { color: var(--text-2); white-space: nowrap; }
.news-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 등록 띠 */
.launch-band { display: flex; align-items: center; justify-content: space-between; gap: 24px 40px; flex-wrap: wrap; padding: 64px 0; }
.launch-title { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -0.03em; line-height: 1.15; text-wrap: balance; }
.launch-title em { font-style: normal; color: var(--accent); }
.launch-note { margin: 8px 0 0; font-size: 15px; line-height: 1.5; color: var(--text-2); max-width: 560px; text-wrap: pretty; }
.launch-actions { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
.launch-command { font-family: var(--font-mono); font-size: 14px; background: var(--bg-soft); border-radius: 12px; padding: 12px 18px; }
.launch-actions .primary { height: 44px; padding: 0 22px; background: var(--accent); font-size: 15px; }

/* 푸터 */
.nmb-footer { border-top: 1px solid var(--border); margin-top: auto; }
.footer { padding: 22px 0 40px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.footer a { color: var(--text-2); }
.footer-brand { font-weight: 600; color: var(--text); margin-right: 6px; }
.footer-right { display: flex; gap: 20px; }

@media (max-width: 780px) {
  .wrap { padding: 0 16px; }
  .wrap-break, .popular-section, .news-band { margin-left: -16px; margin-right: -16px; }
  .popular-section > * { padding: 0 16px; }
  .navigation { display: none; }
  .header-search { max-width: none; }
  .intro-title { font-size: 22px; }
  .news-row { grid-template-columns: minmax(0, 1fr) auto; }
  .news-source { display: none; }
}
```

- [ ] **Step 3: 눈으로 확인**

Run: `npm run dev` 후 `http://localhost:3000/` 를 1280·390 폭으로. 확인 항목: ① 1280×800 에서 스크롤 없이 "지금 뜨는 프로젝트" 다섯 장이 보인다 ② 카드에 미클레임 배지가 없다 ③ 390 폭에서 가로 스크롤이 없다 ④ 인기 구간 행에 28px 아이콘 ⑤ `/popular` 가 깨지지 않는다.

- [ ] **Step 4: 전체 검사와 커밋**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: PASS (ui-contract 의 "no visible Tailwind font utility below 13px" 는 Tailwind 유틸리티만 보므로 CSS 의 12px 캡션은 걸리지 않는다).

```bash
git add app/home.css app/popular/page.tsx components/home/PopularTiers.tsx
git commit -m "feat(home): rewrite the home stylesheet for the v5 layout"
```

### Task 12: 홈 e2e 갱신

**Files:**
- Modify: `tests/e2e/home-redesign.spec.ts:26-80`

- [ ] **Step 1: 바뀐 머리·띠·카드로 기대값 교체**

```ts
  await expect(page.getByRole("heading", { name: /AI로 만든 것들이/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "발견할 가치가 있는 프로젝트" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "많이 쓰이는 프로젝트" })).toBeVisible();

  const card = page.locator(".project-card").filter({ hasText: "Evidence Studio" });
  const tile = card.locator(".project-tile");
  const save = card.getByRole("button", { name: "Evidence Studio 저장" });
  await expect(card.getByRole("link", { name: "Evidence Studio 상세 보기" }))
    .toHaveAttribute("href", `/p/${PRODUCT_DETAIL_FIXTURES.rich}`);
  await expect(tile).toBeVisible();
  await save.click();
  await expect(card.getByRole("button", { name: "Evidence Studio 저장 취소" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("link", { name: /이번 주 태어난/ }).click();
  const dialog = page.getByRole("dialog", { name: "숫자의 기준" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
```

`strip`(이번 주 nomorevibe 영역)·"분야 순위" 관련 줄과 커버 위 저장 버튼 좌표 검사는 삭제한다. 검색·저장 목록 부분은 그대로.

- [ ] **Step 2: 실행**

Run: `npm run test:e2e -- tests/e2e/home-redesign.spec.ts`
Expected: PASS (Playwright 환경은 `README.md` 의 e2e 절차대로).

- [ ] **Step 3: 커밋 후 PR 2**

```bash
git add tests/e2e/home-redesign.spec.ts
git commit -m "test(e2e): home expectations for the v5 layout"
```

PR 제목 `feat(home): v5 redesign — projects first, icon tiles, one accent`. 본문에 시안 링크와 "제작 도구 구획은 `agentEvidence.displayObservedFacts` 가 켜질 때만 보인다"를 적는다.

---

## PR 3 — 상세

### Task 13: 히어로 — 작게, 급상승 배지, 메타 한 줄

**Files:**
- Modify: `components/product-detail/ProductHero.tsx` (전체 교체), `components/product-detail/InstallPrompt.tsx:26-29`
- Test: `tests/product-detail-components.test.tsx` ("renders the current stored rank…", "drops the description line…", "stands a named cover…", "uses a safe internal OG copy…", 마지막 `it("offers an installation prompt…")`)

- [ ] **Step 1: 테스트 기대값**

- "renders the current stored rank, verification, lifecycle, and a 44px outbound action": `제품 방문하기` 링크가 `min-h-11`(44px) 인지와 이름·`미클레임` 글자가 있는지로 바꾼다. 시즌 순위 `이번 시즌 #` 표기는 유지(있을 때만).
- "drops the description line when it repeats the tagline" / "keeps the description…": 히어로는 더 이상 description 을 내지 않는다 → 두 케이스를 `IntroSection`(Task 15) 으로 옮긴다. 여기서는 삭제.
- "stands a named cover…", "uses a safe internal OG copy as the large representative image…": 삭제하고 아래 둘로 교체:

```ts
  it("shows the rising rank badge only inside the top twenty", () => {
    expect(renderHero({ risingRank: 5 })).toContain("지금 뜨는 5위");
    expect(renderHero({ risingRank: 21 })).not.toContain("지금 뜨는");
    expect(renderHero({ risingRank: null })).not.toContain("지금 뜨는");
  });
  it("puts category, stars, top languages, owner and status in one meta line without a large image", () => {
    const html = renderHero({});
    expect(html).toContain("데이터");
    expect(html).toContain("★ 40,064");
    expect(html).toContain("Python · TypeScript");
    expect(html).toContain("GitHub @PostHog");
    expect(html).not.toContain("product-hero-media");
  });
```

`renderHero(overrides)` 는 파일의 기존 픽스처(`detail`)로 `ProductHero` 를 `renderToStaticMarkup` 하는 헬퍼 — 기존 케이스가 쓰는 방식 그대로, props 는 아래 새 시그니처.

- 마지막 "offers an installation prompt…": 버튼 이름을 `설치 프롬프트 복사` 로.

- [ ] **Step 2: 실패 확인** — `npm test -- tests/product-detail-components.test.tsx` → FAIL.

- [ ] **Step 3: 히어로 교체**

```tsx
// components/product-detail/ProductHero.tsx
import { ProductIcon } from "@/components/ProductIcon";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { categoryLabel } from "@/lib/domain/products/labels";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { ShareButton } from "./ShareButton";
import { InstallPrompt } from "./InstallPrompt";
import { SaveButton } from "./SaveButton";

/** 홈 '지금 뜨는'과 같은 순위 — 20위 안일 때만 배지 */
const RISING_BADGE_MAX = 20;

/**
 * 상세 머리 — 아이콘 80 · 이름 40 · 한 줄 소개 20 · 메타 한 줄 · 버튼.
 *
 * 큰 이미지는 두지 않는다: 공개 제품의 54%는 256px 아이콘뿐이고 스크린샷은 0이다(2026-10-02).
 * 넓은 이미지가 있으면 오른쪽 열의 PreviewFigure 가 작게 보여 준다.
 */
export function ProductHero({ product, unclaimed, risingRank, health, languages }: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  risingRank: number | null;
  health: ProductDetailView["health"];
  /** 저장소 언어 상위 둘 — RepositoryFacts.languages 에서 */
  languages: string[];
}) {
  const owner = githubOwnerFromRepositoryUrl(product.repoUrl);
  const installable = product.accessMode === "installable";
  const current = isHealthCurrent(health.checkedAt);
  const online = current && !health.down && health.lastCheckSucceeded !== false;
  const displayUrl = product.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const safeIcon = product.ogImage?.startsWith("/") ? product.ogImage : null;

  return (
    <section className="border-b border-line pb-7 pt-6">
      <div className="flex flex-wrap items-start gap-[22px]">
        <div className="shrink-0 overflow-hidden rounded-[18px] border border-line bg-bg-soft [&_img]:rounded-none [&_img]:border-0">
          <ProductIcon name={product.name} ogImage={safeIcon} size={80} />
        </div>
        <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-fg">{product.name}</h1>
            {risingRank !== null && risingRank <= RISING_BADGE_MAX && (
              <a href="/#rising" className="inline-flex h-7 items-center rounded-full bg-accent-soft px-[11px] text-[13px] font-semibold text-accent">
                지금 뜨는 {risingRank}위
              </a>
            )}
          </div>
          <p className="max-w-[720px] text-[20px] leading-[1.35] tracking-[-0.01em] text-fg">{product.tagline}</p>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14px] text-fg-2 tabular-nums">
            <span className="text-fg">{categoryLabel(product.category)}</span>
            {product.stars !== null && product.stars !== undefined && <><span aria-hidden>·</span><span className="font-medium text-fg">★ {product.stars.toLocaleString("ko-KR")}</span></>}
            {languages.length > 0 && <><span aria-hidden>·</span><span>{languages.join(" · ")}</span></>}
            {owner && <><span aria-hidden>·</span><span>GitHub @{owner.login}</span></>}
            <span aria-hidden>·</span>
            {installable ? <span>직접 설치</span> : !current ? <span>가동 상태 확인 전</span> : online
              ? <span className="inline-flex items-center gap-1.5"><i aria-hidden className="inline-block h-2 w-2 rounded-full bg-up" />온라인{health.latencyMs === null ? "" : ` · ${health.latencyMs}ms`}</span>
              : <span className="text-down">접속 불안정</span>}
            {unclaimed && <><span aria-hidden>·</span><span title="우리가 찾아서 올린 제품입니다. 아직 주인이 확인해주지 않았습니다.">미클레임</span></>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            {installable ? (
              <>
                <a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full bg-accent-solid px-6 text-[15px] font-medium text-white hover:opacity-90">GitHub 저장소 열기</a>
                <InstallPrompt repoUrl={product.repoUrl ?? product.url} />
              </>
            ) : (
              <>
                <a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full bg-accent-solid px-6 text-[15px] font-medium text-white hover:opacity-90">제품 방문하기</a>
                {product.repoUrl && <a href={product.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-full bg-bg-soft px-5 text-[15px] font-medium text-fg">GitHub 저장소</a>}
              </>
            )}
            <ShareButton title={product.name} path={`/p/${product.slug}`} />
            <SaveButton slug={product.slug} name={product.name} />
            {!installable && <a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer" className="ml-1 text-[14px] text-fg-2 hover:underline">{displayUrl} ↗</a>}
          </div>
        </div>
      </div>
    </section>
  );
}
```

`SaveButton` 은 홈의 저장 목록(`components/home/saved.ts`)에 넣고 빼는 44px 원형 버튼 — 새 파일 `components/product-detail/SaveButton.tsx`:

```tsx
"use client";
import { useMemo, useSyncExternalStore } from "react";
import { Icon } from "@/components/home/icons";
import { parseSaved, persistSaved, savedSnapshot, subscribeSaved } from "@/components/home/saved";

export function SaveButton({ slug, name }: { slug: string; name: string }) {
  const raw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  const on = saved.has(slug);
  return (
    <button type="button" aria-pressed={on} aria-label={`${name} ${on ? "저장 취소" : "저장"}`}
      onClick={() => { const next = new Set(saved); if (on) next.delete(slug); else next.add(slug); persistSaved(next); }}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full bg-bg-soft ${on ? "text-accent" : "text-fg"}`}>
      <Icon name="bookmark" size={18} />
    </button>
  );
}
```

`ShareButton` 의 className 을 같은 44px 원형(`h-11 w-11 rounded-full bg-bg-soft`)으로 맞추고 글자 대신 `Icon`(`arrow-up-right`)과 `aria-label="공유"` 를 쓴다. `InstallPrompt` 의 복사 버튼 className 을 `inline-flex min-h-11 items-center rounded-full bg-bg-soft px-5 text-[15px] font-medium text-fg` 로, 레이블을 `{copied ? "복사됨 ✓" : "설치 프롬프트 복사"}` 로; 안내 문장은 그대로.

- [ ] **Step 4: 확인** — `npm test -- tests/product-detail-components.test.tsx` → 히어로 관련 PASS (나머지 구획 케이스는 다음 Task 에서).

- [ ] **Step 5: 커밋**

```bash
git add components/product-detail/ProductHero.tsx components/product-detail/SaveButton.tsx components/product-detail/ShareButton.tsx components/product-detail/InstallPrompt.tsx tests/product-detail-components.test.tsx
git commit -m "feat(detail): compact hero with the rising badge and a one-line meta"
```

### Task 14: 핵심 사실 띠

**Files:**
- Create: `components/product-detail/FactsStrip.tsx`
- Delete: `components/product-detail/ProductMetrics.tsx`
- Test: `tests/product-detail-components.test.tsx` ("labels only NoMoreVibe-originated seven-day visits…", "does not call a nineteen-day-old health observation online", "does not label a fresh failed health check online…")

- [ ] **Step 1: 테스트** — 위 세 케이스가 `ProductMetrics` 를 렌더하면 `FactsStrip` 으로 바꾸고 기대값을:

```ts
  it("shows visits only when NoMoreVibe actually measured some", () => {
    expect(renderFacts({ visits: { ...detail.visits, collecting: true } })).not.toContain("유효 방문");
    expect(renderFacts({ visits: { ...detail.visits, collecting: false, validVisits: 12, uniqueVisitors: 9, uniqueChangePercent: 50 } })).toContain("유효 방문");
  });
  it("renders push, release, contributors, license and listing as the six facts", () => {
    const html = renderFacts({});
    for (const label of ["최근 push", "최신 release", "기여자", "라이선스", "nomorevibe 등록"]) expect(html).toContain(label);
    expect(html).toContain("가동 상태");
    expect(renderFacts({ product: { ...detail.product, accessMode: "installable" } })).toContain("이용 방식");
  });
```

건강 상태 두 케이스는 `renderFacts({ health: … })` 로 바꾸고 기대 문구(`온라인` 없음)는 그대로.

- [ ] **Step 2: 실패 확인** — `npm test -- tests/product-detail-components.test.tsx` → FAIL.

- [ ] **Step 3: 구현**

```tsx
// components/product-detail/FactsStrip.tsx
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { isHealthCurrent } from "@/lib/domain/products/health-freshness";
import { formatDate, formatNumber } from "./format";

function Tile({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: string; tone?: "up" | "down" }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-fg";
  return (
    <div className="flex flex-col gap-1 bg-bg-card px-[18px] pb-3.5 pt-4">
      <dt className="text-[13px] text-fg-3">{label}</dt>
      <dd className={`m-0 truncate text-[20px] font-semibold tracking-[-0.02em] tabular-nums ${color}`}>{value}</dd>
      {note && <span className="text-[13px] text-fg-3">{note}</span>}
    </div>
  );
}

/** 월·일만 — "10월 1일". 연도는 note 에 */
function monthDay(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const at = new Date(date);
  return Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" }).format(at) : "—";
}
function year(date: Date | string | null | undefined): string {
  if (!date) return "";
  const at = new Date(date);
  return Number.isFinite(at.getTime()) ? `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric" }).format(at)}` : "";
}

/**
 * 핵심 사실 여섯 칸 — 이미지 자리 대신 첫 화면을 사실로 채운다.
 * 유입 지표는 값이 있을 때만 일곱째 칸으로 — 공개 제품 대부분이 0·신규라 늘 보이면 빈 숫자가 가장 눈에 띈다.
 */
export function FactsStrip({ product, repository, license, health, visits }: {
  product: ProductDetailView["product"];
  repository: ProductDetailView["repository"];
  license: ProductDetailView["license"];
  health: ProductDetailView["health"];
  visits: ProductDetailView["visits"];
}) {
  const facts = repository?.facts ?? null;
  const installable = product.accessMode === "installable";
  const current = isHealthCurrent(health.checkedAt);
  const online = current && !health.down && health.lastCheckSucceeded !== false;
  const release = facts?.latestRelease ?? null;
  const measured = !visits.collecting && visits.uniqueVisitors !== null && visits.validVisits > 0;

  return (
    <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-px overflow-hidden rounded-[18px] border border-line bg-line">
      {installable
        ? <Tile label="이용 방식" value="직접 설치" note="사용자 환경에서 실행" />
        : <Tile label="가동 상태" tone={online ? undefined : current ? "down" : undefined}
            value={!current ? "확인 전" : online ? <span className="inline-flex items-center gap-2"><i aria-hidden className="inline-block h-[9px] w-[9px] rounded-full bg-up" />온라인</span> : "접속 불안정"}
            note={health.checkedAt ? `${health.latencyMs === null ? "응답 시간 미측정" : `${health.latencyMs}ms`}${health.uptime30d === null ? "" : ` · 30일 가동률 ${health.uptime30d}%`}` : undefined} />}
      <Tile label="최근 push" value={monthDay(facts?.pushedAt)} note={facts ? `${year(facts.pushedAt)} · ${facts.archived ? "보관됨" : facts.fork ? "fork 저장소" : "활성 저장소"}` : "저장소 미확인"} />
      <Tile label="최신 release" value={release?.tagName ?? "없음"} note={release ? `${release.name && release.name !== release.tagName ? `${release.name} · ` : ""}${monthDay(release.publishedAt)}` : "GitHub 릴리스 기준"} />
      <Tile label="기여자" value={facts?.contributors ? `${formatNumber(facts.contributors.count)}명${facts.contributors.incomplete ? "+" : ""}` : "—"} note={facts ? `포크 ${formatNumber(facts.forks)}` : undefined} />
      <Tile label="라이선스" value={license.state === "missing" ? "확인 안 됨" : license.label} tone={license.state === "conflict" ? "down" : undefined}
        note={license.state === "conflict" ? "두 값을 모두 확인하세요" : license.state === "missing" ? undefined : facts?.license?.spdxId && facts.license.spdxId !== "NOASSERTION" ? "GitHub에서 확인" : "GitHub 표기 · SPDX 미확인"} />
      <Tile label="nomorevibe 등록" value={monthDay(product.createdAt)} note={`${year(product.createdAt)}${facts?.createdAt ? ` · 저장소 생성 ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long" }).format(new Date(facts.createdAt))}` : ""}`} />
      {measured && <Tile label={`유효 방문 · 최근 ${visits.periodDays}일`} value={formatNumber(visits.validVisits)}
        note={visits.uniqueChangePercent === null ? `고유 ${formatNumber(visits.uniqueVisitors!)}` : `고유 ${formatNumber(visits.uniqueVisitors!)} · ${visits.uniqueChangePercent > 0 ? "+" : ""}${visits.uniqueChangePercent}%`} />}
    </dl>
  );
}
```

`facts.license`·`facts.archived`·`facts.fork`·`facts.contributors`·`facts.latestRelease` 의 모양은 `detail-view.ts` 의 `RepositoryFacts` 타입에 맞춘다(`repositoryFacts()` 가 만드는 객체 — `pushedAt: string | null`, `latestRelease: { tagName; name; publishedAt; url; notesUrl } | null`). `ProductMetrics.tsx` 는 `git rm`.

- [ ] **Step 4: 확인·커밋**

```bash
npm test -- tests/product-detail-components.test.tsx
git add components/product-detail/FactsStrip.tsx components/product-detail/ProductMetrics.tsx tests/product-detail-components.test.tsx
git commit -m "feat(detail): six-fact strip replaces the metrics band; visits only when measured"
```

### Task 15: 소개·README·언어 구성·만든 도구

**Files:**
- Create: `components/product-detail/IntroSection.tsx`, `LanguageBar.tsx`, `BuildTools.tsx`
- Delete: `components/product-detail/ProductIntroduction.tsx`, `BuildProvenance.tsx`
- Test: `tests/product-detail-components.test.tsx`, `tests/ui-contract.test.ts:81-88`

- [ ] **Step 1: 테스트**

`tests/ui-contract.test.ts` "uses the approved detail prose hierarchy" 를 새 파일 기준으로:

```ts
    const introduction = readFileSync(join(ROOT, "components/product-detail/IntroSection.tsx"), "utf8");
    const updates = readFileSync(join(ROOT, "components/product-detail/UpdateTimeline.tsx"), "utf8");
    expect(introduction).toContain('text-[17px] leading-[1.6] text-fg');
    expect(introduction).toContain('text-[15px] leading-[1.6]');
    expect(updates).toContain('text-[13px] text-fg');
```

`tests/product-detail-components.test.tsx`:
- Task 13 에서 옮긴 두 케이스("drops the description line when it repeats the tagline", "keeps the description…")를 `IntroSection` 으로: `renderIntro({ product: { ...detail.product, description: detail.product.tagline } })` 에 설명 문장이 한 번만(0번, 소개 구획에서는 아예 없음) / 다를 때는 들어 있음.
- "shows structured introduction and safe markdown without raw scripts": 프로필 `longDescriptionMarkdown` 처리는 `IntroSection` 이 그대로 맡으므로 렌더 대상만 바꾼다.
- "renders observed tool, configured model and gateway separately with citations while preserving maker reporting" → `BuildTools` 로: `clientLabel`·근거 링크(`commitSha` 앞 7자)·메이커 신고 배지가 있는지.
- "omits the development section when no confirmed or observed information exists" → 바꾼다:

```ts
  it("says the repository is not scanned yet, or that no trace was found, instead of omitting the section", () => {
    expect(renderTools({ toolScan: "none", agents: [], observedAgentFacts: [], skills: [] })).toContain("아직 저장소를 확인하지 않았습니다");
    expect(renderTools({ toolScan: "scanned", agents: [], observedAgentFacts: [], skills: [] })).toContain("흔적을 찾지 못했습니다");
  });
  it("adds a readme excerpt when the intro is a single line", () => {
    const html = renderIntro({ product: { ...detail.product, description: detail.product.tagline }, readmeExcerpt: "The README says more.\n\nSecond paragraph." });
    expect(html).toContain("README에서");
    expect(html).toContain("Second paragraph");
    expect(html).toContain("README 전문 보기");
  });
```

- [ ] **Step 2: 실패 확인** — `npm test -- tests/product-detail-components.test.tsx tests/ui-contract.test.ts` → FAIL.

- [ ] **Step 3: 구현**

```tsx
// components/product-detail/IntroSection.tsx
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { safeExternalUrl } from "./format";

function SafeMarkdownLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const safe = href?.startsWith("/") ? href : safeExternalUrl(href ?? null);
  if (!safe) return <span>{children}</span>;
  return <a href={safe} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">{children}</a>;
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-3">{children}</h2>;
}

/**
 * 소개 — 설명이 한 줄 소개와 다를 때만 설명을, 그다음 README 발췌를. 둘 다 없으면 README 로 가라는 한 줄.
 * 메이커 프로필(문제·사용자·기능·활용)은 있을 때만 그 아래.
 */
export function IntroSection({ product, profile, readmeExcerpt, unclaimed }: {
  product: ProductDetailView["product"];
  profile: ProductDetailView["profile"];
  readmeExcerpt: string | null;
  unclaimed: boolean;
}) {
  const description = product.description.trim() !== product.tagline.trim() ? product.description : null;
  const repo = product.repoUrl ? safeExternalUrl(product.repoUrl) : null;
  return (
    <div className="flex flex-col gap-9">
      <section aria-labelledby="intro-title" className="flex flex-col gap-3">
        <Heading><span id="intro-title">소개</span></Heading>
        {description
          ? <p className="m-0 max-w-[720px] whitespace-pre-line text-[17px] leading-[1.6] text-fg">{description}</p>
          : !readmeExcerpt && <p className="m-0 max-w-[720px] text-[14px] leading-[1.5] text-fg-2">메이커가 쓴 소개는 위의 한 줄이 전부입니다.{repo && <> 더 자세한 내용은 <a href={repo} target="_blank" rel="noopener noreferrer" className="text-accent">저장소 README ↗</a>에서 읽을 수 있습니다.</>}</p>}
        {description && <p className="m-0 text-[13px] text-fg-3">{unclaimed ? "자동 감지 · 저장소 README 기준" : "메이커 제공 · 미검증"}</p>}
      </section>
      {readmeExcerpt && (
        <section aria-labelledby="readme-title" className="flex flex-col gap-3">
          <Heading><span id="readme-title">README에서</span></Heading>
          <blockquote className="m-0 max-w-[720px] whitespace-pre-line border-l-2 border-line pl-[18px] text-[15px] leading-[1.6] text-fg">{readmeExcerpt}</blockquote>
          {repo && <a href={repo} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[13px] text-accent">README 전문 보기 ↗</a>}
        </section>
      )}
      {profile && (profile.problem || profile.targetUsers || profile.keyFeatures.length > 0 || profile.useCases.length > 0 || profile.longDescriptionMarkdown) && (
        <section aria-labelledby="profile-title" className="flex flex-col gap-4">
          <Heading><span id="profile-title">메이커가 밝힌 것</span></Heading>
          {(profile.problem || profile.targetUsers || profile.privacySummary) && (
            <dl className="m-0 grid gap-4 sm:grid-cols-2">
              {profile.problem && <div><dt className="text-[13px] font-semibold text-fg">해결하는 문제</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.problem}</dd></div>}
              {profile.targetUsers && <div><dt className="text-[13px] font-semibold text-fg">주요 사용자</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.targetUsers}</dd></div>}
              {profile.privacySummary && <div className="sm:col-span-2"><dt className="text-[13px] font-semibold text-fg">개인정보·처리 방식</dt><dd className="m-0 mt-1 text-[14px] leading-6 text-fg-2">{profile.privacySummary}</dd></div>}
            </dl>
          )}
          <div className="grid gap-6 sm:grid-cols-2">
            {profile.keyFeatures.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">주요 기능</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.keyFeatures.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            {profile.useCases.length > 0 && <div><h3 className="m-0 text-[14px] font-semibold text-fg">활용 예시</h3><ul className="m-0 mt-2 list-disc space-y-1.5 pl-5 text-[14px] leading-6 text-fg-2">{profile.useCases.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          </div>
          {profile.longDescriptionMarkdown && (
            <div className="space-y-3 text-[15px] leading-7 text-fg-2 [&_h2]:mt-5 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h2]:text-fg [&_li]:ml-5 [&_li]:list-disc [&_p]:my-3">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} skipHtml components={{ a: SafeMarkdownLink, img: () => null }}>
                {profile.longDescriptionMarkdown}
              </ReactMarkdown>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
```

```tsx
// components/product-detail/LanguageBar.tsx
import type { ProductDetailView } from "@/lib/domain/products/detail-view";

const SHADES = ["#1d1d1f", "#6e6e73", "#a1a1a6", "#d2d2d7"];

/** 저장소 언어 구성 — 상위 셋과 '외'. 색은 무채색 네 단계 */
export function LanguageBar({ repository }: { repository: ProductDetailView["repository"] }) {
  const languages = repository?.facts?.languages ?? [];
  if (languages.length === 0) return null;
  const top = languages.slice(0, 3);
  const rest = Math.max(0, Math.round((100 - top.reduce((sum, item) => sum + item.percent, 0)) * 10) / 10);
  const rows = rest > 0 ? [...top, { name: `${languages[3]?.name ?? "기타"} 외`, percent: rest }] : top;
  return (
    <section aria-labelledby="lang-title" className="flex flex-col gap-2.5">
      <h2 id="lang-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-3">언어 구성</h2>
      <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-line">
        {rows.map((item, index) => <span key={item.name} style={{ width: `${item.percent}%`, background: SHADES[index] }} />)}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0 text-[13px] text-fg tabular-nums">
        {rows.map((item, index) => (
          <li key={item.name} className="inline-flex items-center gap-[7px]"><i aria-hidden className="inline-block h-[9px] w-[9px] rounded-full" style={{ background: SHADES[index] }} />{item.name} <span className="text-fg-3">{item.percent}%</span></li>
        ))}
      </ul>
    </section>
  );
}
```

```tsx
// components/product-detail/BuildTools.tsx
import { BuilderBadge } from "@/components/TrustBadges";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";

/**
 * 무엇으로 만들었나 — 홈의 같은 이름 구획과 짝. 알약 하나가 도구 하나, 그 옆에 근거 링크.
 * 흔적은 사용 주장이지 실행 증명이 아니다 — 문구에 '흔적'을 남긴다.
 */
export function BuildTools({ product, unclaimed, agents, observedAgentFacts, skills, toolScan }: {
  product: ProductDetailView["product"];
  unclaimed: boolean;
  agents: ProductDetailView["agents"];
  observedAgentFacts: ProductDetailView["observedAgentFacts"];
  skills: ProductDetailView["skills"];
  toolScan: ProductDetailView["toolScan"];
}) {
  const reported = unclaimed ? null : product.builder;
  const observed = new Map<string, ProductDetailView["observedAgentFacts"]>();
  for (const fact of observedAgentFacts) {
    const key = fact.clientLabel.startsWith("미확인") ? "미확인 도구" : fact.clientLabel;
    observed.set(key, [...(observed.get(key) ?? []), fact]);
  }
  const nothing = !reported && agents.length === 0 && skills.length === 0 && observed.size === 0;

  return (
    <section aria-labelledby="tools-title" className="flex flex-col gap-2.5">
      <h2 id="tools-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-3">무엇으로 만들었나</h2>
      {nothing ? (
        <p className="m-0 max-w-[720px] text-[14px] leading-[1.5] text-fg-2">
          {toolScan === "none"
            ? "아직 저장소를 확인하지 않았습니다. 확인되면 설정 파일과 커밋 서명에서 찾은 AI 코딩 도구 흔적이 여기에 보입니다."
            : "저장소를 확인했지만 AI 코딩 도구의 흔적을 찾지 못했습니다. 메이커가 신고하면 여기에 표시됩니다."}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {reported && <li className="inline-flex h-10 items-center gap-2 rounded-full bg-bg-soft px-3.5 text-[14px]">메이커 신고 <BuilderBadge builder={reported} claim="reported" /></li>}
          {agents.map((agent) => (
            <li key={agent.id} className="inline-flex h-10 items-center gap-2 rounded-full bg-bg-soft px-3.5 text-[14px]">
              {[agent.provider, agent.client, agent.model].filter(Boolean).join(" · ")}<span className="text-[12px] text-fg-3">{agent.evidenceLabel}</span>
            </li>
          ))}
          {[...observed].map(([label, facts]) => (
            <li key={label} className="inline-flex h-10 items-center gap-2 rounded-full bg-bg-soft px-3.5 text-[14px]">
              {label}
              <span className="text-[12px] text-fg-3">{facts[0].label}</span>
              <a href={facts[0].sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[12px] text-accent" aria-label={`${label} 근거 ${facts[0].commitSha.slice(0, 7)}`}>근거 {facts[0].commitSha.slice(0, 7)} ↗</a>
              {facts.length > 1 && <span className="text-[12px] text-fg-3">외 {facts.length - 1}</span>}
            </li>
          ))}
          {skills.map((skill) => (
            <li key={skill.id} className="inline-flex h-10 items-center gap-2 rounded-full bg-bg-soft px-3.5 font-mono text-[13px]">{skill.namespace}/{skill.name}{skill.version ? `@${skill.version}` : ""}<span className="font-sans text-[12px] text-fg-3">{skill.evidenceLabel}</span></li>
          ))}
        </ul>
      )}
      {observed.size > 0 && observedAgentFacts.some((fact) => fact.coverageLabel) && <p className="m-0 text-[12px] text-fg-3">{observedAgentFacts.find((fact) => fact.coverageLabel)?.coverageLabel}</p>}
    </section>
  );
}
```

`ProductIntroduction.tsx`·`BuildProvenance.tsx` 는 `git rm`.

- [ ] **Step 4: 확인·커밋**

```bash
npm test -- tests/product-detail-components.test.tsx tests/ui-contract.test.ts
git add components/product-detail/IntroSection.tsx components/product-detail/LanguageBar.tsx components/product-detail/BuildTools.tsx components/product-detail/ProductIntroduction.tsx components/product-detail/BuildProvenance.tsx tests/product-detail-components.test.tsx tests/ui-contract.test.ts
git commit -m "feat(detail): intro with readme excerpt, language bar and the build-tools chips"
```

### Task 16: 업데이트 목록 축소

**Files:**
- Modify: `components/product-detail/UpdateTimeline.tsx`
- Test: `tests/product-detail-components.test.tsx` ("offers maker/automatic filters without a connecting timeline line")

- [ ] **Step 1: 테스트 기대값에 추가**

```ts
    expect(html).toContain("최근 30일");
    expect(html.match(/GitHub 릴리스|메이커 업데이트|자동 감지/g)?.length ?? 0).toBeLessThanOrEqual(8 + 3);
```

(픽스처에 9건 이상이면 8줄과 "모두 보기" 만 나와야 한다. 기존 기대값 — 필터 탭 셋, 연결선 없음 — 은 유지.)

- [ ] **Step 2: 실패 확인** → FAIL.

- [ ] **Step 3: 구현** — 파일 전체:

```tsx
"use client";

import { useState } from "react";
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { formatDate, safeExternalUrl } from "./format";

type Filter = "all" | "maker" | "automatic";
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "전체" }, { key: "maker", label: "메이커" }, { key: "automatic", label: "자동 감지" },
];
/** 처음에 보여 주는 줄 수 — PostHog 는 30일에 179건이라 다 펼치면 페이지가 그것으로 가득 찬다 */
const FIRST = 8;
const DAY = 86_400_000;

function monthDay(date: Date | null): string {
  return date ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric" }).format(date) : "—";
}

export function UpdateTimeline({ updates }: { updates: ProductDetailView["updates"] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false);
  const visible = updates.filter((update) => filter === "all" || (filter === "maker" ? update.sourceKind === "maker" : update.sourceKind !== "maker"));
  const recent = updates.filter((update) => (update.publishedAt ?? update.observedAt).getTime() >= Date.now() - 30 * DAY).length;
  const rows = expanded ? visible : visible.slice(0, FIRST);

  return (
    <section aria-labelledby="updates-title" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="updates-title" className="m-0 flex items-baseline gap-2 text-[13px] font-semibold tracking-[0.02em] text-fg-3">업데이트 <span className="font-normal tabular-nums">{recent > 0 ? `최근 30일 ${recent.toLocaleString("ko-KR")}건` : `${updates.length.toLocaleString("ko-KR")}건`}</span></h2>
        <div className="inline-flex gap-0.5 rounded-full bg-bg-soft p-0.5" role="tablist" aria-label="업데이트 출처 필터">
          {FILTERS.map((item) => (
            <button key={item.key} type="button" role="tab" onClick={() => setFilter(item.key)} aria-selected={filter === item.key}
              className={`inline-flex h-10 items-center rounded-full px-3.5 text-[13px] ${filter === item.key ? "bg-bg-card font-medium text-fg shadow-[0_1px_4px_rgba(0,0,0,0.08)]" : "text-fg-3"}`}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="m-0 text-[14px] text-fg-2">아직 감지된 업데이트가 없습니다. GitHub 릴리스가 나오면 여기에 보입니다.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col border-t border-line p-0">
          {rows.map((update) => {
            const sourceUrl = safeExternalUrl(update.canonicalUrl);
            const date = update.publishedAt ?? update.observedAt;
            return (
              <li key={update.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-line py-[9px]">
                <time dateTime={date.toISOString()} title={formatDate(date)} className="text-[13px] text-fg-3 tabular-nums">{monthDay(date)}</time>
                {sourceUrl
                  ? <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="truncate text-[13px] text-fg">{update.title}</a>
                  : <span className="truncate text-[13px] text-fg">{update.title}</span>}
                <span className="whitespace-nowrap text-[13px] text-fg-3">{update.sourceKind === "github_release" ? "GitHub 릴리스" : update.sourceLabel}{sourceUrl ? " ↗" : ""}</span>
              </li>
            );
          })}
        </ol>
      )}
      {visible.length > FIRST && (
        <button type="button" onClick={() => setExpanded((value) => !value)} className="inline-flex min-h-11 items-center self-start text-[13px] text-accent">
          {expanded ? "접기" : `${visible.length.toLocaleString("ko-KR")}건 모두 보기 ›`}
        </button>
      )}
    </section>
  );
}
```

- [ ] **Step 4: 확인·커밋**

```bash
npm test -- tests/product-detail-components.test.tsx
git add components/product-detail/UpdateTimeline.tsx tests/product-detail-components.test.tsx
git commit -m "feat(detail): one-line update rows, eight first, count in the heading"
```

### Task 17: 오른쪽 열 — 정보·미리보기·근거

**Files:**
- Create: `components/product-detail/InfoCard.tsx`, `EvidenceCard.tsx`, `PreviewFigure.tsx`
- Delete: `components/product-detail/ProductFacts.tsx`, `RepositoryEvidence.tsx`, `FreshnessPanel.tsx`, `EvidenceSummary.tsx`, `ProductGallery.tsx`
- Test: `tests/product-detail-components.test.tsx` ("renders objective facts, repository evidence, both conflicting licenses, agents, and skills", "renders compact evidence and freshness empty states…", "uses only internal mirrored gallery URLs…", "keeps source badges explicit…")

- [ ] **Step 1: 테스트 기대값**

- "renders objective facts…" → `InfoCard` 렌더에서 `@PostHog`(또는 픽스처 소유자)·`저장소`·`서비스 연결`·`분야`·`이용 방식`·`기술 스택`·`마지막 확인` 레이블이 있는지. 라이선스 충돌은 Task 14 의 `FactsStrip` 가 맡으므로 그 기대는 그쪽 케이스로 옮긴다(`두 값을 모두 확인하세요`).
- "renders compact evidence and freshness empty states…" → `EvidenceCard` 가 `공식 출처 0`·`메이커 제공 0` 과 `확인 필요 n`(freshness 문제 수) 를 내는지; 출처가 없으면 `연결된 외부 출처가 없습니다`.
- "uses only internal mirrored gallery URLs…" → `PreviewFigure` 로: `media` 가 있으면 첫 장(내부 `/api/media/` 주소만), 없고 `ogImage` 가 넓은 이미지(`thumbnailPresentation().identity === false`)면 그것, 아이콘뿐이면 `""`(아무것도 안 그림).
- "keeps source badges explicit and every touched visible font at least 13px" → 렌더 대상 목록을 새 컴포넌트들로 바꾸고 `text-[12px]` 가 `aria-hidden`/캡션 외에는 없는지 그대로 확인.

- [ ] **Step 2: 실패 확인** → FAIL.

- [ ] **Step 3: 구현**

```tsx
// components/product-detail/InfoCard.tsx
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { categoryLabel } from "@/lib/domain/products/labels";
import { githubOwnerFromRepositoryUrl } from "@/lib/domain/products/github-owner";
import { formatDate, safeExternalUrl } from "./format";

const RELATIONSHIP = {
  bidirectional: "서비스 ↔ 저장소 연결 확인", site_link: "서비스 → 저장소 링크 확인", repository_link: "저장소 → 서비스 링크 확인",
  maker_reported: "메이커 제공 · 관계 미확인", disconnected: "연결 끊김",
} as const;

function Row({ label, children, sub }: { label: string; children: React.ReactNode; sub?: string }) {
  return (
    <div className="flex justify-between gap-4 border-t border-[#e0e0e5] py-2.5 text-[13px]">
      <dt className="text-fg-3">{label}</dt>
      <dd className="m-0 text-right font-medium text-fg">{children}{sub && <span className="block text-[13px] font-normal text-fg-3">{sub}</span>}</dd>
    </div>
  );
}

/** 정보 카드 하나 — 객관적 정보·저장소 사실·갱신 상태에 흩어졌던 것을 여덟 줄로 */
export function InfoCard({ product, repository, freshness, unclaimed }: {
  product: ProductDetailView["product"];
  repository: ProductDetailView["repository"];
  freshness: ProductDetailView["freshness"];
  unclaimed: boolean;
}) {
  const facts = repository?.facts ?? null;
  const owner = githubOwnerFromRepositoryUrl(product.repoUrl);
  const repoUrl = safeExternalUrl(facts?.repositoryUrl ?? product.repoUrl ?? null);
  const site = product.accessMode === "installable" ? null : safeExternalUrl(product.url);
  const lastChecked = freshness.map((item) => item.lastSuccessAt).filter((at): at is Date => at !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const displayUrl = product.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

  return (
    <section aria-labelledby="info-title" className="rounded-[18px] bg-bg-soft px-5 pb-1.5 pt-[18px]">
      <h2 id="info-title" className="m-0 mb-0.5 text-[13px] font-semibold tracking-[0.02em] text-fg-3">정보</h2>
      <dl className="m-0">
        {owner
          ? <Row label="운영 주체" sub="GitHub 저장소 소유자"><a href={owner.profileUrl} target="_blank" rel="noopener noreferrer">@{owner.login} ↗</a></Row>
          : product.makerName && <Row label="메이커" sub={unclaimed ? "우리 추정" : "신고값"}>{product.makerName}</Row>}
        {site && <Row label="웹사이트"><a href={`/go/${product.slug}`} target="_blank" rel="nofollow noopener noreferrer">{displayUrl} ↗</a></Row>}
        {repoUrl && <Row label="저장소" sub={facts ? `${facts.public === false ? "비공개" : "공개"} · ${facts.archived ? "보관됨" : facts.fork ? "fork" : "활성"}` : undefined}><a href={repoUrl} target="_blank" rel="noopener noreferrer">{facts?.repositoryKey ?? "열기"} ↗</a></Row>}
        {!site && <Row label="웹사이트"><span className="font-normal text-fg-3">없음 · 저장소가 제품 페이지</span></Row>}
        {facts?.relationshipState && <Row label="서비스 연결">{RELATIONSHIP[facts.relationshipState]}</Row>}
        <Row label="분야">{categoryLabel(product.category)}</Row>
        <Row label="이용 방식">{product.accessMode === "installable" ? "직접 설치" : "웹사이트"}</Row>
        {product.stack.length > 0 && <Row label="기술 스택">{product.stack.join(" · ")}</Row>}
        <Row label="마지막 확인" sub={[repository ? "GitHub" : null, site ? "공개 페이지" : null].filter(Boolean).join(" · ") || undefined}>{lastChecked ? formatDate(lastChecked) : "확인 전"}</Row>
      </dl>
    </section>
  );
}
```

```tsx
// components/product-detail/EvidenceCard.tsx
import type { ProductDetailView } from "@/lib/domain/products/detail-view";

/** 근거 — 출처 종류별 개수와 갱신 문제 수. 소유자 ≠ 제작자 주의 문구 */
export function EvidenceCard({ links, freshness, unclaimed }: {
  links: ProductDetailView["links"];
  freshness: ProductDetailView["freshness"];
  unclaimed: boolean;
}) {
  const count = (label: string) => links.filter((link) => link.evidenceLabel === label).length;
  const problems = freshness.filter((item) => item.state === "failed" || item.state === "stale" || item.state === "disconnected").length;
  const chips = [
    ["GitHub에서 확인", count("출처 응답 확인·관계 미확인") + count("공식 출처에서 확인")],
    ["공식 출처", count("공식 출처에서 확인")],
    ["메이커 제공", count("메이커 제공·미검증")],
  ] as const;
  return (
    <section aria-labelledby="evidence-title" className="rounded-[18px] bg-bg-soft px-5 py-[18px]">
      <h2 id="evidence-title" className="m-0 text-[13px] font-semibold tracking-[0.02em] text-fg-3">근거</h2>
      {links.length === 0 && freshness.length === 0 ? (
        <p className="m-0 mt-2.5 text-[13px] leading-[1.5] text-fg-3">연결된 외부 출처가 없습니다.</p>
      ) : (
        <ul className="m-0 mt-2.5 flex list-none flex-wrap gap-1.5 p-0">
          {chips.map(([label, n]) => <li key={label} className="rounded-full bg-bg-card px-[11px] py-1.5 text-[13px] font-medium tabular-nums">{label} <span className="text-fg-3">{n}</span></li>)}
          {problems > 0 && <li className="rounded-full border border-down/30 bg-down/5 px-[11px] py-1.5 text-[13px] font-medium text-down">확인 필요 {problems}</li>}
        </ul>
      )}
      {unclaimed && <p className="m-0 mt-2.5 text-[13px] leading-[1.5] text-fg-3">저장소를 소유한 공개 계정입니다. 저장소 소유자와 실제 제작자가 다를 수 있습니다.</p>}
    </section>
  );
}
```

```tsx
// components/product-detail/PreviewFigure.tsx
/* eslint-disable @next/next/no-img-element -- 검증 후 내부에 보관한 이미지를 저장 치수 그대로 제공한다. */
import type { ProductDetailView } from "@/lib/domain/products/detail-view";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
import { formatDate } from "./format";

/** 넓은 이미지가 있을 때만 — 오른쪽 열에 작게. 아이콘뿐이면(54%) 아무것도 그리지 않는다 */
export function PreviewFigure({ product, media }: { product: ProductDetailView["product"]; media: ProductDetailView["media"] }) {
  const first = media[0] ?? null;
  const safeIcon = product.ogImage?.startsWith("/") ? product.ogImage : null;
  const thumbnail = safeIcon ? thumbnailPresentation(safeIcon) : null;
  const wide = !first && thumbnail && !thumbnail.identity ? { src: safeIcon!, width: thumbnail.width, height: thumbnail.height, caption: thumbnail.label, at: null as Date | null } : null;
  const shown = first ? { src: first.src, width: first.width, height: first.height, caption: first.altText || `${product.name} 제품 화면`, at: first.lastSuccessAt } : wide;
  if (!shown) return null;
  return (
    <figure className="m-0 flex flex-col gap-2 rounded-[18px] bg-bg-soft p-3 pb-2.5">
      <img src={shown.src} width={shown.width} height={shown.height} alt={shown.caption} loading="lazy" className="h-auto w-full rounded-[10px] object-cover" style={{ aspectRatio: `${shown.width} / ${shown.height}` }} />
      <figcaption className="flex justify-between gap-2 text-[13px] text-fg-3"><span>{shown.caption}</span>{shown.at && <span>사본 갱신 {formatDate(shown.at)}</span>}</figcaption>
    </figure>
  );
}
```

`ProductFacts.tsx`·`RepositoryEvidence.tsx`·`FreshnessPanel.tsx`·`EvidenceSummary.tsx`·`ProductGallery.tsx` 는 `git rm`. `tests/repository-release.test.tsx` 가 `RepositoryEvidence` 를 렌더하면 `FactsStrip` 의 최신 release 칸으로 기대값을 옮긴다(태그·날짜·링크).

- [ ] **Step 4: 확인·커밋**

```bash
npm test -- tests/product-detail-components.test.tsx tests/repository-release.test.tsx
git add components/product-detail tests/product-detail-components.test.tsx tests/repository-release.test.tsx
git commit -m "feat(detail): one info card, evidence counts and a small preview replace five evidence panels"
```

### Task 18: 상세 조립과 같은 분야 추천

**Files:**
- Modify: `app/p/[slug]/page.tsx`
- Create: `components/product-detail/RelatedRow.tsx`
- Test: `tests/product-detail-components.test.tsx` ("composes the dynamic page from the safe detail model in the mobile reading order")

- [ ] **Step 1: 테스트 기대값** — 읽기 순서를 새 구성으로: `히어로 → 핵심 사실 → 무엇으로 만들었나 → 소개 → 언어 → 업데이트 → 정보 → 근거 → 운영자 → 같은 분야`. 기존 케이스가 `indexOf` 로 순서를 재면 그 문자열 목록을 `["지금 뜨는"/이름, "최근 push", "무엇으로 만들었나", "소개", "업데이트", "정보", "근거", "이 프로젝트의 운영자인가요", "에서 지금 뜨는"]` 로 바꾼다.

- [ ] **Step 2: 실패 확인** → FAIL.

- [ ] **Step 3: 구현**

```tsx
// components/product-detail/RelatedRow.tsx
import { CompactRow } from "@/components/home/CompactRow";
import { categoryLabel } from "@/lib/domain/products/labels";
import type { ProductListItem } from "@/lib/domain/products/view";

/** 상세 끝 — 같은 분야에서 지금 뜨는. 홈의 가로 띠와 같은 부품 */
export function RelatedRow({ category, items, total }: { category: string; items: ProductListItem[]; total: number | null }) {
  return (
    <CompactRow id="related" title={`${categoryLabel(category)} 분야에서 지금 뜨는`} note="마지막 확인 사이 GitHub 스타가 늘어난 순 · 스타 2천 미만"
      more={{ href: `/?category=${encodeURIComponent(category)}&sort=recent`, label: total === null ? "모두 보기" : `${categoryLabel(category)} ${total.toLocaleString("ko-KR")}개 모두 보기` }}
      items={items} trailing="category" />
  );
}
```

`app/p/[slug]/page.tsx` 의 `ProductPage` 반환부:

```tsx
  const languages = (detail.repository?.facts?.languages ?? []).slice(0, 2).map((item) => item.name);
  const categoryTotal = await countProducts({ statuses: ["verified", "seeded"], excludeDown: true, category: detail.product.category as Category }).catch(() => null);

  return (
    <main className="wrap pb-14">
      <nav aria-label="경로" className="flex items-center gap-2 pt-4 text-[13px] text-fg-3">
        <Link href="/" className="hover:text-fg">발견하기</Link><span aria-hidden>›</span>
        <Link href={`/?category=${encodeURIComponent(detail.product.category)}&sort=recent`} className="hover:text-fg">{categoryLabel(detail.product.category)}</Link><span aria-hidden>›</span>
        <span className="text-fg">{detail.product.name}</span>
      </nav>

      <ProductHero product={detail.product} unclaimed={detail.unclaimed} risingRank={detail.risingRank} health={detail.health} languages={languages} />

      <div className="flex flex-wrap items-start gap-x-12 gap-y-9 pt-7">
        <div className="flex min-w-0 flex-[2_1_560px] flex-col gap-9">
          <FactsStrip product={detail.product} repository={detail.repository} license={detail.license} health={detail.health} visits={detail.visits} />
          <BuildTools product={detail.product} unclaimed={detail.unclaimed} agents={detail.agents} observedAgentFacts={detail.observedAgentFacts} skills={detail.skills} toolScan={detail.toolScan} />
          <IntroSection product={detail.product} profile={detail.profile} readmeExcerpt={detail.readmeExcerpt} unclaimed={detail.unclaimed} />
          <LanguageBar repository={detail.repository} />
          <UpdateTimeline updates={detail.updates} />
        </div>
        <aside id="evidence" className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
          <InfoCard product={detail.product} repository={detail.repository} freshness={detail.freshness} unclaimed={detail.unclaimed} />
          <PreviewFigure product={detail.product} media={detail.media} />
          <EvidenceCard links={detail.links} freshness={detail.freshness} unclaimed={detail.unclaimed} />
          {detail.unclaimed && <UnclaimedOwnerContact repoUrl={detail.product.repoUrl} slug={detail.product.slug} installable={detail.product.accessMode === "installable"} />}
          {detail.product.status === "unverified" && (…기존 그대로…)}
        </aside>
      </div>

      <RelatedRow category={detail.product.category} items={detail.related} total={categoryTotal} />
    </main>
  );
```

import 정리: 지운 컴포넌트 import 제거, `FactsStrip`·`BuildTools`·`IntroSection`·`LanguageBar`·`InfoCard`·`EvidenceCard`·`PreviewFigure`·`RelatedRow`·`countProducts`(`@/lib/domain/products/repository`)·`categoryLabel`·`type Category` 추가. `main` 이 `.wrap` 을 쓰므로 홈과 같은 1120px 폭이다(상세의 `max-w-[1220px]` 는 버린다). `UnclaimedOwnerContact` 는 제목·본문 글자를 `text-[14px]`/`text-[13px]`, 바탕을 `rounded-[18px] border border-line` 로만 맞춘다.

- [ ] **Step 4: 눈으로 확인** — `npm run dev` 후 `/p/madeira`(설치형, 소개 한 줄)·`/p/posthog`(웹, README·업데이트 많음)·프로필이 있는 제품 하나(`/admin` 에서 `product_profiles` 가 있는 slug 를 찾는다). 390 폭에서 오른쪽 열이 아래로 내려가고 가로 스크롤이 없는지.

- [ ] **Step 5: 전체 검사·커밋**

```bash
npm run lint && npx tsc --noEmit && npm test
git add app/p/[slug]/page.tsx components/product-detail/RelatedRow.tsx components/product-detail/UnclaimedOwnerContact.tsx tests/product-detail-components.test.tsx
git commit -m "feat(detail): v5 composition — facts, tools, intro, languages, updates; info and evidence aside; related row"
```

### Task 19: 상세 e2e 갱신

**Files:**
- Modify: `tests/e2e/product-detail.spec.ts`

- [ ] **Step 1: 바뀐 문구로** — `Copy Prompt · 설치 도움받기` → `설치 프롬프트 복사`, `프롬프트 복사됨 ✓` → `복사됨 ✓`; "rich desktop profile shows objective evidence…" 는 `정보`·`근거`·`무엇으로 만들었나`·`최근 push` 가 보이는지와 외부 provider 요청이 없는지로; "mobile profile keeps the approved reading order…" 는 Task 18 의 순서 목록으로; "collecting, stale-conflict, and unclaimed states remain explicit" 는 `유효 방문` 칸이 없는지(collecting)·`두 값을 모두 확인하세요`(라이선스 충돌)·`미클레임` 글자가 메타 줄에 있는지로.

- [ ] **Step 2: 실행** — `npm run test:e2e -- tests/e2e/product-detail.spec.ts tests/e2e/home-redesign.spec.ts` → PASS.

- [ ] **Step 3: 커밋 후 PR 3**

```bash
git add tests/e2e/product-detail.spec.ts
git commit -m "test(e2e): detail expectations for the v5 layout"
```

PR 제목 `feat(detail): v5 redesign — facts first, no hero image, tools and related`.

---

## PR 4 — 운영 확인 (코드 아닌 절차)

### Task 20: 배포 전 측정

- [ ] **Step 1: 홈 쿼리 비용** — 프로드 읽기 전용(`ssh jr@100.99.209.55 'sudo -n -u postgres psql -X -d nomorevibe'`)에서 `EXPLAIN (ANALYZE, BUFFERS)` 로 셋을 잰다: ① 급상승 상위 5(`listProducts` 가 내는 SQL — 로컬에서 `DEBUG=drizzle:query` 로 뽑는다) ② `getNewThisWeek` ③ `home-pulse.ts loadTools` 의 두 쿼리. 기준: ①②는 50ms 아래, ③은 2초 아래(60초 캐시가 가린다). ③이 2초를 넘으면 `getHomePulse` 안에서 `tools` 만 따로 1시간 캐시(`cachedTools: { key, expiresAt, value }`)로 분리하는 커밋을 PR 4 에 넣는다.
- [ ] **Step 2: 상세 쿼리 비용** — `getRisingRank` 와 `getRelatedRising` 을 같은 방법으로. 각각 30ms 아래.

### Task 21: 배포와 설정

- [ ] **Step 1: 배포** — 사용자 승인 후 `.claude/prod.sh` 로 web-m3 → web-mini 순서(마이그레이션 없음, 스케줄러·워커 재배포 불필요). 메모리 `prod-deploy-helper` 참고.
- [ ] **Step 2: 확인** — `https://nomorevibe.brut.bot/` 1280 폭에서 첫 화면에 "지금 뜨는 프로젝트" 다섯 장, `/p/posthog` 에서 업데이트 8줄과 "179건 모두 보기", `/p/madeira` 에서 "아직 저장소를 확인하지 않았습니다", `/popular` 정상.
- [ ] **Step 3: 제작 도구 흔적 표시** — 홈 "무엇으로 만들었나"와 상세 흔적 알약은 관리자 수집 설정 `agentEvidence.displayObservedFacts` 가 켜져야 보인다(지금 프로드는 꺼져 있다 — 2026-10-02 홈에 제작 도구 보드가 없던 이유). 켤지는 사용자가 정한다; 켜면 Task 20 ③의 쿼리가 요청 경로에 들어온다.
- [ ] **Step 4: 하루 뒤 재확인** — `home.list_failed`·`home.pulse_unavailable` 로그 0건, 홈 TTFB(검색 없는 첫 요청) 1.2초 아래(`scratchpad/page-timing2.py` 와 같은 방법).

### Task 22: 정리

- [ ] `components/home/icons.tsx` 에서 쓰지 않게 된 아이콘(`info`, `sparkles`, `news`, `up`, `arrow-right`) 제거, `app/home.css` 에 남은 미사용 셀렉터를 `rg -o '\.[a-z][a-z0-9-]*' app/home.css | sort -u` 로 뽑아 `rg -l` 로 참조를 확인하며 지운다.
- [ ] `README.md` 의 홈 화면 설명과 `docs/operations/independent-workers-runbook.md` 의 "홈 집계" 절이 상단 띠를 언급하면 고친다.
- [ ] 메모리/운영 문서에 남길 것: 토큰 값, 급상승 띠와 피드 offset 규칙, 제작 도구 구획의 설정 의존.

---

## 자기 검토

- **시안 대비 빠진 것**: 홈 "더 보기(분야)" 알약은 모든 분야를 한 줄에 다 보이는 방식으로 대체(Task 9). 시안의 도구 알약은 필터로 안 이어진다(Task 9 주석) — 흔적으로 거르는 조회는 별도 과제. 홈 5차의 피드 카드 6장은 실제로는 `HOME_FIRST_PAGE`(9장) 그대로.
- **데이터 없음 처리**: 급상승이 비면 띠 자체가 안 나온다(`CompactRow` null), 새로 나온 것도 같음, 도구 집계 null 이면 구획 없음, 업데이트 0건은 한 줄, README 없으면 한 줄 안내, 넓은 이미지 없으면 미리보기 없음.
- **타입 일관성**: `ProductDetailView.risingRank: number | null`, `related: ProductListItem[]`, `readmeExcerpt: string | null`, `toolScan: "none" | "scanned"` — Task 4·13·15·18 에서 같은 이름. `BrowseOptions.offset`·`listedSince`·`minStars` — Task 1·10. `ProjectTile({ slug, name, ogImage, size: 64 | 44, installable })` — Task 7·8·13(히어로는 `ProductIcon` 직접 사용).
- **테스트 영향 목록**: `ui-contract`(토큰·상세 클래스), `home-project-card`, `home-slots`, `home-pulse`(컴포넌트 케이스 삭제), `home-unclaimed`(조립), `product-detail-components`(대부분), `repository-release`, e2e `home-redesign`·`product-detail`. `home-sort`·`catalog-search`·`popular-projects` 는 그대로 통과해야 한다.
