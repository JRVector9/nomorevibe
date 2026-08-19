# Product Evidence Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist maker-authored profile data separately from machine observations, refresh objective external facts and updates safely, and copy eligible gallery images into immutable internal storage.

**Architecture:** Add a focused product-evidence schema exported by the existing Drizzle root. Typed product links are declarations; external-source rows hold last-known-good normalized observations and refresh state; immutable content-addressed media bytes are referenced by versioned product-media rows; update events are deduplicated observations. A bounded evidence job fetches outside transactions, persists each product independently, and uses the existing job runner for locking and resumability.

**Tech Stack:** TypeScript, PostgreSQL 17, Drizzle ORM, Zod 4, GitHub REST API, Undici SSRF-safe fetching, Sharp, fast-xml-parser, Vitest

---

## Scope and dependency

This is plan 2 of 3. Start only after `2026-08-19-unique-visit-ranking-implementation.md` is complete. It creates domain/readiness primitives but does not redesign `/p/[slug]`; that happens in plan 3.

Phase-one source truth is intentionally split:

- maker fields are displayed as `메이커 제공` or `메이커 제공·미검증`;
- observed fields retain provider, source URL, observation time, and last-known-good value;
- conflicts retain both values;
- stars, forks, licenses, agents, skills, and updates never feed ranking math;
- gallery image bytes are served only from NoMoreVibe after validation and re-encoding.

## Task 1: Add evidence dependencies and persistence boundaries

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/db/product-evidence-schema.ts`
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0014_product_evidence.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `tests/integration/product-evidence-schema.test.ts`
- Modify: `tests/integration/setup.ts`

- [ ] Install production dependencies with the package manager so the lockfile is generated, not hand-edited:

```sh
npm install sharp fast-xml-parser
```

- [ ] Write the schema integration test first. It must prove maker/observed license values coexist, one source key is idempotent per product, identical media bytes can be shared by two products, update dedupe is enforced, and all provenance rows are ranking-neutral.

- [ ] Run `npx vitest run --config vitest.integration.config.ts tests/integration/product-evidence-schema.test.ts` and confirm RED because the tables do not exist.

- [ ] Create `product-evidence-schema.ts` with these enums/types and ownership boundaries:

```ts
export type LinkKind =
  | "repository" | "app_store" | "play_store"
  | "npm" | "pypi" | "crates"
  | "documentation" | "support" | "rss" | "changelog" | "video";
export type DeclarationSource = "maker" | "discovered";
export type SourceState = "unobserved" | "ok" | "failed" | "stale" | "disconnected";
export type EvidenceLevel =
  | "maker_reported" | "repository_evidenced"
  | "nomorevibe_recorded" | "signed_build";
export type RelationshipState =
  | "bidirectional" | "site_link" | "repository_link"
  | "maker_reported" | "disconnected";
```

The tables must be:

```ts
productProfiles       // slug PK; structured maker fields, Markdown, maker license, updatedAt
productLinks          // typed declared/discovered URLs and visible verification state
productEvidenceSources// normalized last-known-good provider state + ETag/freshness/retry fields
mediaAssets           // SHA-256 PK, web + thumbnail bytea, dimensions, MIME, sizes
productMedia          // slug/order/source/alt/current/version relationship to mediaAssets
productUpdates        // source kind, stable dedupe key, before/after, visibility, maker edit metadata
productAgents         // provider/client, model, roles, commit/date range, evidence level
productSkills         // namespace/name/version/source/hash/commit/evidence level
productEvidenceAudit  // actor, action, reason, structured metadata, createdAt
evidenceSettings      // singleton JSON settings plus updatedBy/updatedAt
productHealthDaily    // KST day, checks, successes, latency sum/count for 30-day uptime
```

Also add nullable `latency_ms` to the existing `product_health` current-state row. Do not derive
historical uptime from the current failure counter.

```ts
export const productHealthDaily = pgTable("product_health_daily", {
  slug: varchar("slug", { length: 80 }).notNull(),
  day: date("day").notNull(),
  checks: integer("checks").notNull().default(0),
  successes: integer("successes").notNull().default(0),
  latencyTotalMs: bigint("latency_total_ms", { mode: "number" }).notNull().default(0),
  latencySamples: integer("latency_samples").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.slug, table.day] })]);
