# Evidence Product Detail UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved light, evidence-based `/p/[slug]` experience, maker/edit-token APIs, evidence administration, and `/nomorevibe` commands while preserving a strict 13 px minimum font and deferring comments/authentication to phase two.

**Architecture:** A cached server-only detail read model loads the product identity first, then starts independent PostgreSQL reads together; page requests never call external providers. Small server components render evidence states, while only gallery selection and update filtering use client state. Maker writes use resource-specific edit-token routes; administrator server actions re-authenticate before every read-changing action. Playwright locks the approved desktop/mobile visual and accessibility contract.

**Tech Stack:** Next.js 16 App Router, React 19 Server Components, TypeScript, Tailwind CSS 4, PostgreSQL/Drizzle, React Markdown, remark-gfm, rehype-sanitize, Vitest, Playwright

---

## Scope and dependency

This is plan 3 of 3. Start only after the unique-visit ranking and product-evidence pipeline plans pass their full matrices.

This plan ships phase one only. It must not create a comments table, comment API, login button, reactions, follows, or a partial GitHub-only end-user auth flow. The approved nested-comments/auth contract remains in `docs/superpowers/specs/2026-08-19-evidence-product-detail-design.md` for phase two.

## Task 1: Prepare rendering and browser-test dependencies

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `playwright.config.ts`
- Create: `tests/e2e/fixtures/product-detail.ts`

- [ ] Before code changes, read these repository-installed Next.js 16 guides completely:

```sh
sed -n '1,260p' node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
sed -n '1,360p' node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md
sed -n '1,680p' node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md
sed -n '1,300p' node_modules/next/dist/docs/01-app/01-getting-started/12-images.md
```

Record any changed guidance in `docs/CODEX_HANDOFF.md` before implementation.

- [ ] Install dependencies through npm:

```sh
npm install react-markdown remark-gfm rehype-sanitize
npm install --save-dev @playwright/test
npx playwright install chromium
```

- [ ] Add scripts:

```json
{
  "test:e2e": "playwright test",
  "test:e2e:product": "playwright test tests/e2e/product-detail.spec.ts"
}
```

- [ ] Configure one Chromium worker and a fixed test port. The web server must use the integration PostgreSQL URL and an explicit fixture secret; it must not use production credentials. Seed one rich, one empty/collecting, one stale/conflict, and one unclaimed product fixture.

- [ ] Run `npx playwright test --list` and confirm it exits successfully with no browser test yet.

- [ ] Commit: `test: prepare product detail browser coverage`

## Task 2: Add authenticated maker resource APIs

**Files:**

- Create: `lib/domain/products/maker-auth.ts`
- Modify: `lib/domain/products/manage.ts`
- Create: `lib/domain/evidence/maker.ts`
- Create: `app/api/products/[slug]/profile/route.ts`
- Create: `app/api/products/[slug]/links/route.ts`
- Create: `app/api/products/[slug]/media/route.ts`
- Create: `app/api/products/[slug]/provenance/route.ts`
- Create: `app/api/products/[slug]/updates/route.ts`
- Create: `app/api/products/[slug]/updates/[id]/route.ts`
- Create: `app/api/products/[slug]/refresh/route.ts`
- Create: `tests/maker-evidence-routes.test.ts`
- Create: `tests/integration/maker-evidence-api.test.ts`

- [ ] Write RED tests proving every route rejects a missing/wrong edit token, rejects banned products, validates before writing, rate-limits mutation paths, returns no token/provider raw body, and preserves observed facts.

- [ ] Extract the existing edit-token authorization into a reusable server-only helper without changing legacy PATCH/DELETE behavior:

```ts
export async function authorizeMaker(
  slug: string,
  credentials: Credentials,
): Promise<Result<Product>>;
```

- [ ] Implement resource routes with async `params` and `withRoute`:

```text
PUT    /api/products/:slug/profile
PUT    /api/products/:slug/links
PUT    /api/products/:slug/media          external image/video declarations only
PUT    /api/products/:slug/provenance
POST   /api/products/:slug/updates
PATCH  /api/products/:slug/updates/:id
DELETE /api/products/:slug/updates/:id    tombstone, not physical delete
POST   /api/products/:slug/refresh         mark all declared sources due
```

