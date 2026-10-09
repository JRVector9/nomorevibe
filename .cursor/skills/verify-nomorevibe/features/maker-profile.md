# Maker profile

Maker profile is the authenticated evidence the maker declares after register: introduction, official links, updates, refresh queue, optional media, and optional provenance. Every write uses `X-Edit-Token`.

Verification (2026-09-27 local drive): profile PUT+re-GET, update create, links PUT, provenance PUT, and refresh 202 were proven. Media returned 202 `queued` (declaration only). Worker ingest of gallery bytes was not proven.

## Sub-features

- `profile-roundtrip` GET/PUT `/api/products/<slug>/profile`.
- `update-create` POST `/api/products/<slug>/updates`.
- `links-roundtrip` GET/PUT `/api/products/<slug>/links` with a public official URL.
- `refresh-queue` POST `/api/products/<slug>/refresh` returns 202.
- `provenance-roundtrip` GET/PUT `/api/products/<slug>/provenance` with `maker_reported` only.
- `media-roundtrip` GET/PUT `/api/products/<slug>/media` with a public image URL.

## How to get to it (user POV)

- Run `/nomorevibe profile`, `links`, `media`, `provenance`, `update`, or `refresh` from the maker skill.
- Call the same HTTP routes with `X-Edit-Token`.

## Driving it with verify-nomorevibe

Preconditions:

- A product exists and the edit token is available.
- Profile/links/media/provenance are full replacements: GET first, merge, then PUT with `If-Match`.
- `links` and `media` URLs must be public https hosts. Loopback URLs fail `safeHttpUrl`.

- **GET profile.** `curl -sS "$SITE/api/products/<slug>/profile" -H "X-Edit-Token: <edit_token>"`. HTTP 200. Record the `ETag`.
- **PUT profile.** PUT JSON:

```json
{
  "problem": "Agents claim fixes without driving the app.",
  "targetUsers": "Verification agents",
  "keyFeatures": ["Feature map"],
  "useCases": ["Prove a listing"],
  "pricingModel": "free",
  "lifecycle": "prototype",
  "platforms": ["web"],
  "longDescriptionMarkdown": "Local verification fixture.",
  "team": [{"name": "Verify Agent", "role": "operator"}]
}
```

Use `-H "If-Match: <etag>"`. Success JSON is `{ "slug", "saved": true, "evidence_label": "메이커 제공" }`. Re-GET and confirm `profile.problem` matches.

- **Create update.** POST `$SITE/api/products/<slug>/updates` with `{"title":"Verification note","summary":"Driven from the verify skill."}`. HTTP 201, `created: true`, `source: "maker"`. Open `/p/<slug>` and find the title in the update timeline.
- **PUT links.** GET `/links`, then PUT `{"links":[{"kind":"documentation","url":"https://github.com/JRVector9/nomorevibe"}]}` with `If-Match`. Re-GET contains that URL. (Host-specific kinds such as `repository` require a `github.com/owner/repo` shape.)
- **Queue refresh.** POST `$SITE/api/products/<slug>/refresh`. HTTP 202, `{"queued":true}`. This is not completion. Completing `product-evidence-refresh` needs outbound fetches and is often unverified without network/token conditions.
- **PUT provenance.** GET `/provenance`, then PUT `{"agents":[{"provider":"cursor","roles":["implementation"],"evidenceLevel":"maker_reported"}],"skills":[]}` with `If-Match`. Re-GET shows the agent. Any `evidenceLevel` other than `maker_reported` is 400.
- **PUT media.** GET `/media`, then PUT `{"items":[{"url":"https://www.w3.org/Icons/WWW/w3c_home.png","altText":"W3C home icon"}]}` only if the URL is a public JPEG/PNG/WebP. A successful declaration returns HTTP 202 with `queued: true` and `count`. That is not processed WebP bytes. Completing ingest needs the media worker path; if bytes never appear on `/p/<slug>`, mark ingest unverified and keep the 202 as queue proof.
- **Proof.** Save redacted GET bodies after each successful write under `/tmp/nomorevibe-verify-$RUN_ID/evidence/maker-profile/`. Screenshot `/p/<slug>` showing the new profile sentence or update title.

## Gotchas

- 412 means another write landed. Re-GET and start over. Do not retry the old ETag.
- Links/media rewrite http to https and reject localhost. A fixture URL will not store as a link.
- Refresh 202 only enqueues. Do not claim evidence freshness from the 202 alone.
- Media stores processed WebP bytes in Postgres. A 200 with `count: 0` after a rejected image is a failed media proof.
- Do not upload `.env`, credentials, or skill prompt text into profile markdown.
