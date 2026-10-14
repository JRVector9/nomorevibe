# NoMoreVibe verification map

This directory is the maintained source for verifying user-facing behavior. Read this index, then use the matching feature file as the recipe. Only features that exist in the running app are listed. Gaps are named; invented product surfaces are not.

## Baseline preconditions

- Launch from `.cursor/skills/verify-nomorevibe/SKILL.md` so PostgreSQL 17 is on `127.0.0.1:55434` and the web app answers at `http://localhost:3000`.
- Load `.env.local` with `ALLOW_PRIVATE_URLS=1` when registering loopback fixture URLs.
- Set `ADMIN_LOCAL_LOGIN=1` before driving admin pages. GitHub OAuth admin is a separate, usually unverified path.
- Run `.cursor/skills/verify-nomorevibe/bin/doctor` and require `status=ok`, `db=ok`, and the home heading.
- Start `bin/fixture-site` before any maker register/verify recipe.
- Never drive an instance this run did not start. Never commit `.env.local` or edit tokens.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors.
- Treat every command as literal. Keep quoted Korean labels unchanged.
- HTTP writes that mutate maker resources GET first, then PUT with `If-Match`.
- Redact `X-Edit-Token`, `verify_token`, `edit_token`, and secrets in saved evidence.
- Restore or delete fixture products after a mutation. Keep proof artifacts.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes a screenshot with the NoMoreVibe brand or heading visible.
- HTTP proof includes status code and a redacted body.
- Job proof includes the command, stdout, and exit code.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-nomorevibe` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Home discovery](./home-discovery.md) covers the public home boards, sort tabs, save, and methodology dialog.
- [Catalog search](./catalog-search.md) covers header search, empty results, and query URLs.
- [Product detail](./product-detail.md) covers `/p/<slug>` for unverified and verified products.
- [Rankings and popular](./rankings-and-popular.md) covers season ranking pages and `/popular`.
- [Launch and skill](./launch-and-skill.md) covers `/launch`, `/skill.md`, and `/install.sh`.
- [Public feeds](./public-feeds.md) covers `/feed.xml`, `/sitemap.xml`, and `/robots.txt`.
- [Maker register](./maker-register.md) covers `POST /api/products` and authenticated PATCH/DELETE.
- [Maker verify](./maker-verify.md) covers domain ownership proof and the verified badge.
- [Maker profile](./maker-profile.md) covers profile, links, updates, refresh, media, and provenance.
- [Takedown](./takedown.md) covers the public takedown request.
- [Outbound click](./outbound-click.md) covers `/go/<slug>` redirects and visit recording.
- [Health](./health.md) covers `GET /api/health`.
- [Admin console](./admin-console.md) covers local-login pages, GitHub collector accounts, review stages, and worker status.
- [Jobs and cron](./jobs-and-cron.md) covers one-tick jobs, crawl handoffs, worker progress, and the cron enqueue API.

## 2026-09-27 generator drive

Each feature file's opening paragraph records what this run actually proved. HTTP/job recipes were executed against a local Next.js 16 + PostgreSQL 17 instance. Headed click paths (save toggle, methodology dialog, Control+K) were not completed because the computer-use agent could not start. GitHub crawl growth and Claude/Codex jobs stayed unverified (no tokens).

## Known gaps (not mapped as working features)

- GitHub OAuth admin (`/api/auth/github`) needs `GITHUB_OAUTH_*` and is not driven here.
- Crawl seed/fetch and evidence refresh against GitHub need `GITHUB_TOKEN` or a registered collector PAT with `GITHUB_COLLECTOR_SECRET`.
- AI review and intro check need their configured reviewer credentials; text jobs need `ABCLLM_API_KEY`, and publisher classification needs its Codex connection or CLI credentials.
- `product-intro-check` stays off unless an operator explicitly resumes it (`PENDING.md`).
- Compose production topology (`localhost:3200`) is an operations path, not this skill's default launch.