Use `X-Edit-Token` and per-IP plus per-product rate-limit keys. The request body is capped before JSON parsing where appropriate.

- [ ] Make profile/link/media/provenance replacement transactional and audited. A domain-verified maker may author data, but every public maker-only field remains labelled `메이커 제공` or `메이커 제공·미검증` unless an independent observation supports it.

- [ ] Maker updates may change title/summary/source URL and set `editedAt`; delete sets `makerDeletedAt` and leaves a tombstone. Automatic updates must return forbidden from these routes.

- [ ] Media declarations enqueue or mark the relevant source due for the evidence job. The request must never synchronously mirror a remote image.

- [ ] The maker refresh route only sets the product's source rows to due and records an audit event;
  it does not perform provider I/O in the request. Rate-limit it to one accepted request per product
  per hour and return `{ queued: true }`.

- [ ] Run route unit and integration targets plus existing lifecycle tests; expect PASS.

- [ ] Commit: `feat: let makers manage product evidence`

## Task 3: Add evidence administration and audited controls

**Files:**

- Modify: `app/admin/AdminNav.tsx`
- Modify: `app/admin/products/page.tsx`
- Modify: `app/admin/products/ProductRow.tsx`
- Create: `app/admin/products/[slug]/page.tsx`
- Create: `app/admin/products/[slug]/actions.ts`
- Create: `app/admin/evidence/page.tsx`
- Create: `app/admin/evidence/EvidenceSettingsForm.tsx`
- Create: `app/admin/evidence/actions.ts`
- Modify: `app/admin/status/page.tsx`
- Create: `tests/admin-evidence.test.ts`
- Create: `tests/evidence-admin-components.test.ts`
- Create: `tests/integration/evidence-admin.test.ts`

- [ ] Add RED tests that logged-out pages redirect before evidence reads and logged-out server actions never refresh, hide, restore, or save settings.

- [ ] Add `/admin/evidence` for bounded cadence, stale interval, retry, batch, and activity-digest settings. Parse controlled numeric input with NaN-safe helpers and show Zod issues through `aria-live`.

- [ ] Add `/admin/products/[slug]` with:

  - source freshness, last success/attempt/error, and next due time;
  - maker versus observed license and other conflicts;
  - repository relationship evidence;
  - media source/version state;
  - automatic and maker update visibility;
  - provenance evidence level;
  - immutable audit history.

- [ ] Implement authenticated server actions for `forceProductRefresh`, `hideAutomaticUpdate`, `restoreAutomaticUpdate`, and `saveEvidenceSettings`. Hide requires a non-empty reason; restore writes a new audit row rather than deleting history.

- [ ] A force refresh calls `refreshProductEvidence(slug, { force: true })`, revalidates admin and public detail paths, and returns a safe count summary. It must not expose upstream bodies/errors containing secrets.

- [ ] Extend status summaries with aggregate due/stale/failed source counts and `product-evidence-refresh` age. Keep one canonical job error display rather than duplicating it in every panel.

- [ ] Run unit/integration targets and `npm run build`; confirm admin routes remain dynamic and protected.

- [ ] Commit: `feat: administer product evidence`

## Task 4: Build one server-only detail read model

**Files:**

- Create: `lib/domain/products/detail-view.ts`
- Create: `tests/integration/product-detail-view.test.ts`

- [ ] Write RED integration cases for rich, empty/collecting, stale, disconnected, conflict, no-license, unclaimed, banned, and missing products.

- [ ] Define the public read contract with source and absence states represented explicitly:

```ts
export type ProductDetailView = {
  product: Product;
  unclaimed: boolean;
  rank: { seasonKey: string; rank: number; scoreMode: "valid_visits" | "unique_visitors" } | null;
  visits: VisitMetrics;
  health: { uptime30d: number | null; latencyMs: number | null; checkedAt: Date | null; down: boolean };
  profile: MakerProfileView | null;
  links: ProductLinkView[];
  repository: RepositoryEvidenceView | null;
  license: LicensePresentation;
  media: ProductMediaView[];
  updates: ProductUpdateView[];
  agents: AgentView[];
  skills: SkillView[];
  freshness: FreshnessView[];
};
```

