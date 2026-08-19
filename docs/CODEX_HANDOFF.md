# Codex handoff

## Current objective

Design an evidence-based product detail page for NoMoreVibe before implementation. The functional
design and the light desktop/mobile visual direction are approved. The approved design is now
captured in:

- `docs/superpowers/specs/2026-08-19-evidence-product-detail-design.md`

No application code, schema, migration, API, scheduler, or production environment was changed in
this design phase. The next step is user review of the written specification. Only after that review
should the `writing-plans` workflow create an implementation plan.

The previously shipped seasonal ranking remains the repository baseline. Its source documents are:

- `docs/superpowers/specs/2026-08-18-weekly-ranking-design.md`
- `docs/superpowers/plans/2026-08-18-weekly-ranking-implementation.md`
- `PENDING.md`

## Completed work

- Inspected the supplied mockup at
  `/Users/jr/Desktop/projects/Saju_On/nomorevibe-mockup/v2/product.html` and the current
  `app/p/[slug]/page.tsx` implementation.
- Audited the current PostgreSQL/Drizzle model. Products currently store a short profile, optional
  builder/stack/repository, ownership state, raw accepted click timestamps, daily click aggregates,
  and only the latest health status. There are no unique-visitor hashes, product profiles, gallery,
  external facts, updates, provenance evidence, or comments.
- Reviewed current Product Hunt product/profile, engagement, first-comment, forum/update, and API
  patterns using official sources. The design adopts an ongoing product profile but not Product
  Hunt's opaque ranking formula.
- Confirmed that NoMoreVibe can objectively measure unique outbound browsers and valid outbound
  visits, not a product's total visitors without a future analytics integration.
- Defined a privacy-preserving product-scoped HMAC for new visit events; historical clicks cannot be
  converted into unique visitors.
- Approved a transparent unique-first ranking formula with capped 25% repeat-visit credit, existing
  season/cooldown behavior, a seven-day warm-up, admin preview, and next-season-only activation.
- Defined public GitHub facts, license display, App Store/Play Store/package/feed links, and explicit
  service-to-repository evidence levels.
- Defined optional agent/skill provenance with maker, repository, NoMoreVibe-recorded, and signed
  build evidence levels. Provenance is ranking-neutral and never uploads prompts or skill content by
  default.
- Defined a unified maker/automatic update timeline. It uses source badges and dots without a
  continuous left vertical line.
- Moved public comments to phase two. The future design supports authenticated authors and replies
  deeper than one level; login providers are selected once as a unified authentication project.
- Replaced external image hotlinks with an approved internal media snapshot design: bounded fetch,
  decode/re-encode, metadata removal, SHA-256 deduplication, PostgreSQL `bytea` at current scale,
  immutable versions, and up to eight visible images. Videos retain external playback but store
  their posters internally.
- Produced and iterated an interactive temporary product-detail prototype. The final approved visual
  direction is light-first, has a 13 px absolute font minimum, 15 px long prose, 14 px structured and
  update copy, reduced section radii, no update timeline line, and no horizontal overflow at 390 px.

## Modified files

Repository files changed during this design phase:

- `docs/superpowers/specs/2026-08-19-evidence-product-detail-design.md` (new)
- `docs/CODEX_HANDOFF.md` (updated)

Temporary visual artifacts outside the repository:

- `/private/tmp/nomorevibe-product-detail-v3.html`
- `/private/tmp/nomorevibe-product-detail-v3-desktop.png`
- `/private/tmp/nomorevibe-product-detail-v3-mobile.png`

No production source file is modified.

## Key design decisions

- PostgreSQL 17, Drizzle ORM, postgres.js, and Drizzle Kit remain the persistence stack.
- No opaque public `NMR Score`; raw metrics, sources, evidence state, and observation times are shown.
- `고유 유입자` means distinct first-party browser identifiers sent through NoMoreVibe, with a
  methodology tooltip that it is not a verified human or total-product-traffic count.
- New accepted visit events store only
  `HMAC-SHA256(VISITOR_HASH_SECRET, slug + "\0" + visitorCookieValue)`. Raw cookies, IP addresses,
  and user agents are not persisted with visits. The existing 35-day raw retention remains.
- Current click-based seasons are immutable. After seven days of collection, a scheduled revision
  can apply the unique-first formula at the next boundary; historical pages keep their stored labels
  and formula.
- Main score uses unique visitors plus at most one extra valid visit per unique visitor at 25%
  weight, then the existing soft cooldown. GitHub/community/provenance facts do not affect rank.
- Maker-provided but unverified links remain visible with `메이커 제공·미검증` rather than being
  hidden.
