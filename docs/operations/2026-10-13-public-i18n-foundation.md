# Public i18n foundation — 2026-10-13

## Scope and state

I18N-01 implements the shared locale registry, typed catalogs, public routing,
document language, shell navigation, locale switching, and public auth return
validation. Public page bodies, AccountMenu, category/product-specific 404 copy,
SeasonFooter, full translated content, and locale SEO readiness remain subsequent
phases. This report does not claim the whole public UI is translated or ready to
index. Non-Korean public roots currently default to noindex.

Worktree: `/private/tmp/nomorevibe-i18n-foundation-20261013`; branch:
`feat/public-i18n-foundation-20261013`. No production, PR, push, DB mutation,
interactive browser, copied environment file, new dependency, or LLM translation
was used. Parent owns `docs/CODEX_HANDOFF.md` and integration/deployment.

## Interfaces and route ownership

- `lib/i18n/locales.ts`: `Locale`, `LOCALES`, `DEFAULT_LOCALE`, `isLocale`,
  `LOCALE_CONFIG`, and the proxy-owned `PUBLIC_LOCALE_HEADER`.
- `lib/i18n/routing.ts`: pure `localePath`, `stripLocale`, `switchLocale`,
  `pathLocale`, `isLocaleExcludedPath`, and `safePublicReturnUrl`.
- `lib/i18n/messages.ts`: Korean semantic key/interpolation schemas,
  `defineCatalog`, `createTranslator`, and namespace/translator types.
- `lib/i18n/dictionary.ts`: server-only `getDictionary(locale, namespace)` and
  `getTranslator`, dynamically loading one selected locale/namespace.
- `lib/i18n/context.tsx`: `I18nProvider`, `useLocale`, `useTranslations`.
  Nested providers inherit same-locale slices, enabling a page namespace below
  the common shell. Missing keys/slices/arguments fail explicitly.
- `lib/i18n/server.ts`: server-only `getRequestLocale()` validates the sanitized
  request header. Domain modules never read Next request state for locale.

Definitive shared bodies are in `app/(public)/[locale]/(content)`: home, c, p,
rising, popular, rankings, login, feedback, launch, policy, and @seasonfooter.
The route groups do not change URLs. There are no per-locale page copies.
Operator routes are in `app/(operator)/admin`; their URLs and inner AdminShell
authorization checks are unchanged.

Early API commit: `5e5abae670c3a2bf675bbfd80d63cd9863b1dbda`.
Initial pure route move: `5fe110e0a88d0a1cfd2db5cdafbef9879853714c`.
Nested content/slot pure move: `913e2e1849f9709ee4580a88186d78f29f81c259`.
Existing test imports, generated route prop fixtures, and filesystem source
references were adapted; no new test cases were added or executed.

Parent should register completed `browse` and `detail` schemas/loaders in
messages.ts/dictionary.ts after the independent catalog commits. Only `common`
and `globalError` are registered here.

## Decisions

Korean external URLs remain unprefixed; `/ko/...` public addresses redirect 308
to their Korean canonical path with query preserved. The proxy internally
rewrites Korean public paths to the single shared locale tree. Admin protection
runs first, with only exact `/admin/login` and its trailing-slash form public.
Missing/short AUTH_SECRET remains fail-closed. API, admin, _next, /go, /badge,
feeds, public files, webhooks, and OAuth machine paths are excluded from locale
rewrites. Prefixed machine/admin paths are genuine public 404s, never endpoint
aliases. Helpers leave machine links unprefixed. Public identifiers under
p/c/rankings/feedback are never classified as files merely because they contain
dots or an asset-like suffix.

The reviewed architecture refinement uses one `app/layout.tsx` HTML document
root and inner public/operator layouts. The proxy overwrites any incoming locale
header on every next/rewrite branch, including admin/machine branches; operator
documents are Korean. Public `[locale]/layout.tsx` independently validates its
explicit route param before supplying only the selected common dictionary.
App-level unmatched 404s create their own selected provider/public shell. This
avoids experimental globalNotFound and fixes the observed multiple/dynamic-root
unmatched-URL regression.

Language switching uses ordinary full-document anchors, preserving pathname,
query, and hash, so the document root language changes reliably. Choice labels
are 한국어, English, 简体中文, 繁體中文; all touch targets are at least 44px.
Same-locale shell navigation keeps Next Link. OnlyOnHome strips registered locale
prefixes. The season slot keeps its default fallback and home-only data read;
soft navigation still hides retained slot content without adding season reads
to every page.

The root error component cannot depend on a failed provider. It includes only a
standalone six-message error slice for each locale, selected from the router
pathname; it does not bundle full catalogs. This narrowly scoped exception was
explicitly approved by the parent. No DOM replacement, runtime LLM, or page-copy
translation mechanism exists.

`safeReturnUrl` in accounts/request-auth delegates to the pure locale-aware
validator. Relative parser-escape protections remain; actual public routes are
allowed, admin/API/machine returns are rejected, and localized public return
paths survive. Existing OAuth and email callback endpoints were not moved.

