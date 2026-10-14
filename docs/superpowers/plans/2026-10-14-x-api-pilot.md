# X Official API Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The current authorized owner executes inline; no recursive agents or Codex calls, commits, network calls, credential inspection, or edits outside the four files below.

**Goal:** Prepare a safe first authenticated X search/lookup acceptance pilot, with dry-run as the default and no HOT feature or production pipeline integration.

**Architecture:** A standalone TypeScript module plans one recent-search page and up to two ten-ID lookup batches. An explicit live flag, documented use-case approval flag, and Bearer token are all required before HTTP. The CLI prints only bounded sanitized observations and can exclusively create an explicitly requested private file.

**Tech Stack:** Node fetch/AbortController/Web Streams, TypeScript, Vitest, existing tsx CLI tooling. No database, crawler, LLM, redirect traversal, or external link fetch.

---

## Authorized contract and assumptions

The root agent owns console/token/use-case confirmation, `.env.example`, package scripts, README integration, and handoff. This child never buys credits or performs live HTTP. The feasibility report's first acceptance step remains pending until an approved authenticated invocation actually verifies fields, metrics, access errors, and console charges.

Only `https://api.x.com/2/tweets/search/recent` and `https://api.x.com/2/tweets` are request destinations. One query, one page, search `max_results=10`, `sort_order=recency`, default previous 24 hours. Always wrap the complete user query in parentheses and append an outer mandatory `-is:retweet`; query length including the wrapper and filter is at most 512. Inputs contain at most ten distinct provided numeric post IDs. Search candidates plus provided IDs allow at most twenty unique lookup IDs, split into at most two batches of ten: three requests and thirty conservative post-resource reservations, even when IDs repeat across search/lookup. There is no pagination, retry, parameter fallback, or cost deduction assumption.

An invocation has a single 20-second absolute deadline including response body reads and at most 1 MiB per response. HTTP 429 reports status and a bounded Retry-After estimate; it never waits or retries. Error body/message, token, post text/media, author IDs, and profile fields never reach output. Successful observations contain only post ID, created/observed timestamps, trusted `entities.urls.expanded_url`/`unwound_url` GitHub owner/repository keys, nullable public metrics, and availability/link state. Exact HTTPS/HTTP `github.com` host only; no credentials, external URL requests, or text-based URL parsing. Multiple distinct repository keys are ambiguous. Lookup omissions remain unknown; explicit resource access/not-found errors are unavailable without claiming deletion.

`tweet.fields` is the default per canonical API examples. `--fields-parameter post.fields` explicitly selects the alternate endpoint-reference spelling. Either is reported as needing live validation; a rejected spelling does not trigger another call.

HTTP 200 alone is not a successful observation: require legitimate post data, or an empty search with `meta.result_count=0` and no errors. A lookup data array without errors may be empty, preserving omitted requested IDs as unknown. Empty objects and errors-only responses stop with a fixed `invalid_response` reason; partial legitimate data plus errors remains usable. Immediately after a bounded lookup JSON object is parsed and the deadline checked, project recognized resource-denial errors and data markers for requested IDs to unavailable and clear previous metrics/links. Perform this projection before rejecting malformed endpoint structure, invalid items, or excess rows; stopped status and reservations remain unchanged. Never project unsolicited IDs. Generic errors do not establish unavailability or deletion. Within a response, any withheld/access-unavailable marker for an ID dominates other copies of that ID, regardless of order, and clears all metrics and repository links.

## File ownership

- `lib/social/x-pilot.ts`: gate, plan, fixed requests, bounded deadline/body, sanitization, metrics completeness.
- `scripts/x-api-pilot.ts`: strict CLI arguments, token read only in live mode, sanitized stdout, exclusive mode-0600 optional output.
- `tests/x-api-pilot.test.ts`: real module/CLI contracts with injected fetch and temporary local output; no HTTP or DB.
- This plan: requirements, actual RED/GREEN evidence, next commands.

## Task 1: Dry-run and live gates

- [x] Write tests for zero-call default, missing approval/token, invalid IDs/query/field spelling, and CLI defaults before implementation.

