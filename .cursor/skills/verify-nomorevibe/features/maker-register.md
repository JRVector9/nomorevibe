# Maker register

Maker register creates an unverified product from a live URL. The same edit token later PATCHes fields or DELETEs the product.

## Sub-features

- `register-create` accepts `POST /api/products` and returns slug plus tokens.
- `register-duplicate` rejects a second register of the same URL.
- `register-unreachable` rejects a URL that does not fetch.
- `register-patch` updates name/tagline with `X-Edit-Token`.
- `register-delete` removes the product with `X-Edit-Token`.

## How to get to it (user POV)

- Run `/nomorevibe` from the installed maker skill (Claude Code or Codex).
- Call `POST $SITE/api/products` with the same JSON the skill sends.
- Call `PATCH` / `DELETE $SITE/api/products/<slug>` with `X-Edit-Token`.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- `ALLOW_PRIVATE_URLS=1` is set so `http://127.0.0.1:4173` is accepted.
- `bin/fixture-site` is listening on `http://127.0.0.1:4173`.
- Keep tokens in memory or a 600-mode file outside the repo. Never echo them into evidence.

- **Create.** Run:

```bash
curl -sS -X POST "$SITE/api/products" -H 'content-type: application/json' -d '{
  "url": "http://127.0.0.1:4173",
  "name": "Verify Fixture",
  "tagline": "Local verification fixture",
  "description": "A disposable product used to prove register, verify, and detail.",
  "category": "Dev"
}'
```

HTTP 201. JSON includes `slug`, `status: "unverified"`, `page_url` ending in `/p/<slug>`, `edit_token`, `verify_token`, and `verify.file.path` = `/.well-known/nomorevibe.txt`.

- **Public GET.** Run `curl -sS "$SITE/api/products/<slug>"`. `status` is `unverified`. Tokens are absent.
- **Duplicate.** Repeat the POST. HTTP 409-class error (`duplicate`) and the existing `slug`.
- **Unreachable.** POST with `"url":"http://127.0.0.1:1/"`. The error mentions that the URL could not be reached.
- **Patch.** `PATCH "$SITE/api/products/<slug>"` with header `X-Edit-Token: <edit_token>` and body `{"tagline":"Updated fixture tagline"}`. JSON `updated: true`. GET again shows the new tagline.
- **Delete.** `DELETE "$SITE/api/products/<slug>"` with `X-Edit-Token`. JSON `deleted: true`. Subsequent GET is not found. Recreate the fixture if later features still need it.
- **Proof.** Save redacted 201 JSON (tokens stripped) to `/tmp/nomorevibe-verify-$RUN_ID/evidence/maker-register/create.json`.

## Gotchas

- Registration fetches the URL. A stopped fixture site looks like an unreachable product.
- Without `ALLOW_PRIVATE_URLS=1`, loopback URLs fail the SSRF guard.
- Rate limit is 10 registers per IP per hour. Do not loop this recipe.
- `edit_token` is shown once at create (and again only on claim). Losing it blocks PATCH/DELETE.
- Do not store tokens in `.nomorevibe.json`. That file is slug/url/api only.
