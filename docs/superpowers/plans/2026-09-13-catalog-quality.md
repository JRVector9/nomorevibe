# Catalogue quality implementation plan

> Execute inline task by task; the user's concrete change request authorizes implementation and production verification.

**Goal:** Exclude clear non-products, expose daily star change, show nine cards and make global search usable.
**Architecture:** Shared pure purpose detector and search predicate; existing guarded publisher/stars worker; two timestamped star observations; source-aware UI.
**Tech Stack:** Next16.3/React/TypeScript/Drizzle/PostgreSQL/Vitest/Playwright.

- [x] Reproduce production search/name vs@owner and measure result viewport; audit stars freshness and suspect published pages. Evidence `.crawl-samples/{catalog-audit,search-repro}-20260913.json`.
- [x] Add tests for `nonProductPurpose({title:'OTT...',description:'석사학위논문 실험 설문'})` exclusion and Formbricks/JabRef preservation; implement `lib/crawl/product-purpose.ts`; call from rules.ts and publish.ts. Run `npx vitest run tests/product-purpose.test.ts tests/crawl-rules.test.ts` and publication integration.
- [x] Add query regressions for @owner/repo, description, whitespace terms and literal `%_`; implement `lib/domain/products/search.ts` shared with product repository/ranking. Set `HOME_FIRST_PAGE=9; HOME_PAGE_SIZE=9`; header global q form; dedicated search heading/skip unrelated hero. Run repository integration and home/browser tests.
- [x] Add schema fields `starsPrevious:integer('stars_previous')`, `starsPreviousAt:timestamp('stars_previous_at')`; generate migration0032. In stars-refresh successful update shift `starsPrevious:sql\`${products.stars}\``, `starsPreviousAt:sql\`${products.starsAt}\`` atomically; clear on repo edit. Test successful/failed/reset behavior. UI helper/components show stars and signed deltas in home/popular/detail without inventing baseline.
- [x] Freeze exclusion candidates with evidence and CAS fields; inspect each definite candidate. Use same detector within transaction, preserve changed rows, ban with audit reason. Preview then apply; report actual changed/skipped counts.
- [x] Typecheck/lint/relevant tests, isolated production build + Playwright. Codex independent review per active ak (supported gpt-5.6-sol/high fallback, bounded scope); fix findings and re-review.
- [ ] Commit own files, directDB migration, deploy affected services, verify search/nine cards/star states and exclusion pages, preserve user Hero changes. Final operations report, CODEX_HANDOFF and Obsidian journal.