```ts
const request = vi.fn();
expect(await runXPilot({}, { request })).toMatchObject({ mode: "dry-run", status: "planned", requests: [] });
expect(request).not.toHaveBeenCalled();
expect(await runXPilot({ live: true, token: "fixture" }, { request })).toMatchObject({ reason: "use_case_not_approved" });
expect(parseXPilotArgs([])).toEqual({ live: false, useCaseApproved: false, fieldsParameter: "tweet.fields", lookupIds: [] });
```

- [x] Execute `npm test -- tests/x-api-pilot.test.ts`; record the actual missing-contract RED.
- [x] Implement `runXPilot(options, dependencies)` and `parseXPilotArgs(args)` gates, strict fixed-endpoint plan, and CLI main guard. Every validation failure has a fixed reason and zero calls.
- [x] Re-execute the same command to verify gate/default assertions are GREEN.

## Task 2: Bounded authenticated observations

- [x] Add failing tests for selected fields parameter, fixed endpoint/manual redirect, three-request/thirty-post bound, total timeout, 1-MiB body, 429/Retry-After, invalid/error JSON, and sanitized output.

```ts
const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "123", created_at: "2026-10-14T00:00:00Z", text: "must disappear", author_id: "private", entities: { urls: [{ expanded_url: "https://github.com/Owner/Repo" }] }, public_metrics: { like_count: 0 } }] })));
const result = await runXPilot({ live: true, useCaseApproved: true, token: "fixture", fieldsParameter: "post.fields" }, { request });
expect(result.observations[0]).toMatchObject({ id: "123", repositories: ["owner/repo"], metrics: { like_count: 0, reply_count: null } });
expect(JSON.stringify(result)).not.toContain("must disappear");
```

- [x] Execute the same focused test command and inspect actual behavioral RED.
- [x] Implement the absolute abort deadline and streaming byte cap, allowlisted observation projection, exact-host repo extraction, ID/repo deduplication, withheld/access markers, and explicit lookup omission states.
- [x] Re-execute focused tests; review that failed HTTP has no retry/fallback and no response text leak.

## Task 3: Private optional observation file and final verification

- [x] Add failing tests for strict CLI flags, exclusive output creation, mode 0600, and existing-file preservation.

```ts
await writeXPilotOutput(path, result);
expect((await stat(path)).mode & 0o777).toBe(0o600);
await expect(writeXPilotOutput(path, result)).rejects.toThrow();
```

- [x] Execute focused tests to establish the output-contract RED.
- [x] Implement an explicit `--output` path with exclusive creation; write only the already sanitized result. Generic CLI failures redact underlying errors.
- [x] Execute `npm test -- tests/x-api-pilot.test.ts`, `npx tsc --noEmit --incremental false`, and `npx eslint lib/social/x-pilot.ts scripts/x-api-pilot.ts tests/x-api-pilot.test.ts`. Run `npx tsx scripts/x-api-pilot.ts` once in default dry-run mode only.
- [x] Record actual results below and send root the exact next commands. Root owns commits and independent review.

## Task 4: Independent review corrections

- [x] Add regressions before implementation for HTTP-200 empty/errors-only structures, legitimate empty search metadata, partial data, duplicate denial in both orders for search/lookup, and nested repost filters plus the full query length boundary.
- [x] Execute `npm test -- tests/x-api-pilot.test.ts -t 'review regression'`: actual RED, exit 1, 11 failed / 3 passed / 31 skipped. Refine the duplicate fixture to return fresh responses, then execute `npm test -- tests/x-api-pilot.test.ts -t 'denial dominates'`: actual RED, both failed because availability, repository links, and metrics survived the later denial.
- [x] Require endpoint success structures, enforce denial dominance, and always append the globally scoped repost filter.
- [x] Execute focused regressions, the full pilot tests, TypeScript, scoped lint, and default dry-run; record actual results and freeze the owned files for the root's next review.

## Task 5: Denied lookup state before stopping