```

Use explicit size limits in database columns where the domain has a bound. Store arbitrary normalized provider payloads only after mapping into a known TypeScript type; do not persist whole unbounded response bodies.

- [ ] Use these key uniqueness rules in schema and migration:

```text
product_links:             unique(slug, kind, normalized_key)
product_evidence_sources:  unique(slug, kind, source_key)
product_media:             unique(slug, source_url, asset_hash)
product_updates:           unique(slug, dedupe_key)
product_skills:            unique(slug, namespace, name, coalesce(version,''), coalesce(commit,''))
```

Add a partial unique index for one current `product_media` row per `(slug, source_url)` and indexes for source due-time, visible update ordering, and media orphan lookup.

- [ ] Re-export the new schema from `lib/db/schema.ts`, generate/inspect SQL, and make `0014_product_evidence.sql` additive. Do not add a comments table.

- [ ] Run the target test, `npx drizzle-kit check`, `npx tsc --noEmit`, and `git diff --check`; expect PASS.

- [ ] Commit: `feat: add product evidence storage`

## Task 2: Validate maker profiles, links, provenance, and settings

**Files:**

- Create: `lib/domain/evidence/contracts.ts`
- Create: `lib/domain/evidence/settings.ts`
- Create: `lib/domain/evidence/repository.ts`
- Create: `tests/evidence-contracts.test.ts`
- Create: `tests/integration/product-evidence-repository.test.ts`

- [ ] Write RED unit tests for field length limits, unsafe URL schemes, raw HTML/forms/event
  attributes in Markdown, official-host allowlists, normalized store/package keys, maximum eight
  media URLs, maximum twelve skills, SHA-256 formatting, role allowlists, and bounded settings.

- [ ] Define maker profile input without mixing observed facts:

```ts
export const makerProfileSchema = z.object({
  problem: z.string().max(2_000).optional(),
  targetUsers: z.string().max(2_000).optional(),
  keyFeatures: z.array(z.string().max(240)).max(12).default([]),
  useCases: z.array(z.string().max(500)).max(12).default([]),
  pricingModel: z.enum(["free", "freemium", "paid", "open_source", "contact", "unknown"]),
  pricingUrl: safeHttpUrl.optional(),
  lifecycle: z.enum(["prototype", "beta", "ga", "maintenance", "sunset", "unknown"]),
  platforms: z.array(z.string().max(60)).max(12).default([]),
  privacySummary: z.string().max(2_000).optional(),
  longDescriptionMarkdown: z.string().max(20_000),
  team: z.array(z.object({ name: z.string().max(120), role: z.string().max(120) })).max(20),
  makerLicense: z.object({ value: z.string().max(120), spdxId: z.string().max(80).optional(), url: safeHttpUrl.optional() }).optional(),
});
```

Validate `longDescriptionMarkdown` with a dedicated helper that rejects raw HTML blocks/tags,
embedded forms, event attributes, and unsafe URL schemes while preserving ordinary Markdown. The
renderer will still use a strict allowlist in plan 3 as defense in depth.

- [ ] Normalize typed links into stable keys:

  - GitHub repository: lowercase `owner/repo` from `github.com` only;
  - App Store: numeric app ID;
  - Play Store: `id` package name;
  - npm/PyPI/crates: official hostname plus normalized package name;
  - RSS/changelog/docs/support/video: normalized HTTPS URL.

Reject credentials, fragments where irrelevant, private/non-HTTP schemes, and unsupported package hosts.

- [ ] Define bounded collection settings:

```ts
export const evidenceSettingsSchema = z.object({
  githubFactsHours: z.number().int().min(6).max(168).default(24),
  releaseFeedHours: z.number().int().min(1).max(48).default(6),
  linkCheckHours: z.number().int().min(6).max(168).default(24),
  staleAfterIntervals: z.number().int().min(2).max(10).default(2),
  maxRetries: z.number().int().min(1).max(8).default(4),
  batchSize: z.number().int().min(1).max(100).default(20),
  starDigestAbsolute: z.number().int().min(5).max(10_000).default(25),
  starDigestPercent: z.number().min(1).max(100).default(10),
});
```

- [ ] Implement repositories that upsert maker declarations and observed sources separately. All multi-row maker replacements run in a transaction and write one audit row. Never accept provider-normalized fields through maker repository methods.

- [ ] Add integration tests for idempotent upserts, conflict retention, transaction rollback, and audit metadata excluding edit tokens/source bodies.

- [ ] Run both target files and expect PASS.

- [ ] Commit: `feat: validate product evidence declarations`

## Task 3: Build conditional GitHub facts and relationship evidence

**Files:**

- Modify: `lib/crawl/github.ts`
- Create: `lib/domain/evidence/providers/github.ts`
- Create: `lib/domain/evidence/relationship.ts`
- Create: `tests/github-evidence.test.ts`
- Create: `tests/relationship-evidence.test.ts`
- Create: `tests/integration/github-evidence.test.ts`

- [ ] Write RED normalization tests using fixed fixtures for repository creation/push state, public/private/archived state, stars, forks, contributors, SPDX license, language byte percentages, and latest published release.

- [ ] Refactor the existing GitHub request helper without breaking crawl callers. The shared result must expose response status, ETag, Last-Modified, Link header, and rate-limit reset while preserving `rate_limited`, `not_found`, and other HTTP failures.

```ts
export type ConditionalRequest = { etag?: string | null; lastModified?: string | null };
export type GitHubHttpResult<T> =
  | { ok: true; status: 200; value: T; etag: string | null; lastModified: string | null; link: string | null }
  | { ok: true; status: 304; etag: string | null; lastModified: string | null; link: string | null }
  | { ok: false; error: GitHubFailure };
