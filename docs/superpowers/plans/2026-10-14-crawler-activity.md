# Crawler Activity Implementation Plan

> **For agentic workers:** Execute task-by-task in the already-authorized admin subagent. The root agent performs review, commits and deployment; do not spawn more agents or commit from this task.

**Goal:** Show every existing collector, its safe recent result and active/standby lanes in `/admin/status?tab=crawlers`.

**Architecture:** A pure server-side projection consumes existing status inputs and returns only bounded safe fields. A read-only React component renders that projection as an OperationsCenter slot without a new data query.

**Tech Stack:** Next.js 16.3, React 19, TypeScript, Vitest and existing admin CSS.

---

### Task 1: Pure collector projection

**Files:** Create `lib/operations/crawler-activity.ts` and `tests/crawler-activity.test.ts`.

- [x] Write failing tests importing `buildCrawlerActivity` and `COLLECTOR_JOBS`; compare every crawler-role catalog name and the four external collectors. Feed simultaneous validated lane rows, candidate standby heartbeats and lease owner summaries. Assert paused/disabled/retrying/queued/error/never-run states and no raw secret/error/cursor/event keys in `JSON.stringify(report)`.

```ts
expect(COLLECTOR_JOBS.map(job => job.name)).toEqual(
  JOB_CATALOG.filter(job => job.role === 'crawler' ||
    ['uptime-ping', 'news-refresh', 'product-thumbnail-refresh', 'product-repo-review'].includes(job.name))
    .map(job => job.name));
```

- [x] Run `npx vitest run tests/crawler-activity.test.ts`; verify the missing projection fails.
- [x] Implement `buildCrawlerActivity({ settings, jobs, observations, roles, throughput, now })`. Use catalog metadata, existing `isPausedJob`, `parseRuntimeLanes` and `STALE_LOCK_MS`; allowlist only known collector events/counters. Return per-job timing/state/results, filtered instances/lanes, bounded latest results and fixed X state. Waiting comes only from an existing measured fetch stage; other unmeasured counts remain null.
- [x] Run the same command to verify GREEN.

### Task 2: Read-only tab and rendering

**Files:** Create `app/(operator)/admin/status/CrawlerActivity.tsx`, `app/(operator)/admin/status/crawler-activity.css` and `tests/crawler-activity-components.test.tsx`. Modify `OperationsCenter.tsx`, `action-links.ts` and `page.tsx` in that directory.

- [x] Write failing static-render tests for collector labels, states, last/next timing, item errors, unknown waiting, multiple lane rows, standby/stale status, bounded latest-result wording, manual X and absence of execution controls/secrets.

```tsx
const out = renderToStaticMarkup(createElement(CrawlerActivity, { report }));
expect(out).toContain('자동 수집 안 함');
expect(out).toContain('대기 미확인');
expect(out).not.toContain('작업 실행 요청');
```

- [x] Run `npx vitest run tests/crawler-activity-components.test.tsx`; verify RED.
- [x] Render `<CrawlerActivity report={buildCrawlerActivity(...)} />` from `page.tsx` as `crawlers` slot. Add `crawlers` to `STATUS_TABS` and `TAB_LABELS`, and `{tab==='crawlers'&&crawlers}` to OperationsCenter. Use existing ScrollTable and formatting helpers with scoped responsive CSS.
- [x] Run `npx vitest run tests/crawler-activity.test.ts tests/crawler-activity-components.test.tsx tests/admin-status-action-links.test.ts`.

### Task 3: Final checks and root handoff

- [x] Run `npx tsc --noEmit`.
- [x] Run `npx eslint lib/operations/crawler-activity.ts tests/crawler-activity.test.ts tests/crawler-activity-components.test.tsx 'app/(operator)/admin/status/CrawlerActivity.tsx' 'app/(operator)/admin/status/OperationsCenter.tsx' 'app/(operator)/admin/status/action-links.ts' 'app/(operator)/admin/status/page.tsx'`.
- [x] Run `git diff --check` and inspect the scoped diff. Report exact test commands/results, changed files and limitations to root. Root updates the shared `docs/CODEX_HANDOFF.md` and commits/deploys after full validation.

## Executed validation — 2026-10-14

- Projection RED: `npx vitest run tests/crawler-activity.test.ts` — 9 assertions failed before implementation. Additional root-review RED reproduced failure-total double counting, boolean provider failure misclassification, exact repository-review counters and disabled in-flight status.
- UI RED: `npx vitest run tests/crawler-activity-components.test.tsx` — 4 assertions failed against the empty component.
- GREEN: `npx vitest run tests/crawler-activity.test.ts tests/crawler-activity-components.test.tsx tests/admin-status-action-links.test.ts tests/operations-dashboard-components.test.tsx` — 4 files, 42 tests passed. Existing Vite native-loader warning remains.
- `npx tsc --noEmit` — exit 0.
- `npx eslint lib/operations/crawler-activity.ts tests/crawler-activity.test.ts tests/crawler-activity-components.test.tsx 'app/(operator)/admin/status/CrawlerActivity.tsx' 'app/(operator)/admin/status/OperationsCenter.tsx' 'app/(operator)/admin/status/action-links.ts' 'app/(operator)/admin/status/page.tsx'` — exit 0.
- `git diff --check` — exit 0.
- No database queries, migrations, credentials, production reads, commits or deployment were performed by this subtask. Browser/build/full repository verification remains with the root agent.

The model and tab are complete. Handoff, final review and shipping are deliberately left to the root agent, who owns those files and operations.

## Final-review regressions — 2026-10-14

- Persisted scan failures: added `failed` boolean telemetry to `lib/jobs/products/agent-evidence-refresh.ts` and covered failed/partial scans in `tests/agent-evidence-refresh-budget.test.ts`. Budget deferral remains unchanged. The crawler projection never invents failed-item totals from this boolean; legacy scanned events without it show an unknown collection result. RED reproduced six missing-flag/incorrect-success assertions before GREEN.
- Candidate/runtime timing: the valid same-instance lease and newer running runtime observation supersede an older standby/stopping heartbeat. Seven parameterized cases cover newer runtime, newer candidate, equal timestamps, different lease owner and expired lease. Two previously hidden active-instance cases failed before the fix.
- Release metadata: the timestamp's newest observation also supplies the release hash. Different candidate/runtime hashes in the timing cases reproduced four stale-release assertions before GREEN.
- Independent event errors: request failures remain visible even with an aggregate `failed: 0`. The projection retains `itemErrors: 0` and produces `event-errors`; the rendered summary includes the affected collector and labels observed error events rather than zero failed items. The classifier/static-render reproductions failed before the fix.
- Latest GREEN: `npx vitest run tests/agent-evidence-refresh-budget.test.ts tests/crawler-activity.test.ts tests/crawler-activity-components.test.tsx tests/admin-status-action-links.test.ts tests/operations-dashboard-components.test.tsx` — 5 files, 59 tests passed. Existing Vite native-loader warning remains.
- `npx tsc --noEmit` — exit 0 after the final release-metadata fix.
- `npx eslint lib/jobs/products/agent-evidence-refresh.ts lib/operations/crawler-activity.ts tests/agent-evidence-refresh-budget.test.ts tests/crawler-activity.test.ts tests/crawler-activity-components.test.tsx 'app/(operator)/admin/status/CrawlerActivity.tsx'` — exit 0 after the final release-metadata fix.
- Source and these design/plan documents are frozen for root review. Root owns repository diff checks, shared handoff and shipping. No production access, commits or pushes were performed in these follow-up fixes.