- [x] Add tests for a successful searched candidate followed by an errors-only lookup with each recognized resource-denial type, plus a generic error that cannot establish unavailability.
- [x] Execute `npm test -- tests/x-api-pilot.test.ts -t 'errors-only lookup explicitly'`: actual RED, exit 1, 4 failed / 46 skipped. Previous available repository data remained after each recognized denial.
- [x] Project only recognized requested-ID denials before stopping the invalid response, without another call or retaining error payloads.
- [x] Execute full pilot tests, TypeScript, scoped lint, and default dry-run; record results and freeze the files again.

## Task 6: Denial projection before all parsed lookup validation

- [x] Add one-requested-ID duplicate regressions for all three denial markers in both orders, known resource errors coexisting with excess rows, malformed data/error collections and items, and unsolicited/generic-error filtering.
- [x] Execute `npm test -- tests/x-api-pilot.test.ts -t 'round2 regression'`: actual RED, exit 1, 13 failed / 1 passed / 50 skipped. Duplicate, excess-row, and malformed-structure denials left old available data; unsolicited/generic filtering already passed.
- [x] Consolidate requested-ID denial extraction from data and known errors, and project it immediately after bounded parse/deadline check, before endpoint structure/item/row-cap rejection.
- [x] Execute focused regressions, full pilot tests, TypeScript, scoped lint, and default dry-run; record actual results and freeze for root round3. Repository-wide TypeScript failed outside the owned files; the root must resolve that remaining check.

## Operator commands and data handling

Default zero-call plan: `npx tsx scripts/x-api-pilot.ts`.

After the root independently confirms the approved use case, console credits/spending limit, and the token is provisioned without printing it: `npx tsx scripts/x-api-pilot.ts --live --use-case-approved --fields-parameter tweet.fields`. Alternate spelling is a separate explicitly authorized invocation: `--fields-parameter post.fields`; no automatic retry. Optional `--lookup-ids 123,456` must contain actual known numeric post IDs. Optional `--output /private/tmp/x-pilot-observations.json` exclusively creates a mode-0600 local file.

Outputs are private acceptance observations, not a public JSON endpoint or redistribution feed. Do not publish raw responses, copy text/media/profiles, infer missing means deleted, score HOT from one sample, enqueue repos, or modify approval/publication criteria. This pilot does not measure global popularity or prove actual billing deduplication.

## Actual verification

Executed 2026-10-14 KST:

- Initial RED: `npm test -- tests/x-api-pilot.test.ts`, exit 1 because the requested module did not exist. After empty exports enabled behavioral assertions, `npm test -- tests/x-api-pilot.test.ts -t 'defaults to a zero-HTTP'` failed with expected planned result versus `{}`. Full focused RED then failed all 30 behavioral contracts before implementation.
- First implementation run: 29 passed / 1 failed. The unwound-URL fixture returned an empty latest lookup, correctly turning the observation into unknown and clearing stale links. Corrected that fixture to return the same entity on lookup, fixed another reused-Response fixture, and added an explicit test of latest lookup omission clearing old metrics/links.
- Final GREEN: `npm test -- tests/x-api-pilot.test.ts`, exit 0, 1 file / 31 tests passed. Only the repository's pre-existing Vite config-loader deprecation warning appeared.
- `npx tsc --noEmit --incremental false`, exit 0.
- `npx eslint lib/social/x-pilot.ts scripts/x-api-pilot.ts tests/x-api-pilot.test.ts`, exit 0.
- `npx tsx scripts/x-api-pilot.ts`, exit 0, `mode=dry-run`, `status=planned`, zero requests and zero reserved posts.

Independent review correction round, executed 2026-10-14 KST:

