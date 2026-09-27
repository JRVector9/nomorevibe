# Outbound click

Outbound click is the `/go/<slug>` door from NoMoreVibe to the product URL. The browser is redirected. Qualified visits are recorded when the visitor is not a bot and `VISITOR_HASH_SECRET` is set.

## Sub-features

- `go-redirect` 302s a listed product to its `url`.
- `go-missing` 302s an unknown or banned slug to the site origin.
- `go-records` sets `nmv_visitor` and increments visit state for a non-bot user agent.

## How to get to it (user POV)

- Choose `제품 방문하기 ↗` on `/p/<slug>`.
- Open `/go/<slug>` directly.

## Driving it with verify-nomorevibe

Preconditions:

- A verified (or at least registered) product exists.
- `VISITOR_HASH_SECRET` is 32+ characters or visits are not recorded (redirect still happens).

- **Redirect.** Run `curl -sS -D - -o /dev/null "$SITE/go/<slug>"`. Status 302. `location` is the product URL (the fixture origin).
- **Missing.** Run `curl -sS -D - -o /dev/null "$SITE/go/does-not-exist-slug"`. Status 302. `location` is `$SITE` / the site origin.
- **Browser visit.** In a browser, choose `제품 방문하기 ↗`. The next document is the fixture page heading `Verify Fixture` (or the product URL). A cookie `nmv_visitor` is present for the site origin.
- **Recorded visit.** Reload `/p/<slug>` and read the region `NoMoreVibe 유입 및 가동 지표`. After a non-bot `/go/<slug>` with a valid visitor secret, 유효 방문 is not stuck at a literal unused empty if the product had zero and the click qualified. If the secret is missing, say unverified for recording and still prove the redirect.
- **Proof.** Save the redirect headers (no cookie values needed beyond the cookie name) to `/tmp/nomorevibe-verify-$RUN_ID/evidence/outbound-click/go.headers.txt`.

## Gotchas

- `curl` without `-A` may look like a bot depending on the default agent. Use `-A "Mozilla/5.0 (verification)"` when proving recording.
- The same visitor+slug is deduped for 10 minutes. A second curl is not a second valid visit.
- Bots are still redirected. A 302 is not proof that a visit was counted.
- `robots.txt` disallows `/go/` so crawlers that obey it never hit this path.
