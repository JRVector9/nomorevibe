# Public detail UI localization — 2026-10-13

Objective: implement the I18N-02 public product detail UI for Korean, English,
Simplified Chinese, and Traditional Chinese without changing the approved detail
layout or the product/repository/feedback/star collection and action contracts.

## Scope and implementation

Owned changes are under `app/(public)/[locale]/(content)/p/`,
`components/product-detail/`, and the four `messages/*/detail.ts` catalogs.
The detail page loads only its selected detail catalog into a nested provider.
Public layout common/labels catalogs and serialized server time are inherited.
There are 405 semantic detail keys per locale, including installation prompt and
license comparison prose. Chinese catalogs use distinct regional terminology.

Neutral `publicRead` results are localized afterward through
`localizeProductList`. The product requests tagline and description; related
products request taglines. `ProductTagline` receives its translation selection.
Descriptions prefer a current selection, retain original text, show pending
status, and offer the original when translated. Machine translation provenance
uses the optional selection field supplied by the integration branch.
README markdown, release titles/notes, maker profile prose, and comment bodies
remain their source content. No model is called during rendering.

Display numbers and dates use the shared locale formatting helpers. Client
availability and date display use `useServerNow`; the timeline retains its
explicit server `now` prop. Date formatting and wider timeline date columns
keep the KST year boundary. CSS percentage values remain raw numbers.

Public navigation uses `localePath`. Machine/API links remain bare. Feedback
login returns preserve existing query parameters and intentionally target the
feedback anchor to restore the existing compose intent. Star and private
settings login returns preserve the current fragment as well. A small ordinary
anchor handles the browser-only fragment on the private settings login link.
Maker OAuth POST includes the selected same-page return URL; its server flow
support is an integration task coordinated separately. Callback endpoints and
CSRF/action semantics are unchanged.

The private GitHub settings route stays dynamic, explicitly forces uncached
fetches, and sets `robots: { index: false, follow: false }`. Product-specific
not-found copy, search, and home links select the request locale.

Feedback and star request state stores typed semantic status keys, translated
when rendered. Translation functions do not enter polling callback dependencies.
Known backend error codes map to localized messages. The request form no longer
displays raw API error prose; response status selects a localized explanation.

Some existing domain DTOs expose Korean presentation labels rather than stable
codes. `translatedDetailLabel` is a bounded, explicit presentation adapter for
those known legacy source/observation/coverage/relationship values. Unknown data
text stays raw. Agent/skill evidence uses its stable evidence-level enum. This
is neither DOM text replacement nor a regex translation mechanism. Domain
modules were not changed by this UI commit.

The detail page consumes `detail.relatedTotal` and drops its separate legacy
rising counter. The domain update uses the shared completed eight-hour reader
for rank/related eligibility and was supplied by the integration parent
(`ff8c129`, locally cherry-picked as `c51bea1` for compatibility). Do not
cherry-pick the duplicate domain commit from this branch.

## Commands and actual results

All commands ran in `/private/tmp/nomorevibe-i18n-detail-ui-20261013` with the
existing `node_modules` symlink. No environment file or secret was copied.

- `./node_modules/.bin/next typegen`: exit 0, route types generated.
- `./node_modules/.bin/tsc --noEmit`: final run exit 2 with exactly one old-base
  fixture error: `tests/popular-page.test.tsx:8` imports the removed static
  `metadata` export. No owned source or catalog type error remained. The parent
  confirmed the fixture is already fixed in its integration branch.
- ESLint via Python `subprocess.call(['./node_modules/.bin/eslint', *files])`,
  where `files` are all `.ts/.tsx` files under the two owned source trees and
  `messages/*/detail.ts`: final run exit 0 with no errors or warnings.
- `git diff --check`: exit 0.
- `./node_modules/.bin/next build --webpack`: exit 1 at webpack compilation.
  Exact emitted import trace: `node:net` → `lib/net/normalize.ts` →
  `lib/domain/products/schema.ts` → `components/BrowseFilters.tsx`. These are
  outside detail ownership. The build did not reach TypeScript or prerendering;
  a successful production build is not claimed.

Initial checking caught and corrected an incorrect provider prop name
(`messages` instead of `dictionaries`), a missing JSX brace, unused locale/time
hooks, and an accidental locale-formatted CSS percentage. Installation URL
validation continues to use the existing pure `installationPrompt` helper;
no duplicate validator or Node-only import was introduced for that feature.

No new tests, E2E/browser tests, interactive action tests, DB queries, model
calls, account writes, API mutations, production writes, pushes, or deployments
were performed in this phase.

## Remaining integration work

The parent owns product readiness-aware metadata, final SEO/noindex/hreflang
selection, domain translation provenance, shared card/label integration, maker
OAuth return validation/flow support, and the final integrated build. The auth
feedback permalink must load its selected detail namespace for `FeedbackItem`;
that provider coordination was assigned separately. This report does not claim
those integrations or interactive functional checks are complete.

Next commands on the integration worktree after applying only the detail UI
commit:

```sh
./node_modules/.bin/next typegen
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/eslint components/product-detail messages/*/detail.ts
./node_modules/.bin/next build --webpack
git diff --check
```

Use a literal argv list for the bracketed detail route paths when adding those
files to an ESLint command; shell/glob syntax treats `[locale]` as a character
class. The first quoted glob attempt matched no files and was replaced with the
explicit argv inventory above.
