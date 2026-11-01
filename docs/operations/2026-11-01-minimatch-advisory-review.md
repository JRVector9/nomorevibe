# minimatch advisory review — 2026-11-01

Read-only review of Dependabot alert 45, GHSA-g3hv-75wg-m249. Source basis:
`package.json`, `package-lock.json`, `eslint.config.mjs`, and `Dockerfile` at
`325a8b46` (PR 784). No dependency override or alert dismissal was performed.

## Locked dependency paths

Both installed copies have `dev: true` in the lockfile. Arrows below identify
resolved package versions; all paths begin with a root development dependency.

| Resolved path | minimatch requirement |
| --- | --- |
| `eslint@9.39.5 → minimatch@3.1.5` | `^3.1.5` |
| `eslint@9.39.5 → @eslint/config-array@0.21.2 → minimatch@3.1.5` | `^3.1.5` |
| `eslint@9.39.5 → @eslint/eslintrc@3.3.6 → minimatch@3.1.5` | `^3.1.5` |
| `eslint-config-next@16.4.1 → eslint-plugin-import@2.32.0 → minimatch@3.1.5` | `^3.1.2` |
| `eslint-config-next@16.4.1 → eslint-plugin-jsx-a11y@6.10.2 → minimatch@3.1.5` | `^3.1.2` |
| `eslint-config-next@16.4.1 → eslint-plugin-react@7.37.5 → minimatch@3.1.5` | `^3.1.2` |
| `eslint-config-next@16.4.1 → typescript-eslint@8.67.0 → @typescript-eslint/typescript-estree@8.67.0 → minimatch@10.2.6` | `^10.2.2` |
| `eslint-config-next@16.4.1 → typescript-eslint@8.67.0 → @typescript-eslint/parser@8.67.0 → @typescript-eslint/typescript-estree@8.67.0 → minimatch@10.2.6` | `^10.2.2` |

The 3.1.5 copy is at `node_modules/minimatch`; the 10.2.6 copy is at
`node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch`.

## Official range and source reachability

The [GitHub advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)
and [upstream advisory](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
officially mark every version below 11.0.1 affected. The description identifies
attacker-supplied patterns, `firstPhasePreProcess()`, and `optimizationLevel >= 2`.
The [fix](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
bounds expansion and skips large pairwise deduplication.

The [3.1.5 source](https://raw.githubusercontent.com/isaacs/minimatch/v3.1.5/minimatch.js)
does not contain those preprocessing functions or the optimization-level option.
The [changelog](https://raw.githubusercontent.com/isaacs/minimatch/v11.0.3/changelog.md)
places preprocessing in 7.0 and the option in 7.1. This supports an inferred
affected-range discrepancy for the specific reported flaw in 3.1.5; it is not an
official exemption, proof against other flaws, or a reason to silently dismiss
the alert.

The [10.2.6 source](https://raw.githubusercontent.com/isaacs/minimatch/v10.2.6/src/index.ts)
contains the affected code, but defaults to optimization level 1. The inspected
[typescript-estree consumer](https://raw.githubusercontent.com/typescript-eslint/typescript-eslint/v8.67.0/packages/typescript-estree/src/useProgramFromProjectService.ts)
uses the named `minimatch(filePath, pattern, { dot: true })` function for
`allowDefaultProject`, without enabling level 2. The repository ESLint config
does not enable project service. No current triggering call was identified.

No application imports of minimatch were found in the inspected application,
library, or worker scripts. Docker worker/monitor dependencies use
`npm ci --omit=dev`; web targets copy Next standalone output. These are source
observations supporting limited production reachability, not runtime image or
bundle proof. Separately installed model CLI dependency trees are outside this
lockfile review.

## Published upgrade and compatibility evidence

Official registry metadata read on 2026-11-01 showed minimatch 3.1.5 as the newest
3.x, 10.2.6 as the newest 10.x, and 11.0.3 as latest:
[minimatch registry](https://registry.npmjs.org/minimatch).
No same-major patched release was identified for either locked copy.

Published parent versions still request the affected official range:

- [ESLint 10.14.0](https://registry.npmjs.org/eslint/latest): minimatch `^10.2.6`.
- [config-array 0.23.5](https://registry.npmjs.org/%40eslint%2Fconfig-array/latest): `^10.2.4`;
  [eslintrc 3.3.7](https://registry.npmjs.org/%40eslint%2Feslintrc/latest): `^3.1.5`.
- [typescript-estree 8.72.1](https://registry.npmjs.org/%40typescript-eslint%2Ftypescript-estree/latest): `^10.2.2`.
- [import 2.32.0](https://registry.npmjs.org/eslint-plugin-import/latest),
  [jsx-a11y 6.10.2](https://registry.npmjs.org/eslint-plugin-jsx-a11y/latest), and
  [react 7.37.5](https://registry.npmjs.org/eslint-plugin-react/latest): `^3.1.2`.
  Their published ESLint peer ranges stop at 9.x.
- [eslint-config-next 16.4.3](https://registry.npmjs.org/eslint-config-next/latest)
  retains those plugin families and typescript-eslint `^8.56.0`.

A global 3.x-to-11.x override is incompatible with inspected consumers:
[React's plugin](https://raw.githubusercontent.com/jsx-eslint/eslint-plugin-react/v7.37.5/lib/rules/no-danger.js)
calls the CommonJS export as a function; the
[import plugin](https://raw.githubusercontent.com/import-js/eslint-plugin-import/v2.32.0/src/rules/no-internal-modules.js)
uses the default export and `makeRe()`. Upstream removed the default export in
9.0 and `makeRe()` in 11.0. The 11.x named function still fits the inspected
typescript-estree call, but glob matching semantics changed; compatibility of a
scoped override has not been executed or established. Node 24 satisfies the
[11.0.3 engine range](https://raw.githubusercontent.com/isaacs/minimatch/v11.0.3/package.json).

## Verification limits

Only source, lockfile, advisory, and registry inspection was performed. No
package installation, dependency mutation, application execution, test, lint,
typecheck, compiler, build, exploit reproduction, production access, runtime
image inspection, or bundle trace was performed. No test-pass or completed
remediation claim is made. Alert 45 remains unresolved pending an upstream range
clarification or a compatible dependency migration validated through required CI.