## Executed verification

Installed Next 16.3.8 internationalization, layouts, route groups, not-found,
proxy, root-params, and error guides were read before implementation.

Final clean build command, executed in the foundation worktree:

```sh
node node_modules/next/dist/bin/next build --webpack
```

Exit 0: compilation, TypeScript, static page generation, and traces completed;
27 static generation tasks; expected single locale route tree and unchanged
operator/machine URLs were listed. Node_modules is a symlink to the existing
repository install; generated outputs are worktree-local.

```sh
node node_modules/next/dist/bin/next typegen
node node_modules/typescript/bin/tsc --noEmit --incremental false
git diff --check
```

All actually executed, exit 0. Unit/integration/E2E suites, lint, interactive
functional tests, account writes, and valid-product DB reads were not run.

Read-only local production server:

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="$TMPDIR" NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next start --port 4397
```

The server warned that standalone output prefers `.next/standalone/server.js`;
the read-only local requests below were served successfully by this command.
No DATABASE_URL or authentication secret was supplied. Thirty GETs, with
redirects disabled and every request spoofing `x-nmv-public-locale: zh-Hant`,
were executed. Actual compact results are also in the local non-secret artifact
`/private/tmp/nomorevibe-i18n-foundation-30-get-20261013.json`.

| Requests | Actual result |
| --- | --- |
| `/policy`, `/en/policy`, `/zh-Hans/policy`, `/zh-Hant/policy` | 200, matching html lang, public shell; non-Korean noindex |
| `/unknown-route` at all four locale prefixes | 404, matching html lang, public shell, noindex |
| `/c/no-category` and `/p/version.v2` at all four prefixes | Real 404/noindex; baseline explicit SSR error-document limitation below |
| `/fr/p/example` | 404, Korean fallback shell/lang, noindex |
| `/ko/policy?q=keep` | 308 to `/policy?q=keep` |
| `/ko/admin`, `/en/admin`, `/ko/api/health`, `/zh-Hant/api/health` | 404, matching fallback lang/shell/noindex; no aliases |
| `/admin`, `/admin/products` | 307 to `/admin/login`, fail-closed |
| `/admin/login` | 200, Korean operator document/noindex, no public shell |
| `/api/me`, `/api/health` | Existing JSON 404 (auth disabled), JSON 503 (DB unavailable); no rewrite |
| `/robots.txt`, `/install.sh`, `/skill.md` | Existing 200 plain/shell/Markdown responses; no rewrite |

## Failed approaches and baseline limitation

The default Turbopack build failed because the external node_modules symlink is
outside its filesystem root. Webpack build was used without changing production
configuration. A diagnostic `next dev --webpack` also failed instrumentation's
postgres `net` resolution; it gave no application 404 evidence. Stale generated
dev/old route types were preserved in /private/tmp diagnostic directories and
the final .next build was fresh.

Multiple/dynamic document roots initially caused all unmatched public URLs to
return 404/noindex but `<html id="__next_error__">` without lang or shell. Moving
the footer slot into `(content)` alone did not fix this. Experimental
globalNotFound fixed unmatched routes but did not fix explicit category/product
notFound responses. Full-document not-found reexports and nearest static
resource fragment layouts also failed. These experiments, catch-all/debug
routes, root-params getter, and experimental flag were removed from final code.
The single document root fixes unmatched URLs without the flag.

Explicit nonstreamed notFound SSR has a **proven pre-existing limitation**:
untouched baseline `79fea63b81ab6ff72971970d775d2ea225bd7097` was built in detached
`/private/tmp/nomorevibe-i18n-baseline-20261013` with the same installed Next and
served with the same clean environment on port 4399. `/c/no-category` and
`/p/version.v2` returned 404/noindex but no lang, shell, or h1, with
`__next_error__`; baseline `/unknown-route` returned a complete Korean shell.
A temporary no-metadata/no-slot explicit notFound diagnostic under the new
single root reproduced the same empty error document. Installed
app-render.js getErrorRSCPayload explicitly builds that error document. Thus
this is not a new locale/parallel-slot regression. No 200/Suspense workaround,
dependency patch, or per-request proxy DB pre-read was introduced. The parent
accepted reporting the truthful baseline limitation separately from i18n work.

Missing-product checks used an invalid-format slug which returns null before DB
access. Valid existing/missing product reads and browser hydration of explicit
404s were not verified. This report does not claim explicit SSR 404 shell/lang
was fixed. Product/category 404 UI localization is still the next phase.

## Remaining integration

Merge FILTER changes before the pure route move, then this foundation. Continue
UI namespaces and content translations, locale-aware auth entry points and
return flows, page titles/SEO/readiness and route redirects/links. User should
check native language switching (query/hash/mobile), normal hard/soft navigation,
season slot behavior, missing product/category after hydration, and authenticated
flows. Stop the local servers after recording proof; no foundation deployment
has occurred.