```

Send `If-None-Match`/`If-Modified-Since` when available. A 304 advances `lastSuccessAt` without replacing normalized facts.

- [ ] Implement a `GitHubRepositoryFacts` mapper. Contributor count is the GitHub-identified contributor total derived from a bounded contributors request and pagination header; cap/document incomplete responses rather than claiming a complete team size. Compute language percentages from byte totals and round deterministically.

- [ ] Fetch only these endpoints per due repository: repository, languages, contributors, the latest
  ten published releases, and README/link evidence. Normalize the newest release into current facts
  and pass all returned releases through update deduplication so a missed six-hour tick does not lose
  intermediate releases. Store release and notes URLs, not unbounded release bodies.

- [ ] Implement relationship classification from two independent observations:

```ts
export function relationshipState(input: {
  makerDeclared: boolean;
  siteLinksRepository: boolean;
  repositoryLinksCanonicalSite: boolean;
  previouslyConnected: boolean;
}): RelationshipState;
```

The canonical service domain must be compared after URL normalization. Names, avatars, or maker statements alone cannot yield `site_link`, `repository_link`, or `bidirectional`.

- [ ] Add integration cases for 200 -> 304, 404/disconnect, rate limit, transient 500 preserving last-known-good, license conflict retaining maker and observed values, and redacted logging.

- [ ] Re-run existing crawl tests plus the new targets:

```sh
npx vitest run tests/github-evidence.test.ts tests/relationship-evidence.test.ts tests/crawl-rules.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/crawl-fetch.test.ts tests/integration/github-evidence.test.ts
```

- [ ] Commit: `feat: collect GitHub product evidence`

## Task 4: Verify stores, packages, feeds, changelogs, and update events

**Files:**

- Create: `lib/domain/evidence/providers/links.ts`
- Create: `lib/domain/evidence/providers/feeds.ts`
- Create: `lib/domain/evidence/updates.ts`
- Modify: `lib/net/fetch.ts`
- Create: `tests/link-evidence.test.ts`
- Create: `tests/feed-evidence.test.ts`
- Create: `tests/update-events.test.ts`
- Create: `tests/integration/product-updates.test.ts`

- [ ] Add RED tests for App Store ID lookup mapping, Play Store reachability wording, official package host validation/existence, RSS discovery, Atom/RSS parsing limits, changelog reachability, malformed feeds, and redirected private addresses.

- [ ] Extend `lib/net/fetch.ts` with a generic capped fetch result that checks declared `Content-Length` and returns an explicit `too_large`, `unsafe_url`, `timeout`, or `http` failure. Keep public-IP validation on every redirect.

- [ ] Implement provider semantics exactly:

  - App Store: Apple lookup result can be `공식 출처에서 확인`;
  - Play Store: only URL/package/redirect/availability is `링크 확인`, not official metadata verification;
  - package registries: only allowlisted official APIs/hosts and package existence;
  - RSS/Atom: discover from product-controlled HTML or maker URL and parse capped XML;
  - changelog: reachable relationship only; its prose remains source-authored.

- [ ] Normalize update inputs into:

```ts
export type UpdateCandidate = {
  sourceKind: "maker" | "github_release" | "feed" | "site_change" | "repository_change" | "activity_digest";
  dedupeKey: string;
  canonicalUrl: string | null;
  title: string;
  summary: string | null;
  beforeAfter: Record<string, unknown> | null;
  publishedAt: Date | null;
  observedAt: Date;
};
```

- [ ] Deduplicate the same release seen via GitHub and RSS by canonical URL plus normalized version. Re-running a collector must use `ON CONFLICT DO NOTHING/UPDATE observation state` and never duplicate a public event.

- [ ] For product-controlled website changes, persist a bounded normalized fingerprint of title,
  meta description, and top-level headings. Emit `site_change` only when one of those meaningful
  fields changes; do not create events for whitespace, timestamps, asset hashes, or arbitrary full
  body differences.

- [ ] Implement noise thresholds: release/license/archive/visibility/relationship changes always create events; star/fork changes create one digest only when either configured absolute or percentage threshold is reached. Automatic events are immutable except admin visibility fields.

- [ ] Add HTML/text sanitization that strips raw HTML, scripts, event attributes, forms, and unsafe links from feed summaries before persistence.

- [ ] Run unit and integration targets and expect PASS.

- [ ] Commit: `feat: normalize external product updates`

## Task 5: Copy gallery images into immutable internal storage

**Files:**

- Create: `lib/domain/media/storage.ts`
- Create: `lib/domain/media/postgres-storage.ts`
- Create: `lib/domain/media/images.ts`
- Create: `lib/domain/media/repository.ts`
- Create: `app/api/media/[hash]/route.ts`
- Create: `tests/media-images.test.ts`
- Create: `tests/integration/product-media.test.ts`
- Create: `tests/media-route.test.ts`

- [ ] Write RED tests for allowed JPEG/PNG/WebP inputs, disguised content, EXIF removal, five-megabyte source cap, decoded pixel/dimension caps, SHA-256 dedupe, changed-source versioning, missing-source last-copy preservation, maximum eight visible images, and redirected SSRF rejection.

- [ ] Define a replaceable storage boundary:

```ts
export interface MediaStorage {
  put(asset: NormalizedImageAsset): Promise<void>;
  get(hash: string, variant: "web" | "thumbnail"): Promise<StoredImage | null>;
  deleteIfUnreferenced(hash: string): Promise<boolean>;
}
```

- [ ] Fetch through `safeFetch`, reject declared or streamed bodies over 5 MB, then decode with Sharp using bounded input pixels. Auto-rotate, strip metadata, and re-encode deterministic web and thumbnail WebP variants. Compute SHA-256 from the normalized web bytes, not the source URL or original bytes.

```ts
const web = await sharp(source, { limitInputPixels: 40_000_000 })
  .rotate()
  .resize({ width: 1600, height: 1200, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 82 })
  .toBuffer({ resolveWithObject: true });
