# Maker verify

Maker verify proves the maker can publish a token on the product origin. Success flips `status` to `verified`, lists the product, and enables `/badge/<slug>`.

## Sub-features

- `verify-file` succeeds when `/.well-known/nomorevibe.txt` equals `verify_token`.
- `verify-meta` succeeds when `<meta name="nomorevibe-verify">` matches (file path used first).
- `verify-fail` stays unverified when the token is missing.
- `badge-verified` returns SVG for a verified slug.
- `badge-unverified` returns 404.

## How to get to it (user POV)

- Run `/nomorevibe verify` from the maker skill.
- Call `POST $SITE/api/products/<slug>/verify` (no edit token).
- Embed `/badge/<slug>.svg` in a README after verify.

## Driving it with verify-nomorevibe

Preconditions:

- A product was just registered against the fixture origin.
- `bin/fixture-site` is still running.
- `verify_token` from the 201 response is available.

- **Unverified badge.** Run `curl -sS -o /dev/null -w "%{http_code}" "$SITE/badge/<slug>"`. Expect 404 and a JSON error that only verified products get a badge.
- **Failed verify.** Run `curl -sS -X POST "$SITE/api/products/<slug>/verify"` before publishing the token. Expect a verification-failed payload whose `expected.file.path` is `/.well-known/nomorevibe.txt`.
- **Publish token.** Run `curl -sS -X POST http://127.0.0.1:4173/set-token --data-binary "<verify_token>"`. Then `curl -sS http://127.0.0.1:4173/.well-known/nomorevibe.txt` equals the token.
- **Verify.** Run `curl -sS -X POST "$SITE/api/products/<slug>/verify"`. JSON `status` is `verified` and `method` is `file`.
- **Idempotent verify.** Repeat POST. JSON includes `already: true`.
- **Listed.** Open `/?sort=recent`. The product name appears. `/sitemap.xml` contains `/p/<slug>`.
- **Badge.** Run `curl -sS -D - "$SITE/badge/<slug>.svg" -o /tmp/nomorevibe-verify-$RUN_ID/evidence/maker-verify/badge.svg`. HTTP 200, `content-type` includes `image/svg+xml`, body starts with `<svg`.
- **Proof.** Save the verify JSON (no secrets beyond the already-public token) and a home screenshot showing the listed card.

## Gotchas

- The server fetches the product origin. The fixture must be reachable from the Next.js process, not only from the browser.
- File match is exact trim of the well-known body. Extra whitespace fails.
- Installable products cannot use this domain verify path.
- Rate limit is 20 verifies per IP per hour.
- A verified product stays listed until takedown/ban or maker delete.