- [ ] Use `cache()` for the initial product identity lookup shared by metadata and page rendering. After the product is known, start all independent reads in one `Promise.all`; do not fetch product-by-product, source-by-source, or update-by-update.

```ts
const product = await getProductIdentity(slug);
if (!product || product.status === "banned") return null;
const [rank, visits, health, profile, links, repository, media, updates, provenance] =
  await Promise.all([
    getActiveRankForProduct(slug),
    visitMetrics([slug]),
    healthMetrics([slug], 30),
    getMakerProfile(slug),
    listProductLinks(slug),
    getRepositoryEvidence(slug),
    listProductMedia(slug),
    listVisibleProductUpdates(slug),
    getProductProvenance(slug),
  ]);
```

- [ ] Use recent seven-day values for the product-page visit cards and label the period. The hero rank uses the active stored season rank. Do not call external URLs or provider APIs during rendering.

- [ ] Resolve license presentation without erasing either source:

  - same maker/observed value: strongest evidence label;
  - different values: `정보 충돌` with both;
  - maker only: `메이커 제공·미검증`;
  - observed only: provider label;
  - neither: `라이선스 확인 안 됨`.

- [ ] Derive freshness labels from settings: no observation `집계 중`, failed with last good retained, over two intervals `갱신 지연`, long-expired `오래된 정보`, disappeared `연결 끊김`.

- [ ] Run the target integration test twice and expect PASS.

- [ ] Commit: `feat: compose product detail read model`

## Task 5: Implement the approved evidence product page

**Files:**

- Rewrite: `app/p/[slug]/page.tsx`
- Modify: `app/p/[slug]/TakedownForm.tsx`
- Create: `components/product-detail/ProductHero.tsx`
- Create: `components/product-detail/ProductMetrics.tsx`
- Create: `components/product-detail/EvidenceSummary.tsx`
- Create: `components/product-detail/ProductGallery.tsx`
- Create: `components/product-detail/ProductIntroduction.tsx`
- Create: `components/product-detail/ProductFacts.tsx`
- Create: `components/product-detail/RepositoryEvidence.tsx`
- Create: `components/product-detail/BuildProvenance.tsx`
- Create: `components/product-detail/FreshnessPanel.tsx`
- Create: `components/product-detail/UpdateTimeline.tsx`
- Create: `components/product-detail/SourceBadge.tsx`
- Create: `tests/product-detail-components.test.ts`
- Modify: `tests/schema.test.ts`

- [ ] Add RED static-render tests for all evidence/empty states, maker-unverified badges, license conflict, internal-only media URLs, no timeline line, source filters, rank label, and exact Korean public terminology.

- [ ] Keep metadata and `force-dynamic`, but replace direct repository reads with `getProductDetail`. The desktop order must be:

```text
breadcrumb
hero
4 metric cards
compact evidence summary
main: gallery -> introduction -> updates
aside: facts -> repository/license -> build provenance -> freshness
```

At mobile width the DOM/keyboard order must be hero, metrics, summary, gallery, introduction, facts, repository, provenance, freshness, updates. Use one DOM order with CSS grid placement; do not duplicate interactive controls.

- [ ] Hero includes icon, name, tagline, verification, category, lifecycle, current-season rank, share control, and a primary `/go/[slug]` outbound action at least 44 px high.

- [ ] Metric cards show:

  - `고유 유입자 · 최근 7일` with browser-identity tooltip or `집계 중`;
  - `유효 방문 · 최근 7일`;
  - adjacent-window `고유 유입자 변동` or `신규`;
  - `30일 가동률` plus current latency/check age.

Never label these values as total service traffic.

- [ ] Gallery serves `/api/media/<hash>` only, supplies stored width/height and descriptive alt text, prioritizes the first image, lazy-loads later images, and displays a missing-source note while keeping the last internal copy. Video uses the internal poster and links/embeds only an allowlisted canonical provider.