```

- [ ] Persist source URL, first/last observation, last successful check, missing timestamp, asset hash, alt text, order, visibility, and superseded time. If source bytes change, insert a new immutable media relationship and mark the old relation non-current; never overwrite shared bytes.

- [ ] Implement `GET /api/media/[hash]?variant=web|thumbnail` with async params, strict 64-hex validation, and headers:

```text
Content-Type: image/webp
Cache-Control: public, max-age=31536000, immutable
X-Content-Type-Options: nosniff
Content-Length: exact bytes
```

Return 404 for unknown hashes and never accept an external URL in this route.

- [ ] Run `npx vitest run tests/media-images.test.ts tests/media-route.test.ts` and the media integration target; expect PASS.

- [ ] Commit: `feat: persist immutable product media`

## Task 6: Persist optional agent and skill provenance without overclaiming

**Files:**

- Create: `lib/domain/evidence/provenance.ts`
- Modify: `lib/domain/evidence/repository.ts`
- Create: `tests/provenance.test.ts`
- Create: `tests/integration/product-provenance.test.ts`

- [ ] Add RED tests for optional model fields, multiple roles, namespace/name normalization, version/source/hash validation, relevant commit/date range, each evidence label, and complete exclusion from ranking inputs.

- [ ] Implement labels exactly:

```ts
export const EVIDENCE_LABELS = {
  maker_reported: "메이커 제공",
  repository_evidenced: "저장소 근거",
  nomorevibe_recorded: "NoMoreVibe 기록",
  signed_build: "서명된 빌드 증명",
} as const;
```

- [ ] Store only disclosed metadata and SHA-256 identifiers. Reject prompt bodies, conversation logs, environment values, credential-shaped fields, and raw `SKILL.md` content at the API/domain boundary.

- [ ] Add an integration assertion that adding/removing provenance rows does not change `ranking_entries`, preview output, or product eligibility.

- [ ] Run target tests and expect PASS.

- [ ] Commit: `feat: record product build provenance`

## Task 7: Orchestrate bounded evidence refreshes

**Files:**

- Create: `lib/domain/evidence/refresh.ts`
- Create: `lib/jobs/products/evidence-refresh.ts`
- Modify: `lib/jobs/registry.ts`
- Modify: `scripts/scheduler.sh`
- Modify: `lib/domain/products/health.ts`
- Modify: `lib/jobs/products/uptime.ts`
- Create: `tests/integration/evidence-refresh.test.ts`
- Modify: `tests/integration/job-runner.test.ts`
- Modify: `tests/integration/uptime.test.ts`

- [ ] Add RED integration tests for due-source selection, bounded batch/cursor continuation, per-product failure isolation, retry backoff, force refresh, 304 success, last-known-good preservation, idempotent events/media, and structured job counts.

- [ ] Implement `refreshProductEvidence(slug, options)` so network requests occur outside database transactions. Persist each completed source in a short transaction; one malformed feed or image must not roll back another product's successful GitHub facts.

- [ ] Measure uptime request duration with a monotonic clock, pass `latencyMs` to `recordPing`, and atomically upsert the KST daily row with check count, successful count, and successful latency sum/count. Export a batched `healthMetrics(slugs, 30)` read that returns current latency and `successes / checks * 100`; no checks returns `null`, not 100%.

- [ ] Implement the job outcome:

```ts
type EvidenceRefreshCursor = { afterSlug?: string };
type EvidenceRefreshCounts = {
  attempted: number;
  succeeded: number;
  failed: number;
  factsChanged: number;
  eventsInserted: number;
  mediaInserted: number;
};
```

Use the existing runner lock. Source rows decide whether six-hour or daily work is due from settings and `nextAttemptAt`; the job itself may run every six hours.

- [ ] Add `product-evidence-refresh` to `JOBS`. In `scripts/scheduler.sh`, run it every 360 one-minute ticks. Preserve sequential `click-rollup -> ranking-refresh`; evidence refresh is independent.

- [ ] Log source kind, slug, duration, outcome, HTTP class, and count fields only. Exclude tokens, response bodies, Markdown, URLs with credentials, visitor hashes, and media bytes.

- [ ] Run the target integration tests twice and expect stable PASS.

- [ ] Commit: `feat: refresh product evidence`

## Task 8: Enforce lifecycle cleanup and document operations

**Files:**

- Modify: `lib/domain/products/repository.ts`
- Modify: `lib/domain/products/manage.ts`
- Create: `tests/integration/product-evidence-lifecycle.test.ts`
- Modify: `README.md`
- Modify: `PENDING.md`
- Modify: `docs/CODEX_HANDOFF.md`

- [ ] Add RED lifecycle tests proving delete removes/hides product-owned profiles, links, sources, media relations, updates, agents, and skills; shared media bytes survive while referenced and are removed only after the last reference; banning removes public visibility without destroying the audit trail.

- [ ] Replace the current parallel `removeTraces()` cleanup with a transactionally safe evidence-aware delete sequence. Do not physically remove immutable observed/audit rows needed for a ban; mark them non-public. Full maker-authorized deletion may remove product-owned records and then run orphan cleanup.

- [ ] Document provider tokens, schedules, source semantics, media limits, PostgreSQL `bytea` capacity assumption, backup implications, retry behavior, and how to force one product refresh.

- [ ] Add production scheduler/provider-token verification to `PENDING.md`; do not claim it was registered without production access.

- [ ] Run the full matrix:

```sh
npx next typegen
npx tsc --noEmit
npm test
npm run test:integration
npm run lint
npm run build
sh -n scripts/scheduler.sh
git diff --check
```

- [ ] Run an independent complete-diff review. Convert every actionable P1/P2 into a failing regression test before fixing it.

- [ ] Update `docs/CODEX_HANDOFF.md` with exact results, local migration state, failed external probes, remaining production blockers, and the plan 3 path.

- [ ] Commit: `docs: operate product evidence collection`

## Completion criteria

- Maker claims and machine observations cannot overwrite each other.
- GitHub, store, package, feed, changelog, license, and relationship facts carry source and freshness.
- Last-known-good facts survive transient provider failures.
- Update generation is meaningful, sanitized, idempotent, and auditable.
- External images are validated, re-encoded, deduplicated, internally served, and versioned.
- Agent/skill provenance is optional, evidence-labelled, privacy-bounded, and rank-neutral.
- Product lifecycle operations correctly handle subordinate and shared data.
- The full repository test/build matrix has been executed successfully.
