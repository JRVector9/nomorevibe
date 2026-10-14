# Takedown

Takedown lets anyone ask operators to take down a seeded listing. It does not require an edit token and does not delete the row.

Verification (2026-09-27 local drive): maker-owned reject, seeded receipt, unknown slug, and `/admin/review` showing the reason were proven. Admin ban/approve was not executed.

## Sub-features

- `takedown-submit` accepts `POST /api/products/<slug>/takedown`.
- `takedown-unknown` rejects a missing slug.
- `takedown-queue` shows the request on `/admin/review` for a local admin.

## How to get to it (user POV)

- Submit the request form on a product detail page (unclaimed/seeded listings).
- Call `POST $SITE/api/products/<slug>/takedown` with optional `{"reason":"..."}`.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- An unclaimed seeded product exists (`status=seeded`, `claimedAt` null). A maker-verified product is the wrong target.
- `takedown-queue` needs `ADMIN_LOCAL_LOGIN=1`.

- **Owned product.** POST `/api/products/<verified-slug>/takedown`. JSON error is `주인이 있는 제품입니다. 수정 키로 직접 삭제할 수 있습니다`.
- **Submit.** POST `/api/products/<seeded-slug>/takedown` with `{"reason":"verification fixture takedown"}`. JSON `received: true` and message `요청을 받았습니다. 확인 후 내려드리겠습니다.`
- **Unknown.** POST the same path with slug `does-not-exist-slug`. Expect `제품을 찾을 수 없습니다`.
- **Admin queue.** Open `/admin/review`. The seeded slug and reason appear. Do not approve/ban unless the recipe is explicitly testing moderation; approving bans the product.
- **Proof.** Save the 200 JSON to `/tmp/nomorevibe-verify-$RUN_ID/evidence/takedown/received.json`. Screenshot the admin review takedown row if present.

## Gotchas

- Success is receipt, not removal. The product stays visible until an admin acts.
- Rate limit is 5 per slug per IP per hour.
- Maker-owned / claimed products are rejected. That 403-class error is proof of the ownership boundary, not a failed takedown of a seeded listing.
- Do not click admin ban during a shared verification database run unless you recreate the fixture afterward.