- [ ] Render the structured maker fields with visible source badges. Render long Markdown with `react-markdown`, `remark-gfm`, and `rehype-sanitize`; do not enable raw HTML. Configure safe link components with `rel="noopener noreferrer"` and reject unsafe schemes.

- [ ] Repository evidence includes creation/push/release dates, stars, forks, GitHub-identified contributors, public/archive state, languages, relationship status, and license wording. Add the legal caveat that detection is not legal advice or a permission warranty.

- [ ] Product facts renders App Store, Play Store, npm/PyPI/crates, documentation, support, RSS,
  changelog, repository, and pricing links when present. Each link carries its maker/observed badge,
  check state, and last observation; absent types are omitted instead of rendered as false zeroes.

- [ ] Build provenance groups maker/team, agents/roles, and skills/version/hash by evidence level. A hash is described only as byte equality evidence, not proof of authorship.

- [ ] Timeline orders `publishedAt ?? observedAt` descending, has maker/automatic/all filters, source-colored dots, no connecting pseudo-element/border, maker edited/tombstone states, and external source links. Automatic event text is not editable in public UI.

- [ ] Preserve seeded claim/takedown and unverified publication notices, restyled to the new light cards.

- [ ] Run `npx vitest run tests/product-detail-components.test.ts tests/schema.test.ts` and expect PASS.

- [ ] Commit: `feat: show evidence-based product details`

## Task 6: Make the whole UI light-first with a 13 px floor

**Files:**

- Modify: `app/globals.css`
- Modify: `app/layout.tsx`
- Modify: `components/Panel.tsx`
- Modify: `components/ProductCard.tsx`
- Modify: `components/RankingTable.tsx`
- Modify: `components/TrustBadges.tsx`
- Modify: `components/Tag.tsx`
- Modify: `components/MarketStats.tsx`
- Modify: `components/BrowseFilters.tsx`
- Modify: all remaining matching files under `app/**/*.tsx` and `components/**/*.tsx`
- Create: `tests/ui-contract.test.ts`

- [ ] Write a RED source-contract test that scans application/component TSX for Tailwind `text-xs` and arbitrary pixel sizes below 13. It must report the filename, class, and value. Exempt no visible text; icon-only SVG sizing is not font sizing.

- [ ] Change the root token set to light values unconditionally:

```css
:root {
  color-scheme: light;
  --bg: #f7f8fb;
  --bg-soft: #eef1f7;
  --bg-card: #ffffff;
  --border: #dfe4ee;
  --text: #10141c;
  --text-2: #4a5468;
  --text-3: #6b7488;
  /* existing AA-safe semantic colors */
}
```

Keep an explicit `:root[data-theme="dark"]` override for future use, but remove system preference as the public default. Add visible `:focus-visible` treatment and reduced-motion handling.

- [ ] Mechanically replace every visible `text-xs`, `text-[10px]`, `10.5`, `11`, `11.5`, `12`, and `12.5` class under `app` and `components` with at least `text-[13px]`, then review line wrapping at 390 px. Do not rely on `body { font-size }` to override more-specific utility classes.

- [ ] Apply the radius contract: standard section/Panel `12px`, hero `14px`, metric cards `10px`; reduce existing generic 14 px panels to 12 px. Pills remain fully rounded because they are badges, not sections.

- [ ] Set product prose to exactly 15 px and structured intro values plus update title/body to exactly 14 px. Keep metadata/badges/timestamps at 13 px.

- [ ] Make header/footer white/light and ensure every route, including admin, rankings, launch, and empty/error states, remains readable. Preserve `.surface-dark` only for deliberately dark content surfaces.

- [ ] Run `npx vitest run tests/ui-contract.test.ts` and all component unit tests; expect PASS.

- [ ] Commit: `style: enforce light 13px interface`

## Task 7: Extend the distributable `/nomorevibe` skill

**Files:**

- Modify: `skill/SKILL.md`
- Modify: `app/skill.md/route.ts`
- Modify: `app/install.sh/route.ts`
- Modify: `README.md`
- Create: `tests/skill-contract.test.ts`

