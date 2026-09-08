# Product Detail Editorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved editorial A concept to the real product detail page with a large stored product image and richer above-the-fold description.

**Architecture:** Keep the route and data fetching as a Server Component. Extend `ProductHero` to render the first safe mirrored media asset, then compose the remaining evidence components into an editorial main/sidebar grid without changing evidence semantics.

**Tech Stack:** Next.js App Router, React Server Components, TypeScript, Tailwind CSS v4, Vitest, Playwright

---

### Task 1: Lock the editorial hero contract

**Files:**
- Modify: `tests/product-detail-components.test.tsx`
- Modify: `tests/e2e/product-detail.spec.ts`

- [x] **Step 1: Write the failing component test**

Pass one internal media item to `ProductHero` and assert that the hero contains `제품 화면`, the internal
`/api/media/` URL, intrinsic width/height, the product description, and an `editorial-product-hero` marker.
Also assert that an empty media array renders `아직 보관된 제품 화면이 없습니다.`.

- [x] **Step 2: Write the failing browser geometry test**

Assert at 1440px that the representative image is at least 650px wide and wider than the product-copy
column. Keep the existing 390px overflow, contrast, keyboard, internal-image, and no-external-request checks.

- [x] **Step 3: Run tests to verify RED**

Run: `npm test -- tests/product-detail-components.test.tsx`

Expected: FAIL because `ProductHero` does not accept `media` and does not render the editorial marker.

### Task 2: Implement the large representative-media hero

**Files:**
- Modify: `components/product-detail/ProductHero.tsx`

- [x] **Step 1: Add the media prop and representative image**

Use `ProductDetailView["media"]`, select `media[0]`, and render only its internal `src` with stored width,
height, alt text, eager loading, and high fetch priority. Render the explicit empty state when it is absent.

- [x] **Step 2: Move the full product explanation above the fold**

Render `product.tagline` as the lead and `product.description` as a separate paragraph. Retain status,
rank, lifecycle, health, share, and tracked outbound visit behavior.

- [x] **Step 3: Run the component test to verify GREEN**

Run: `npm test -- tests/product-detail-components.test.tsx`

Expected: PASS.

### Task 3: Compose the editorial body

**Files:**
- Modify: `app/p/[slug]/page.tsx`
- Modify: `components/product-detail/ProductIntroduction.tsx`
- Modify: `components/product-detail/ProductMetrics.tsx`
- Modify: `components/product-detail/EvidenceSummary.tsx`

- [x] **Step 1: Pass media into the hero and remove the duplicate gallery block**

Call `<ProductHero media={detail.media} ... />`. Place metrics directly below it. Create a responsive
`lg:grid-cols-[minmax(0,1fr)_340px]` body with introduction and updates in the wide column and evidence
summary plus factual panels in the sidebar.

- [x] **Step 2: Apply editorial hierarchy**

Add a `PRODUCT STORY` kicker and larger heading to the introduction, remove the repeated base description,
and turn metrics and evidence summary into compact bordered strips while preserving all existing labels.

- [x] **Step 3: Run component and type checks**

Run: `npm test -- tests/product-detail-components.test.tsx && npx tsc --noEmit`

Expected: PASS.

### Task 4: Verify the production page

**Files:**
- Modify: `tests/e2e/product-detail.spec.ts`
- Modify: `docs/CODEX_HANDOFF.md`

- [x] **Step 1: Run the product E2E suite**

Run: `npm run test:e2e:product`

Expected: all product detail tests PASS with no console/page errors, external provider requests, contrast
failures, or horizontal overflow.

- [x] **Step 2: Inspect real Drever at desktop and mobile widths**

Capture the current local page at 1440x1000 and 390x844. Confirm the large hero media, complete copy,
source labels, no content overlap, and correct mobile order.

- [x] **Step 3: Run repository checks and update handoff**

Run: `npm run lint && npm run build && git diff --check`

Expected: PASS. Record exact commands and results in `docs/CODEX_HANDOFF.md`.
