# 크롤러 활동 — approved design

## Objective and approval

The operator asked to see all collector activity in the existing operations center and approved the proposed `크롤러 활동` tab with `이어서해`. Continue that approved scope without another approval round. The root agent owns final review, commits and deployment.

## Experience

Add `?tab=crawlers` alongside the current tabs. Keep the existing header, design tokens and ten-second live refresh. Present catalog-driven collector rows, a worker/standby and lane section, and a bounded list of each collector's latest persisted execution/result. Every crawler-role job appears, plus external collectors owned by other roles: uptime, news, images and repository rechecks. Repository rechecks can delist products; this tab only observes them and offers no execution button.

Each row shows role/lane, configuration state, execution/request/retry state, last run/success, next schedule, known waiting count and safe result counters. Unknown counts remain `미확인`; an empty queue is not inferred from a successful tick or `done`. Fresh running lane metadata is distinct from a stale observation, standby waiting and never-run jobs. A successful job tick with failed items is visibly different from a tick with no reported item errors.

Numeric failed-item totals come from the latest aggregate event and are not added to per-item error events for the same tick. A boolean provider failure has an unknown item count. Retained error events have their own error outcome and observation count, including independent request failures alongside an aggregate failed-item count of zero. Do not label that combination as a successful result or as zero observed errors. Configuration being off or a stop being requested remains visible while an already-owned tick is finishing. Provider retry timestamps are projected only from documented cursor fields; no other cursor contents are returned.

The development-AI scanner emits a safe boolean when a persisted scan failed or has a collection error code, preserving failure through the runner's numeric/boolean event projection. Budget deferral remains a waiting event. Historical scanned events lacking this flag remain `수집 결과 미확인` because their persisted scan status cannot be reconstructed from retained counters.

X is an explicitly unscheduled manual API pilot. There is no X admin setting in the repository, so do not invent a settings link or turn local pilot results into runtime activity. Show `자동 수집 안 함 · 수동 API 파일럿` and the use-case approval requirement without exposing credentials.

## Data and limits

Reuse the already-loaded operations observations, job states, throughput and role lease summary. No new database query, migration, background polling or persistence is needed. Observation storage replaces a job's prior successful tick, so call the recent section `수집기별 최근 실행` and explain that it is the latest stored tick per collector, not a complete execution log. Filter collector names before sorting/limiting to 30 rows. Current job errors appear separately as `최근 회차 오류`; arbitrary error strings, cursors, event labels, details, identifiers and request payloads are never projected into this tab.

Build the model on the server and render a read-only server component passed as a React slot into OperationsCenter. Use explicit event and counter allowlists with finite numeric validation. Parse existing validated runtime lanes, project only collector jobs and fixed states, and use candidate heartbeats plus the role lease owner to distinguish active/standby/expired observations. Do not assume that the most recently observed standby is the active worker.

A valid same-instance lease plus a strictly newer fresh running runtime observation can supersede that instance's older standby/stopping candidate heartbeat. An equally recent or newer standby/stopping heartbeat remains conservative, as do expired leases and leases owned by another instance. This accounts for a worker acquiring its lease and publishing runtime before its next candidate heartbeat. Release metadata comes from the same newest observation used for its displayed timestamp; an older fresh candidate cannot mask a newer runtime release.

Preserve every current instance; separately limit stale historical deployment keys to the latest 20. All operational text is at least 13px, and wide tables use the existing named keyboard-accessible ScrollTable so narrow screens scroll the table without widening the page.

## Validation and scope

Unit and static-render tests cover catalog completeness, multiple simultaneous lanes, active/standby/stale observations, disabled settings, paused/backoff/never-run/error jobs, bounded filtering, item failures and payload redaction. Run focused Vitest, TypeScript and scoped ESLint. No integration test is necessary without a new query. Existing legacy job dialogs are outside this tab's projection and keep their current behavior. Do not access production DB, credentials or the paused introduction review.
