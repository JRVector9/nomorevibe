# Product detail

Product detail is the public profile at `/p/<slug>`. It shows identity, visit metrics, maker vs observed evidence, and (for unverified maker listings) a notice that the product is not on the public list.

Verification (2026-09-27 local drive): unverified notice, verified visit control, 404, public JSON, and post-profile/update copy were proven over HTTP.

## Sub-features

- `detail-unverified` renders a registered product that is not yet on the home list.
- `detail-verified` renders a verified product with a visit action.
- `detail-missing` returns the app 404 for an unknown slug.
- `detail-metrics` shows the NoMoreVibe visit/uptime region.

## How to get to it (user POV)

- Open `/p/<slug>` from a card's `{name} 상세 보기` link.
- Open `/p/<slug>` from a search result heading.
- Open `/p/<slug>` from `/popular` or a season ranking table.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- `detail-unverified` needs a registered-but-unverified slug. `detail-verified` needs a verified slug.

- **Unverified page.** Open `/p/<slug>` immediately after register. The breadcrumb includes `제품`. The heading is the product name. A section heading `아직 공개 목록에 없습니다` is visible. `제품 방문하기 ↗` may already be present. `GET "$SITE/p/<slug>"` is HTTP 200.
- **Verified page.** After verify, reload `/p/<slug>`. The unverified section is gone. A control `제품 방문하기 ↗` has `href="/go/<slug>"`.
- **Metrics.** The region `NoMoreVibe 유입 및 가동 지표` is present on a listed product.
- **Missing slug.** Run `curl -sS -o /tmp/nomorevibe-verify-$RUN_ID/evidence/product-detail/missing.html -w "%{http_code}" "$SITE/p/does-not-exist-slug"`. Expect HTTP 404.
- **JSON view.** Run `curl -sS "$SITE/api/products/<slug>"`. The body includes `slug`, `name`, `status`, and does not include `editToken` / `edit_token`.
- **Proof.** Screenshot verified detail to `/tmp/nomorevibe-verify-$RUN_ID/evidence/product-detail/verified.png`. The image shows the product name and `제품 방문하기 ↗`.

## Gotchas

- Unverified pages are `noindex`. That is expected and not a render failure.
- Seeded crawler products can be unclaimed. Owner-contact copy is not the maker unverified notice.
- Installable products replace `제품 방문하기 ↗` with an install prompt. Do not fail the recipe if `accessMode` is `installable`.
- Do not treat OG/media absence as a broken detail page. Gallery bytes are a separate media path.
