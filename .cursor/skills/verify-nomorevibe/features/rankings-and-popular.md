# Rankings and popular

Season rankings show verified-product competition for a season key. Popular is a GitHub-star tier table that is independent of weekly ranking.

Verification (2026-09-27 local drive): `/popular` empty table, unknown season 404, `ranking-refresh` creating `2026-W40`, and `/rankings/2026-W40` listing the fixture were proven. Popular tiers stay empty without 2,000+ star rows.

## Sub-features

- `ranking-current` opens the active season page when a season snapshot exists.
- `ranking-missing` 404s an unknown season key.
- `popular-empty` renders the popular table with zero rows on a fresh database.
- `popular-tiers` switches star-tier tabs.

## How to get to it (user POV)

- Open `/rankings/<season-key>` from a home ranking card or sitemap entry.
- Open `/popular` from the home `많이 쓰이는 프로젝트` block or `/?metric=popular`.
- Choose a star-tier tab on `/popular`.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- `ranking-current` needs `npm run job -- ranking-refresh` (or a prior `click-rollup` that requested it) so a season row exists.

- **Unknown season.** Run `curl -sS -o /dev/null -w "%{http_code}" "$SITE/rankings/does-not-exist"`. Expect HTTP 404.
- **Refresh seasons.** Run `npm run job -- ranking-refresh`. Exit code `0`. Stdout includes `결과:` with a non-failed status.
- **Current season.** Discover the key from the job/DB or from `/sitemap.xml` (`/rankings/` URLs). Open `/rankings/<key>`. The heading is `<key> 랭킹`.
- **Popular page.** Open `/popular`. The heading is `많이 쓰이는 프로젝트`. The back link is `← 발견하기로 돌아가기`. On an empty catalogue the table body contains `아직 없음`.
- **Tier tab.** Choose a tab in `스타 구간` (for example the default 2천+ band). `aria-current` is `page` on the selected tab.
- **Proof.** Screenshot `/popular` to `/tmp/nomorevibe-verify-$RUN_ID/evidence/rankings-and-popular/popular.png`. Screenshot a real season page when `ranking-refresh` created one.

## Gotchas

- Weekly home (`추천`) is not the same document as `/rankings/<key>`. Prove the season route separately.
- Popular requires GitHub star fields in the 2,000–99,999 window. A locally registered fixture will not appear in popular tiers.
- `ranking-refresh` has no independent scheduler interval; `click-rollup` requests it. Manual `npm run job -- ranking-refresh` is the local drive.
- Policy changes saved in `/admin/ranking` apply at the next season boundary, not immediately.
