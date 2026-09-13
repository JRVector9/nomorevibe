# Thumbnail Fallback Implementation Plan

> Execute inline, task by task. The user already approved the design/order and production application.

**Goal:** Fill existing missing product images and run the same fallback on new collection/publication.
**Architecture:** Safe candidate discovery and decoding → CAS cache/state persistence → maintenance job and resumable cohort CLI → source-aware UI.
**Tech Stack:** Next16.3, TypeScript, Drizzle/PostgreSQL, sharp, existing capped SSRF fetch.

- [x] Capture frozen public missing-image cohort before mutations; write schema migration0031 with thumbnail state(slug,kind,sourceUrl,width,height,checkedAt,nextAttemptAt,attempts,lastError).
- [x] RED tests in tests/thumbnail-candidates.test.ts, tests/thumbnail-images.test.ts for icon/manifest/README ordering, badge exclusions, unsafe schemes, ICO/raster/SVG validation and limits. Implement lib/domain/products/thumbnails/{candidates,images,resolver}.ts.
- [x] RED integration in tests/integration/product-thumbnails.test.ts for cache/source writes, stale product and maker image guards, default-vs-real counting and retry upgrade. Implement thumbnails/repository.ts and schema. Run npx vitest run --config vitest.integration.config.ts tests/integration/product-thumbnails.test.ts.
- [x] Add thumbnail hints in lib/crawl/jobs/fetch.ts, publication/registration job request, maintenance job catalog/registry, scripts/backfill-thumbnails.ts using the same guarded resolver. Defaults do not count as source-image successes. Persist JSONL receipt after each result; resume IDs already processed.
- [x] Source-aware ProjectCover/ProductIcon/detail caption; preserve user ProductHero changes when staging. Default initials, no fake screenshot templates. Add visible-source rendering tests and inspect live screenshots.
- [ ] Run unit/integration/typecheck/lint/build; independently review code using codex CLI if available; fix actionable findings. Commit own files only, migrate directDB, apply frozen production cohort; report counts while processing.
- [ ] Deploy web2/crawler/publisher/maintenance/scheduler; verify fresh source and job executions plus desktop/mobile images. Record final source counts, exclusions and unresolved failures in operations report and CODEX_HANDOFF.md.