- [ ] Add RED tests that the served skill contains the new commands, confirmation-before-write rules, edit-token storage rules, opt-in provenance boundary, media URL cap, and no prompt/log/secret upload.

- [ ] Extend command routing without breaking register/verify/delete:

```text
/nomorevibe profile
/nomorevibe links
/nomorevibe media
/nomorevibe provenance
/nomorevibe update
/nomorevibe refresh
```

- [ ] For profile/link/media/provenance/update, inspect local public project metadata, show the proposed payload and evidence labels, request user confirmation, then call the resource route with the credential-store edit token. Never place the token in `.nomorevibe.json` or project files.

- [ ] Provenance collection is opt-in. It may record executing client, user-approved agent/model/roles, selected skill namespace/name/version/hash, and current commit. It must not upload skill instructions, prompts, conversation logs, environment values, or secrets. If evidence is only self-reported, send `maker_reported`.

- [ ] Media only submits maker-controlled external image URLs and alt text; the server job copies them later. The skill must not base64-upload files in phase one.

- [ ] `refresh` calls `POST /api/products/<slug>/refresh` with the edit token, reports that collection is queued, and never claims the provider refresh has already completed. It must not expose provider credentials.

- [ ] Run the skill target, route tests, and installer smoke test; expect PASS.

- [ ] Commit: `feat: extend nomorevibe evidence skill`

## Task 8: Lock visual, responsive, accessibility, and release behavior

**Files:**

- Create: `tests/e2e/product-detail.spec.ts`
- Modify: `README.md`
- Modify: `PENDING.md`
- Modify: `docs/CODEX_HANDOFF.md`

- [ ] Add Playwright tests at 1440 px and 390 px for rich, collecting, stale/conflict, and unclaimed fixtures.

- [ ] In the browser, compute and assert:

```ts
const sizes = await page.locator("body *").evaluateAll((elements) =>
  elements.filter((el) => el.textContent?.trim()).map((el) => parseFloat(getComputedStyle(el).fontSize))
);
expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13);
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
```

Also assert product prose is 15 px, structured/update copy is 14 px, section radius is 12 px, hero radius is 14 px, metric radius is 10 px, the root color scheme is light, and no timeline connector exists in computed borders/pseudo-elements.

- [ ] Test keyboard navigation, visible focus, 44 px minimum primary/control targets, descriptive gallery alt text, correct mobile order, source filters, internal media requests, and no page/console errors. Run an automated contrast calculation for normal text against its effective background and require WCAG AA.

- [ ] Verify product pages issue no external provider network requests during navigation. Only internal media and normal application assets may load.

- [ ] Run the exact final matrix:

```sh
npx next typegen
npx tsc --noEmit
npm test
npm run test:integration
npm run test:e2e:product
npm run lint
npm run build
git diff --check
```

- [ ] Run an independent complete-diff review and fix actionable P1/P2 findings through RED regression tests.

- [ ] Update `README.md` with public definitions and maker commands. Keep production provider tokens, evidence scheduler registration, `VISITOR_HASH_SECRET`, and real-source smoke checks in `PENDING.md` until verified with production access.

- [ ] Update `docs/CODEX_HANDOFF.md` with every executed result, screenshots, fixture details, failed approaches, external blockers, and exact next commands. Explicitly state that comments/auth remain phase two.

- [ ] Commit: `docs: release evidence product profiles`

## Completion criteria

- `/p/[slug]` answers identity, qualified interest, activity/freshness, objective evidence, and build provenance without an opaque score.
- Maker claims are visible but explicitly unverified unless independently evidenced.
- The page serves gallery images internally and performs no provider fetching in request render.
- Updates are useful, filtered, source-labelled, and visually have no left timeline line.
- Public and admin UI default to white/light, no visible text computes below 13 px, and approved radii/type sizes hold at 390/1440 px.
- Maker evidence APIs and skill flows require edit-token authorization and confirmation.
- Comments and unified end-user authentication are absent from phase one code and remain fully deferred.
- Unit, integration, browser, lint, typecheck, and production build matrices have all been executed successfully.
