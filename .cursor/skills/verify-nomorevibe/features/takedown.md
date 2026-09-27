# Takedown

Takedown lets anyone ask operators to take down a seeded listing. It does not require an edit token and does not delete the row.

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
- A product slug exists (verified fixture is acceptable for the API; the product UI form is aimed at unclaimed seeded listings).
- `takedown-queue` needs `ADMIN_LOCAL_LOGIN=1`.

- **Submit.** Run `curl -sS -X POST "$SITE/api/products/<slug>/takedown" -H 'content-type: application/json' -d '{"reason":"verification fixture takedown"}'`. JSON `received: true` and message `요청을 받았습니다. 확인 후 내려드리겠습니다.`
- **Unknown.** POST the same path with slug `does-not-exist-slug`. Expect a not-found error.
- **Admin queue.** Open `/admin/review`. A pending takedown for the slug is listed. Do not approve/ban unless the recipe is explicitly testing moderation; approving bans the product.
- **Proof.** Save the 200 JSON to `/tmp/nomorevibe-verify-$RUN_ID/evidence/takedown/received.json`. Screenshot the admin review takedown row if present.

## Gotchas

- Success is receipt, not removal. The product stays visible until an admin acts.
- Rate limit is 5 per slug per IP per hour.
- Maker-owned products are supposed to be deleted with the edit token, not this window. The API may still accept a request; do not treat that as a delete.
- Do not click admin ban during a shared verification database run unless you recreate the fixture afterward.
