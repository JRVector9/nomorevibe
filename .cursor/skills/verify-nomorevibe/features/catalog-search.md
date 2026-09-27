# Catalog search

Catalog search finds listed products from the header search box. The query lives in `?q=` and the result heading repeats the query.

## Sub-features

- `search-submit` runs a header search and lands on the result heading.
- `search-match` shows a listed product whose name, owner, or description matches.
- `search-empty` shows a complete empty state for a query with no matches.
- `search-clears-filters` drops an existing category/sort when the header search is submitted.

## How to get to it (user POV)

- Type in the `프로젝트 검색` searchbox on any public page and submit.
- Press Control+K or Meta+K to focus the searchbox, then submit.
- Open `/?q=<query>` directly.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- A verified product named `Verify Fixture` exists (maker-register + maker-verify).

- **Focus search.** Open `/`. The searchbox name is `프로젝트 검색`.
- **Name match.** Fill `Verify Fixture` and press Enter. The location contains `q=Verify+Fixture` (or equivalent encoding). The heading is `“Verify Fixture” 검색 결과` and a card heading `Verify Fixture` is visible. The `최신` tab is selected for an unqualified search.
- **Open result.** Choose the `Verify Fixture` link. The location is `/p/<slug>`.
- **Empty state.** Open `/?q=volcano-no-such-product`. After the result heading appears, the empty copy is `조건에 맞는 제품이 없습니다`.
- **Filter reset.** Open `/?sort=all-time&category=Finance`, submit `@nomatch-owner`. The new URL has `q=` and does not keep `category`.
- **HTTP proof.** Run `curl -sS "$SITE/?q=Verify%20Fixture"`. The HTML contains `Verify Fixture` and `검색 결과`.
- **Proof.** Screenshot the match state to `/tmp/nomorevibe-verify-$RUN_ID/evidence/catalog-search/match.png`. The image shows the query heading and the matching card.

## Gotchas

- Korean queries may be translated and retried in English. A line `영어로 “…”도 함께 찾았습니다.` is expected, not a failure.
- Unverified products are not in the public catalogue. Searching for a just-registered slug before verify is an empty-state proof, not a product bug.
- Results stream in: wait for the heading or empty state, not a fixed sleep.
- Saved-only view (`saved=1`) is not search. Clear it before asserting catalogue matches.