- Maker claims and observed facts are separate records. Conflicts show both values and sources.
- GitHub facts use authenticated API calls, conditional requests, caching, and last-known-good
  preservation. Google Play phase one verifies public link/package availability only.
- Images are served from immutable internal copies, not mutable source URLs. Missing source images
  remain visible with a disconnected-source state until retention/takedown policy removes them.
- Automatic update events are immutable and idempotent. Admins hide/restore with reasons; maker
  updates expose edits and leave deletion tombstones.
- The public shell and detail page are light-first. Minimum computed text is 13 px; long prose is
  15 px and update/structured copy is 14 px. Standard panel radius is 12 px, hero 14 px, metrics
  10 px.
- Phase one maker writes continue through the edit-token `/nomorevibe` flow. General user auth,
  comments, follows, reviews, maker dashboard, direct uploads, and connected product analytics are
  phase two.

## Test commands and results

No application implementation exists for this feature, so the repository unit/integration/build
matrix was not run and is not claimed for this design-only phase.

The temporary prototype was actually rendered with:

```bash
npx playwright screenshot --browser chromium --color-scheme light \
  --viewport-size="1440,1000" --full-page \
  file:///private/tmp/nomorevibe-product-detail-v3.html \
  /private/tmp/nomorevibe-product-detail-v3-desktop.png

npx playwright screenshot --browser chromium --color-scheme light \
  --device="iPhone 13" --full-page \
  file:///private/tmp/nomorevibe-product-detail-v3.html \
  /private/tmp/nomorevibe-product-detail-v3-mobile.png
```

Both screenshot commands passed. A headless computed-style diagnostic at 1440x1000 and 390x844
reported:

```text
minimum computed font: 13px
elements below 13px: 0
product prose: 15px
structured introduction: 14px
update copy: 14px
timeline ::before display: none
standard panel radius: 12px
document horizontal overflow: false
```

Run `git diff --check` after any final documentation edits before handing off.

## Failed approaches

- The brainstorming skill referenced a `visual-companion.md` file that is not installed beside its
  `SKILL.md`. The user accepted a fallback using a local HTML prototype and browser screenshots.
- The installed `agbrowse` browser wrapper imports a missing local CLI module, so the visual work
  used Playwright's CLI/cached Chromium instead of pretending browser QA succeeded.
- The first UI recommendation search proposed a vibrant horizontal-scroll journey. That conflicts
  with the existing NoMoreVibe information architecture and the evidence/trust goal, so it was not
  applied. The final design keeps restrained purple accents and a conventional responsive profile.
- A first programmatic Playwright import failed because `playwright` is not a project dependency;
  only the `npx` CLI cache contained it. Inspection confirmed the root cause, and the read-only
  diagnostic imported that cached package directly without changing `package.json`.
- The first light prototype technically met a 13 px minimum, but its long introduction dropped to
  exactly 13 px on mobile and looked too small. The approved revision uses 15 px prose and 14 px
  structured/update copy while retaining 13 px only for metadata.
- An initial post-edit selector guard overrode intended 14 px update copy back to 13 px. Computed
  styles exposed the precedence issue; removing those prose selectors from the minimum-size guard
  produced the verified 14 px result.

## Remaining work

1. User reviews the written design spec and requests any final corrections.
2. After explicit approval, read and invoke `writing-plans`; create a task-by-task TDD implementation
   plan under `docs/superpowers/plans/`. Do not implement directly from this handoff.
3. The implementation plan must break phase one into backward-compatible migrations, visitor
   capture/rollup, ranking policy transition, external collectors, internal media, profile/update
   writes, public read model/UI, admin controls, skill/API updates, operations, and verification.
4. Before code changes, read the applicable Next.js 16 documentation under
   `node_modules/next/dist/docs/` as required by `AGENTS.md`.
5. Existing non-code blockers remain in `PENDING.md`: real category-classification verification and
   production scheduler registration. New production refresh jobs must also remain pending until
   explicit production access and authorization exist.

Comments and general user authentication are intentionally phase two, not unfinished phase-one
work.

## Exact commands for the next agent

```bash
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
git diff --check
sed -n '1,760p' docs/superpowers/specs/2026-08-19-evidence-product-detail-design.md

# Do not run this step until the user approves the written spec.
sed -n '1,400p' /Users/jr/.agents/skills/writing-plans/SKILL.md

# Before any later Next.js implementation, locate and read the relevant v16 guides.
find node_modules/next/dist/docs -type f | sort
```

Do not run production migrations, register schedulers, or add external infrastructure without the
required access and explicit authorization.