- RED: `npm test -- tests/x-api-pilot.test.ts -t 'review regression'`, exit 1, 11 failed / 3 passed / 31 skipped. Corrected the duplicate fixture to provide a fresh lookup response and reran `npm test -- tests/x-api-pilot.test.ts -t 'denial dominates'`, exit 1, both search and lookup cases failed with available data and retained repository links.
- GREEN after the three scoped fixes: `npm test -- tests/x-api-pilot.test.ts -t 'review regression'`, exit 0, 14 passed / 31 skipped. Tests cover withheld/access/unavailable markers in both duplicate orders, successful partial data, empty search metadata, rejected HTTP-200 failure structures, nested filters, and the complete 512-character boundary.
- `npm test -- tests/x-api-pilot.test.ts`, exit 0, 1 file / 45 tests passed. Updated existing search fixtures to legitimate empty metadata and the intentionally wrapped query expectation. Only the same Vite warning appeared.
- `npx tsc --noEmit --incremental false`, exit 0.
- `npx eslint lib/social/x-pilot.ts scripts/x-api-pilot.ts tests/x-api-pilot.test.ts`, exit 0.
- `npx tsx scripts/x-api-pilot.ts`, exit 0, wrapped default query with the outer repost exclusion, `mode=dry-run`, `status=planned`, zero requests and zero reserved posts.

The root then requested one additional denial-state correction before independent review:

- RED: `npm test -- tests/x-api-pilot.test.ts -t 'errors-only lookup explicitly'`, exit 1, 4 failed / 46 skipped. Each recognized all-denied lookup left the searched candidate available with old repository data.
- GREEN: the same command after projecting recognized requested-ID denials before rejecting the response, exit 0, 4 passed / 46 skipped. Status remains stopped/invalid_response; the denied observation is unavailable with no repository links and six null metrics. Generic upstream errors do not establish unavailability.
- `npm test -- tests/x-api-pilot.test.ts`, exit 0, 1 file / 50 tests passed; only the same Vite warning appeared.
- `npx tsc --noEmit --incremental false`, exit 0.
- `npx eslint lib/social/x-pilot.ts scripts/x-api-pilot.ts tests/x-api-pilot.test.ts`, exit 0.
- `npx tsx scripts/x-api-pilot.ts`, exit 0, planned dry-run with zero requests and zero reserved posts.

Independent review round2 correction, executed 2026-10-14 KST:

- RED: `npm test -- tests/x-api-pilot.test.ts -t 'round2 regression'`, exit 1, 13 failed / 1 passed / 50 skipped. All six one-ID duplicate-marker/order cases, four known-error/excess-row cases, and three malformed-structure cases retained stale available data. Unsolicited/generic filtering passed.
- GREEN: the same focused command after moving requested-ID denial projection before collection/item/row-cap validation, exit 0, 14 passed / 50 skipped. Excess rows still stop with invalid_response; search/lookup reservations remain 10/1, two calls total, and denied observations retain no links or metrics. Unsolicited IDs are ignored.
- First full run: 63 passed / 1 failed, solely because early denial projection changes observation insertion order. The contract does not promise result ordering; updated the existing partial-lookup test to assert three observations and their ID-to-availability mapping without order dependence.
- `npm test -- tests/x-api-pilot.test.ts`, exit 0, 1 file / 64 tests passed; only the same Vite warning appeared.
- `npx tsc --noEmit --incremental false`, exit 2, `tests/integration/evidence-refresh.test.ts:96` inserts a fixture without required `actor`. No pilot-file diagnostics appeared. This outside-scope file was not edited; the root received the exact error and owns resolution/re-execution.
- `npx eslint lib/social/x-pilot.ts scripts/x-api-pilot.ts tests/x-api-pilot.test.ts`, exit 0 both before and after the order-independent assertion update.
- `npx tsx scripts/x-api-pilot.ts`, exit 0, planned dry-run with zero requests and zero reserved posts.

The four owned files are now frozen for root round3. Intended X purpose remains unconfirmed; no live invocation is authorized by these local passing tests. Next repository verification after the fixture owner resolves the required actor: `npx tsc --noEmit --incremental false`.

All requests in tests are injected in-memory Response objects, including simulated live gates. No actual live HTTP, environment file/credential inspection, console changes, Git commits, pipeline writes, or deployment occurred. The existing signed-in console, use-case confirmation, token provisioning, billing/credit evidence, actual accepted fields spelling, and authenticated sample are root-owned remaining acceptance work. The module remains gated until all live prerequisites are explicitly provided.
