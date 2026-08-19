# Evidence-based product detail design

Status: approved

Date: 2026-08-19

Scope: product detail profile, unique outbound visitors, external facts, media snapshots, update
timeline, AI-agent and skill provenance, and a future comments extension

## Objective

Turn `/p/<slug>` from a static registration card into a continuously maintained, evidence-based
product profile. The page must help a visitor answer four different questions without collapsing
them into one opaque score:

1. What is this product, who is it for, and how does it work?
2. How much qualified interest has NoMoreVibe sent to it?
3. Is it active, reachable, and supported by current external evidence?
4. What did the maker report, what did NoMoreVibe observe, and how was the product built?

The first version includes unique outbound visitors, valid visits, GitHub and distribution facts,
internally stored gallery images, a detailed maker profile, a unified update timeline, and
agent/skill provenance. Authentication is intentionally designed once later; comments are designed
now but implemented in phase two.

## Why click count alone is not enough

Raw clicks overweight repeated activity by a small number of browsers and do not distinguish reach
from repetition. Replacing clicks with “product visitors” would also be misleading: without the
product's analytics account, NoMoreVibe knows only the traffic that passed through its own outbound
route.

The public terms are therefore:

- **Unique outbound visitors (`고유 유입자`)**: distinct first-party browser identifiers that
  produced an accepted outbound visit for the product during the displayed period.
- **Valid visits (`유효 방문`)**: accepted `/go/<slug>` outbound events after known bot and rapid
  repeat filtering.
- **Product traffic**: never claimed unless a future, separately labelled analytics integration is
  connected by the maker.

The UI uses the short label `고유 유입자`, but its tooltip and methodology page say that it
distinguishes browsers, not verified human identities. Cookie blocking can cause under- or
over-counting, and deliberate browser impersonation is not claimed to be defeated.

Product Hunt was used as a product-pattern reference, not as a scoring formula to copy. Its current
profiles separate launches, reviews, followers, makers, media, forum activity, and related product
facts, while its ranking uses multiple engagement signals rather than a public visitor count. The
NoMoreVibe design keeps the useful ongoing-profile and maker-update patterns but makes source and
evidence levels more explicit:

- [Product Hunt launch definitions](https://www.producthunt.com/launch/definitions)
- [Product Hunt post API fields](https://api-v2-docs.producthunt.com/object/post/)
- [Product Hunt points](https://help.producthunt.com/en/articles/10275873-what-are-points)
- [Product Forums maker guide](https://help.producthunt.com/en/articles/11432379-maker-s-guide-to-product-forums)

## Approved phase boundaries

### Phase one

- Evidence-based public product detail page.
- Structured maker profile plus long-form Markdown introduction.
- Internally stored image gallery and internally stored video posters.
- Unique outbound visitor and valid-visit measurement.
- GitHub repository facts, license, languages, contributors, and releases.
- App Store, Play Store, package registry, documentation, support, RSS, and changelog links.
- Service-to-repository relationship evidence.
- Optional AI-agent, role, skill, version, and evidence records.
- Maker-authored and automatically observed update events in one timeline.
- Existing edit-token and `/nomorevibe` flow for maker changes.
- Admin collection status, immediate refresh, conflict review, and event visibility controls.
- Seven-day unique-visitor warm-up and next-season ranking transition.

### Phase two

- Unified end-user authentication, with providers selected together rather than binding comments to
  GitHub now.
- Arbitrarily nested comment replies, reactions, reports, maker badges, and moderation.
- Follows and update notifications.
- Separate ratings/reviews.
- Maker web dashboard.
- Plausible, GA, or comparable first-party product analytics integrations.
- Direct media upload after object-storage and deletion policies are selected.
- Vendor-signed AI usage receipts when interoperable providers exist.

## Information architecture

### Desktop

The page uses a maximum-width two-column layout. The main column explains the product and its
history; the narrower evidence column stays visible while the user reads.

1. Breadcrumb.
2. Hero: icon, name, tagline, verification, category, lifecycle state, current-season rank, share,
   and primary outbound visit action.
3. Four core metrics: unique outbound visitors, valid visits, unique-visitor change, and 30-day
   uptime/current latency.
4. Compact evidence summary: repository relationship, detected license, provenance evidence count,
   and overall freshness.
5. Main column:
   - internally served media gallery;
   - structured and long-form introduction;
   - unified update timeline.
6. Evidence column:
   - product facts and distribution links;
   - public repository facts and license;
   - maker, agents, roles, skills, and evidence;
   - source freshness and methodology link.

There is no synthetic `NMR Score` on the product page. Raw values and their source are more useful
than an unexplained composite.

### Mobile

The mobile order is:

1. Hero and outbound action.
2. Two-by-two core metric grid.
3. Compact evidence summary.
4. Gallery.
5. Product introduction.
6. Product facts.
7. Repository and license.
8. Maker and build provenance.
9. Data freshness.
10. Update timeline.

This places the core product identity and objective evidence before a potentially long timeline.
There is no document-level horizontal scrolling.

## Approved visual contract

- Public UI is light-first: off-white page background, white content cards, dark readable text, and
  restrained purple for actions and selected states.
- The approved product-detail screen includes a light shared header and footer. Implementation must
  make the light theme the public default rather than leaving a dark global shell around this page.
  The existing explicit dark token override may remain for a future theme control.
- The product screenshot itself may be dark; it is content, not page chrome.
- No rendered text may be smaller than `13px` at any supported viewport.
- Long product-description prose is `15px` with a generous line height.
- Structured introduction values and update titles/body copy are `14px`.
- `13px` is reserved for metadata, badges, source labels, and timestamps.
- Body copy maintains at least WCAG AA contrast. Color is never the only status indicator.
- Primary touch targets are at least `44px` high and keyboard focus is visible.
- Standard section radius is `12px`; the hero uses `14px`; metric cards use `10px`.
- The update timeline uses source-colored dots but no continuous vertical line.
- Hover states change color/border without layout shifts. Reduced-motion preferences are respected.

The approved temporary review artifacts are outside the repository:

- `/private/tmp/nomorevibe-product-detail-v3.html`
- `/private/tmp/nomorevibe-product-detail-v3-desktop.png`
- `/private/tmp/nomorevibe-product-detail-v3-mobile.png`

They were rendered at 1440 px and 390 px. Computed-style checks found a 13 px minimum, no elements
below it, and no horizontal overflow at either viewport.

## Product profile data

Maker-authored profile content is stored separately from machine-observed facts so one cannot
silently overwrite the other. The profile supports:

- problem being solved;
- target users;
- key features;
- use cases;
- pricing model and optional pricing URL;
- lifecycle status such as beta or generally available;
- supported platforms;
- privacy/data-handling summary;
- long-form Markdown description;
- maker/team attribution.

The existing short `tagline` remains the one-line summary. Markdown is sanitized to an explicit
allowlist. Raw HTML, scripts, event attributes, embedded forms, and unsafe URL schemes are rejected.

Every maker field carries `updatedAt` and is visibly labelled `메이커 제공` or
`메이커 제공·미검증` unless a stronger independent evidence rule exists. A domain-verified maker is
allowed to author the profile, but domain ownership does not make every product claim objectively
verified.

## Outbound visit measurement and privacy

The existing flow already creates a random first-party `nmv_visitor` cookie, excludes known bot and
preview user agents, and rate-limits the same visitor/product pair to one accepted event per ten
minutes. Today it discards the visitor identifier before inserting `click_events`, so historical
unique visitors cannot be reconstructed.

Phase one extends the accepted event with a nullable product-scoped pseudonymous hash:

```text
visitorHash = HMAC-SHA256(VISITOR_HASH_SECRET, slug + "\0" + visitorCookieValue)
```

Rules:

- The raw cookie value, IP address, and user agent are never inserted into the visit-event table.
- The rate-limit key also uses the product-scoped HMAC rather than persisting the raw cookie value in
  `rate_limits`.
- Including the slug prevents the database from correlating the same browser across products.
- A dedicated secret is used; it is not reused from admin authentication or edit tokens.
- The outbound redirect succeeds even when recording fails.
- Old rows without `visitorHash` remain valid historical visits but do not count as unique visitors.
- Raw accepted visit rows retain the existing 35-day limit. The longest supported competitive
  season is one month, so its unique count can be finalized before pruning.
- Daily rollups store valid visits and daily distinct visitors. They must not be summed and relabelled
  as a multi-day distinct count.
- Active-window and current-season unique counts use `count(distinct visitorHash)` over retained raw
  events. Closed-season unique totals are persisted with final ranking entries.
- Until enough new events exist, the UI shows `집계 중` and the collection start date rather than a
  misleading zero.

The first release does not fingerprint browsers and does not treat a login identity as a traffic
identity.

## Ranking transition

Three alternatives were considered: unique visitors alone, an opaque multi-signal score, and a
transparent unique-first score with capped repeat visits. The third is approved.

Default new-season score:

```text
extraVisits = min(
  max(validVisits - uniqueVisitors, 0),
  uniqueVisitors * maxExtraVisitsPerUnique
)

baseScoreUnits =
  uniqueVisitors * 10_000
  + extraVisits * repeatVisitWeightBasisPoints

scoreUnits = floor(baseScoreUnits * cooldownFactorBasisPoints / 10_000)
```

Default values:

- `maxExtraVisitsPerUnique = 1`
- `repeatVisitWeightBasisPoints = 2_500` (25%)

Examples before cooldown:

- 100 unique visitors and 150 valid visits: 112.5 equivalent points.
- 10 unique visitors and 100 valid visits: 12.5 equivalent points because repeat credit is capped.
- 80 unique visitors and 80 valid visits: 80 equivalent points.

Sort order is deterministic:

1. final score units descending;
2. unique visitors descending;
3. valid visits descending;
4. `verifiedAt` descending;
5. slug ascending.

External stars, forks, license, agents, skills, and comments do not affect the competitive rank.
Unique-visitor percentage change drives the separate trending board and does not modify the main
score. The existing verified-only eligibility, season snapshots, new-product window, soft cooldown,
cadence, transition-season behavior, and historical pages remain.

Trending compares adjacent equal windows with distinct visitors calculated independently in each
window:

```text
recentUnique   = distinct visitorHash in [now - window, now)
previousUnique = distinct visitorHash in [now - 2 * window, now - window)
changePercent  = ((recentUnique - previousUnique) / previousUnique) * 100
```

If `previousUnique` is below the configured minimum, change is `null`, the UI shows `신규`, and the
product is excluded from percentage-ordered trending. A qualifying previous window followed by zero
recent visitors produces `-100%`. The displayed percentage rounds to one decimal place.

Ranking policy adds configurable weights, repeat cap, minimum previous unique visitors, and minimum
unique visitors. Policy changes continue to be immutable scheduled revisions and apply only to a
future season. Existing closed seasons remain click-based and render using their stored policy;
columns are not retroactively relabelled.

Transition procedure:

1. Deploy unique-visitor collection without changing the active season formula.
2. Collect seven full days.
3. Let the administrator compare old and new results in preview.
4. Schedule the unique-first policy for the next season boundary.
5. Persist the score formula/version with each season snapshot and final entry.

## External facts and sources

### GitHub public repositories

For a public GitHub repository, the collector can retrieve:

- repository creation and most recent push times;
- public/private and archived state;
- stars and forks;
- GitHub-identified contributors;
- detected SPDX license;
- language byte counts and percentages;
- latest published release, version, date, notes URL, and release URL.

The UI says `GitHub에서 확인`, not “NoMoreVibe certified.” Contributor count means identities
returned by GitHub for that repository, not a guaranteed complete team count. An undetected license
renders `라이선스 확인 안 됨`; it never implies permission to use the code.

GitHub data is refreshed with an authenticated server integration, conditional requests/ETags, and
cached last-known-good values. Public API responses support these fields, and authenticated requests
avoid the unauthenticated 60-request-per-hour ceiling:

- [Repository API](https://docs.github.com/en/rest/repos/repos)
- [Release API](https://docs.github.com/en/rest/releases/releases)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

### Stores, packages, feeds, and changelogs

- App Store links are normalized to an app ID and may be checked against Apple's public lookup
  response. Apple request limits require caching.
- Google Play phase one verifies the public URL, package identifier, redirects, and availability.
  It does not call that an official metadata verification because the official publishing API is
  owner-account oriented.
- Supported package registry links use an allowlist of official hosts and verify package existence.
- RSS/Atom is discovered from `link rel="alternate"` or a maker-submitted URL, then parsed with size,
  timeout, and content-type limits.
- A changelog link is verified as a reachable relationship, not interpreted as proof that every
  claim in the changelog is true.

### Service-to-repository evidence

Relationship status is explicit:

- `bidirectional`: the service links the repository and the repository homepage/README links the
  service's canonical domain;
- `site_link`: the service links the repository;
- `repository_link`: repository metadata/README links the service;
- `maker_reported`: the maker supplied the link but the crawler found no cross-link;
- `disconnected`: a previously observed relationship no longer resolves.

Unverified links remain visible with `메이커 제공·미검증`; they are not hidden. Similar names,
shared avatars, or the maker's statement alone do not create a verified relationship.

## License presentation

License is stored as a value, source, source URL, observation time, and optional SPDX identifier.
Examples:

- `MIT · GitHub에서 감지`
- `Apache-2.0 · 저장소에서 감지`
- `Proprietary · 메이커 제공`
- `라이선스 확인 안 됨`

Maker and observed values never overwrite each other. A disagreement renders `정보 충돌` with both
sources. The page states that automatic detection is not legal advice or a warranty of permission.

## Media capture and internal storage

External image URLs cannot remain the serving source because they can change, disappear, reject
hotlinks, or return different bytes later. Phase one copies eligible images into PostgreSQL,
following the existing `og_images` durability approach.

Collection pipeline:

1. Discover maker-submitted or product-controlled image URLs.
2. Apply the same outbound SSRF protections used by the crawler, including every redirect.
3. Enforce response timeout, declared and decoded size, dimensions, and image-type allowlists.
4. Decode and re-encode the image, remove EXIF and unsafe metadata, and produce a web-sized variant
   and thumbnail.
5. Compute SHA-256 from normalized bytes and deduplicate content globally.
6. Store immutable bytes and metadata internally; product ordering and source relationships are
   separate records.
7. Serve only the internal media route with correct content type, `nosniff`, immutable caching, and
   descriptive alternative text.

Limits:

- at most eight visible gallery images per product;
- at most 5 MB per fetched source image;
- bounded decoded pixel dimensions;
- no arbitrary third-party-site mirroring;
- source URL, first/last observation, last successful check, and content hash retained;
- a changed source creates a new immutable asset/version instead of overwriting the prior bytes;
- a missing source keeps the last internal copy visible with `원본에서 더 이상 확인되지 않음`;
- maker/takedown deletion follows the product-media retention policy.

The binary backend is behind a storage interface. At current scale it uses PostgreSQL `bytea`; it can
move to S3/R2 later without changing product/media relationships. Phase one stores video thumbnails
internally but embeds or links the canonical video provider rather than copying video bytes.

## Update timeline

Maker-authored and automatically observed events share one chronological timeline and are
distinguished by source badges and filters.

Supported sources:

- maker update;
- GitHub release;
- RSS/Atom or changelog item;
- significant website/content change;
- repository visibility, archive, license, or relationship change;
- meaningful repository activity digest.

Every event stores source kind, stable deduplication key, title, sanitized summary, source URL,
structured before/after values when applicable, published time, observation time, and visibility.
Events are ordered by the event's real publication time and use observation time as a fallback.

Noise rules:

- A release, license change, archive/visibility change, or broken relationship is always eligible.
- Stars/forks do not create an event for every increment. They create a periodic digest only after a
  meaningful absolute or percentage threshold.
- One release discovered through both GitHub and RSS is deduplicated by canonical URL and version.
- Re-running a collector is idempotent and cannot duplicate an event.

Automatic events are immutable. An administrator may hide/restore one with a reason but does not
rewrite the observation. Maker updates may be edited with `수정됨` and `editedAt`; deletion leaves a
tombstone so replies and audit history can remain valid later.

The visual timeline has independent source-colored dots, no continuous left-hand line, and no text
below 13 px.

## Agent and skill provenance

Agent and skill disclosure is optional, never affects rank, and is never represented by one generic
“AI verified” checkmark.

Agent fields:

- provider/client name;
- model or model family when known;
- one or more roles such as planning, design, implementation, review, or QA;
- relevant release/commit and date range;
- evidence level.

Skill fields:

- namespace and normalized name;
- version when available;
- source URL or package identity;
- SHA-256 of `SKILL.md` or package manifest;
- relevant release/commit;
- evidence level.

Evidence levels:

- `maker_reported` (`메이커 제공`);
- `repository_evidenced` (`저장소 근거`);
- `nomorevibe_recorded` (`NoMoreVibe 기록`);
- `signed_build` (`서명된 빌드 증명`).

`/nomorevibe` can record the executing client, selected agent fields, skill identifiers/hashes, and
current commit when the maker opts in. It never uploads skill instructions, prompts, conversation
logs, or secrets by default. A hash proves equality with disclosed bytes; it does not prove that the
skill caused a particular line of code.

Agent Skills provides a portable `SKILL.md` metadata shape, while GitHub artifact attestations and
in-toto can bind signed claims to a repository commit or build. Those attestations prove the signed
build/source relationship, not semantic AI authorship:

- [Agent Skills specification](https://agentskills.io/specification)
- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [in-toto statement specification](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)

## Persistence boundaries

The implementation plan may refine names, but it must preserve these ownership boundaries:

- existing `products`: canonical identity and lifecycle state;
- maker profile: structured and long-form maker-authored content;
- product links: typed URLs, declaration source, evidence state, and check state;
- media assets: content-addressed immutable bytes and technical metadata;
- product media: ordering, source relationship, alt text, and visibility;
- visit events: accepted outbound event with nullable product-scoped visitor hash;
- daily visit aggregates: valid visits and per-day distinct visitors;
- repository/external facts: last-known-good normalized current state and refresh state;
- updates: immutable/deduplicated observed events plus maker-edit metadata;
- agents, skills, and provenance evidence: optional ranking-neutral disclosures;
- collection jobs: cursor, lock, last success/error, retry timing, and counts;
- ranking policy/season/entry: formula-versioned snapshot and final unique/visit values.

Deleting or banning a product must clean or hide all public subordinate data according to the
existing product lifecycle. Shared content-addressed media bytes are physically removed only when no
remaining product/version references them and retention permits deletion.

## Refresh and failure behavior

Default operational cadence:

- visit rollup: hourly;
- service health: existing health cadence;
- GitHub repository facts: daily;
- GitHub releases and RSS/Atom: every six hours;
- store/package/link and repository relationship checks: daily.

Jobs use existing `jobs` state, advisory/single-run locks, bounded batches, cursors where needed, and
failure isolation per product. A single malformed product feed cannot roll back successful work for
other products. Retries use bounded exponential backoff.

Presentation rules:

- no observations yet: `집계 중`, not zero;
- failed refresh: retain the last known good value and show the failure/freshness state;
- more than two expected intervals: `갱신 지연`;
- long-expired source: `오래된 정보`;
- source disappeared: `연결 끊김`;
- maker and external values differ: `정보 충돌`;
- no repository: `저장소 미제공`;
- no detected license: `라이선스 확인 안 됨`.

All external fetching rejects private, loopback, link-local, and cloud-metadata destinations before
and after redirects, limits response bytes and time, validates content, and sanitizes any rendered
HTML. Server tokens and HMAC secrets are environment values and never stored in product records or
logs.

## Maker and administrator permissions

The domain-verified maker may change profile fields, media/link declarations, agent/skill
disclosures, and maker updates through the existing edit-token/API skill flow. Phase one extends
`/nomorevibe` with profile, media/link, provenance, and update commands while preserving confirmation
before writes.

The maker cannot edit measured visits, rank, uptime, normalized GitHub responses, observed license,
relationship evidence, or collection timestamps. A correction request does not overwrite observed
facts.

Administrators can inspect source freshness/errors, force a product refresh, review conflicts, hide
or restore an automatic event with a reason, manage product lifecycle, preview ranking changes, and
inspect an audit trail. They can configure bounded collection intervals, stale thresholds, and retry
limits; changes are audited and must not permit unsafe zero-delay polling. Administrators do not
silently rewrite external observations.

## Future comments contract

No public comment write path or comments table ships in phase one. The phase-two design supports:

- only authenticated users can write; unauthenticated visitors can read;
- login providers are selected as one unified authentication project;
- replies deeper than one level through a parent/root relationship;
- configurable presentation depth rather than a hard-coded one-level limit;
- collapsed deep threads and stable ordering;
- author edit/delete, with deleted-parent tombstones preserving descendants;
- maker badges and emphasized maker replies;
- reactions, reporting, moderation visibility, and audit metadata;
- newest and reaction-based ordering without changing product rank.

Ratings/reviews remain a separate concept from discussion comments.

## Accessibility, performance, and rendering

- The product detail page remains server-rendered and dynamic for current facts.
- Independent data reads start together where their inputs are known; route rendering must avoid
  product-by-product or link-by-link query waterfalls.
- External fetching happens in jobs, never in the page request.
- Internal gallery assets provide dimensions and responsive variants to prevent layout shift.
- Below-the-fold media is lazy-loaded; the first meaningful gallery image is prioritized.
- Tables/charts, if later added, require accessible text equivalents.
- Images require maker-authored or derived descriptive alt text; decorative graphics use empty alt.
- Keyboard order follows visual order, including the mobile reordering.
- Empty, delayed, conflicting, disconnected, and collection-start states are testable UI variants.
- Before implementation, the applicable Next.js 16 guides under `node_modules/next/dist/docs/` must be
  read for route handlers, image serving, caching, async request APIs, and Server Components.

## Test and verification contract

Implementation follows TDD and must cover at least:

### Unit

- product-scoped visitor HMAC and no raw identifier persistence;
- bot and ten-minute repeat filtering;
- unique/valid aggregation and null visitor hashes;
- unique-first ranking score, caps, cooldown, ties, transition, and old-policy compatibility;
- external link normalization and relationship evidence;
- GitHub response normalization, release deduplication, languages, and license conflicts;
- update deduplication and event thresholds;
- image content hashing, type/dimension limits, and metadata stripping;
- Markdown/feed sanitization;
- freshness and state labels;
- provenance evidence labels and ranking neutrality.

### Integration

- visit insert/rollup/prune and exact active-season unique counts;
- finalized unique totals surviving raw-event pruning;
- scheduled ranking policy applying only at the next boundary;
- idempotent external refresh and partial-product failure isolation;
- conditional GitHub refresh and last-known-good preservation;
- SSRF rejection through direct and redirected private destinations;
- internal media persistence, deduplication, source change, and orphan cleanup;
- automatic/maker update lifecycle and admin hide/restore audit;
- product deletion/ban behavior across subordinate records.

### UI and browser

- all product evidence states and source badges;
- `집계 중`, stale, disconnected, conflict, and no-license states;
- stored global season rank under filters remains unchanged;
- 13 px computed font minimum at 390 px and 1440 px;
- 15 px product prose and 14 px update copy;
- no update timeline vertical line;
- approved radii and light public theme;
- no horizontal overflow at 390 px;
- keyboard focus, 44 px targets, alt text, and contrast;
- no console/page errors on public detail routes.

The full existing unit, integration, lint, typecheck, and Next production build matrix must still
pass. Test results may be claimed only when executed.

## Rollout and observability

1. Add backward-compatible schema and collection code.
2. Start unique visitor and external-fact collection with old ranking still active.
3. Render the detail page with explicit collection-start and missing-data states.
4. Run seven days of dual old/new ranking preview.
5. Schedule the new policy for a future season boundary.
6. Add production scheduler entries only with explicit production access and document them in
   `PENDING.md` until verified.

Structured logs include job/source/product slug, duration, outcome, HTTP class, inserted/changed
event counts, and freshness age. They exclude cookies, visitor hashes, tokens, response bodies, and
maker Markdown. Admin status exposes aggregate success/failure and last-error summaries without
secrets.

## Deferred and non-goals

- No claim to know a product's total visitors without an analytics integration.
- No opaque public quality score.
- No stars, license, comments, agents, or skills in the ranking formula.
- No fingerprinting or cross-product visitor tracking.
- No arbitrary third-party image archiving or internal video copying.
- No comments, reactions, follows, ratings, or general user accounts in phase one.
- No claim that repository or signed-build evidence proves semantic AI authorship.
- No retroactive recomputation of historical click-based seasons.

## Approved decisions summary

- Evidence-first hybrid layout rather than a stats-only dashboard or a Product Hunt clone.
- Unique outbound visitors are primary; valid visits remain visible and receive capped repeat credit.
- GitHub, license, distribution links, RSS/changelog, and repository relationship are phase one.
- `메이커 제공·미검증` links remain visible rather than being hidden.
- Maker and automatic updates share one timeline with source badges and no left vertical line.
- Agent/skill disclosure is optional, evidence-tiered, private by default, and ranking-neutral.
- Images are copied to internal durable storage; video bytes are not.
- Comments are designed for deep threads but implemented in phase two with unified authentication.
- The approved screen is light-first with 13 px minimum text, 15 px long prose, 14 px update copy,
  and reduced section radii.
