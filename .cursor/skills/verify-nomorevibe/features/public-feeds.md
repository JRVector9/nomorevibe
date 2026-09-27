# Public feeds

Feeds and crawler files tell subscribers and search engines what is listed. The sitemap carries verified products only. The RSS feed lists recently discovered verified and seeded products.

Verification (2026-09-27 local drive): robots, empty-then-populated sitemap/feed, and the `2026-W40` sitemap entry were proven.

## Sub-features

- `feed-xml` returns RSS 2.0 from `/feed.xml`.
- `sitemap-xml` returns the dynamic sitemap from `/sitemap.xml`.
- `robots-txt` disallows `/go/`, `/admin`, and `/api/`.

## How to get to it (user POV)

- Open `/feed.xml` from a feed reader or the document `application/rss+xml` link.
- Open `/sitemap.xml`.
- Open `/robots.txt`.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- A verified product makes sitemap and feed assertions stronger; empty documents are still valid.

- **Feed.** Run `curl -sS -D - "$SITE/feed.xml" -o /tmp/nomorevibe-verify-$RUN_ID/evidence/public-feeds/feed.xml`. Status 200. Body contains `<rss` and a self link to `/feed.xml`. After verify, an item title includes the product name or a seeded/verified label.
- **Sitemap.** Run `curl -sS "$SITE/sitemap.xml"`. Body contains `$SITE/` and `$SITE/launch`. After verify, it contains `$SITE/p/<slug>`. Unverified slugs are absent.
- **Robots.** Run `curl -sS "$SITE/robots.txt"`. Body contains `Disallow: /go/`, `Disallow: /admin`, `Disallow: /api/`, and `Sitemap: $SITE/sitemap.xml`.
- **Proof.** Keep the three response bodies under `/tmp/nomorevibe-verify-$RUN_ID/evidence/public-feeds/`.

## Gotchas

- Feed titles add a text badge because readers have no UI badge. Do not require a checkmark character.
- Sitemap omits unverified products on purpose.
- `robots.txt` is generated at request time from `NEXT_PUBLIC_SITE_URL`. A leftover `localhost` sitemap URL means the env is wrong.
