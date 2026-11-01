# Discovery progress receipts and independent failure coverage

Status: source implementation for review and GitHub CI. No local tests, lint, typecheck, build, compiler, synthetic requests, DB migration, production requests or deployment were run. Base: `efb4d6ce9a78fa5d5b6f25199ab9d75d268b8244`. Migration reserved from the actual journal: `0162_discovery_checkpoints`, after `0161_text_local_direct_binding`.

## Problem and evidence

The existing worker monitor covers downstream collection/review/approval/translation stages. It did not measure the discovery producers. A live supervisor and recurring successful job return can therefore coexist with a stalled discovery cursor.

| Source | Canonical durable work | Why prior timestamps/counts are insufficient |
| --- | --- | --- |
| GitHub latest | `jobs['crawl-seed'].cursor.latestScan`, per-query normalized page/item/window state | A target `cycleWindow.to` is not completed coverage; fairness clocks, cache visits and `lastSuccessAt` can change without advancing work. |
| GitHub full | The outer crawl-seed cursor, independent per-query state | One query can be busy while another never receives service. Latest progress must not clear full-scan starvation. |
| Show HN | `seenUntil`, `seenIds`, split `windowTo`; successful complete page/empty scan | Failed fetches and shifting pages can return `done:false` while the generic runner records success. A real empty scan must stay healthy for the 30-minute schedule. |
| Korean query | Epoch/token-owned committed query cursor | Claims, deferrals and synchronization update query `updated_at`; those are not successful pages. Configured-but-not-created queries must not disappear from coverage. |
| Korean shared cache | Committed control `shared_cursor {at,key}` after a completed public page is imported | Return value zero can mean a valid page with no Korean candidates, no available page or staging cap. |
| Korean language | An actual unknown-to-yes/no staging transition | Unknown retries change `checked_at` and `due_at` without resolving work. Future retry-only demand is intentional backoff. |
| Korean apply | Actual pending-to-applied/excluded staging transition under the home job lease | Zero new frontier rows can mean known candidates, admission cap or no work. Oracle must never gain apply authority. |

## Storage and write contract

`discovery_checkpoints` stores one receipt per fixed source and SHA-256 subject. GitHub lanes and Korean queries use individual label subjects; shared/language/apply/HN use fixed subjects. Query contents, URLs, errors, tokens and credentials are never stored in receipt or heartbeat payloads. A Korean language/apply receipt may reference a validated public repository key so the reader can compare its committed domain transition.

Each receipt stores exact configuration `generation`, semantic work-position hash, intent, optional resume time, first-seen baseline, actual progress time, completed-scan acknowledgement, bounded revision and recording time. `recorded_at` and ordinary job/settings/query `updated_at` never count as progress. Configuration generation changes discard inherited success. A semantic change without a successful work transition establishes a new baseline and discards old acknowledgement. Rewriting the same semantic cursor cannot advance progress/revision. A fully executed empty scan can separately acknowledge no new work.

Every receipt write runs inside a nested transaction/savepoint after the existing canonical source/cursor write. A SQL/schema/grant/slot/timeout failure rolls back only the receipt and logs a fixed event; the productive source transaction continues. Successful receipts commit with the actual domain write. Job saves check the current wall-time lease before and after receipt writing. Korean query writes retain their control epoch/token/lease gate; shared import holds the existing control/admission locks; language/apply use current enabled control and writer fencing. No external I/O is added.

The table has 128 unique smallint slots per source, enforced by CHECK and unique index: at most 896 rows total, including retired subjects. Existing subjects keep their slot; a new subject uses a free slot. Contention or exhaustion makes measurement unknown without discarding source work. Home writes prune at most20 receipts older than seven days per write, with `SKIP LOCKED`. Cleanup requires an active home receipt writer; without one, old rows may remain but the hard slot limit still holds. There is no historical success backfill.

Receipt batches have at most128 inputs, a one-second client loop budget, at most500ms per SQL statement and100ms lock wait, never widening an existing tighter timeout. Savepoint rollback restores caller settings; successful writes explicitly restore them. Slot checks and source/subject lookups use unique indexes.

Oracle's existing Korean principal receives only SELECT, INSERT and named receipt-update columns; source, subject and slot cannot be updated, and DELETE remains denied. Restrictive RLS permits only `korean-query`, `korean-shared`, `korean-language`. It cannot certify home GitHub, HN or apply. No job/role/batch/product or migration authority is added. The existing DR row-security review guard remains unchanged; the new RLS table is added to the regression baseline.

## Read and intent semantics

The monitor explicitly enters `onPrimary`, including when its caller is in a replica scope, and reads one repeatable-read read-only transaction using DB wall time and a shared three-second deadline. Bounds:128 current queries per set,128 fresh crawler observations,896 receipts (the table's actual hard ceiling),10,001 pending staging rows for overflow detection, and only receipt-referenced staging keys. A new partial `(completed_at,key)` public-completed-page index supports shared-cache availability. Existing pending/due staging index supports queue reads. Canonical review-backlog admission is read in the same snapshot; a timeout is unknown, never a guessed cap or clear.

Current settings, batch mode, job `not_before`, exact transfer ownership, canonical queue state and due times determine whether work is expected. Disabled sources, paused jobs, a current admission/staging cap, no available shared page, no due unknown language item, no pending yes/no apply item and fully completed queries remain healthy. Their lack of work is proved from current canonical state, not a stale receipt. Active obligations require an exact generation and semantic receipt match; missing/schema-less/mismatched observations remain unknown and cannot clear an incident. Korean desired-query selection is shared with synchronization, so a missing configured transfer remains unknown.

For active work, GitHub grace is at least five minutes and grows with query count/page budget to allow fair service. Korean grace is five minutes. HN grace is90 minutes (three scheduled intervals), and a real completed-empty acknowledgement renews its scan obligation. Canonical future backoff/caught-up time is accepted only when it matches the receipt's allowed intent and resume time; expiry starts a fresh due grace. Persistent upstream error attempts do not renew progress and alarm after at least30 minutes. Explicit canonical demand times can provide due grace; generic settings/query timestamps cannot.

Every query is evaluated independently. A proved query fault can report its source even if another subject is unknown; absence of a fault clears a source only when all its current subjects are known. Fresh process liveness alone cannot clear a no-progress alarm. Missing home/Oracle workers become `worker_missing`/`consumer_missing` only when work is due and its grace has expired. Discovery status participates in the aggregate Kuma status but adds no new restart/lease-reset authority.

## Versioned heartbeat protocol for Node and Python

Optional field, exact keys:

```json
{"discoveryFailures":{"v":1,"covered":["github-full"],"failures":[{"source":"github-full","reason":"no_progress"}]}}
```

Sources are exactly `github-latest`, `github-full`, `show-hn`, `korean-query`, `korean-shared`, `korean-language`, `korean-apply`. Reasons are exactly `no_progress`, `worker_missing`, `consumer_missing`, `upstream_stalled`. Each array has at most7 entries, no duplicate source; every failure must belong to `covered`. Extra keys/private strings, wrong versions/types and unsupported values are invalid. Node emits sorted sources. `covered:[]` means unknown, not an all-clear. An absent field or legacy `[]` cannot clear discovery and does not change existing stage/provider/review semantics.

Python work is owned separately in `recovery_gateway.py`, `oracle_watchdog.py`, `incident_notifications.py`: all fresh replica coverage is intersected; faults are unioned within covered sources, and conflicting reasons remove that source to unknown. Independent Oracle samples/notifications use durable `discovery-<source>/<reason>` incidents, two consecutive fresh samples at most150s apart and per-source explicit recovery. No existing stageFailures v1 interpretation is broadened.

## CI-only regression coverage and release gates

Added source regressions cover canonical hashes/config changes, separate query progress, repeated attempts, healthy process with stalled cursor, completed-empty HN cadence, due/backoff expiry, worker/consumer absence, unknown generation/semantic/clock evidence, mixed partial coverage, strict envelope validation, legacy fields and aggregate status. PostgreSQL regressions cover domain/receipt atomic rollback, SQL-failed savepoint preserving productive writes and caller timeouts, unchanged semantic revisions, lost job lease, exact Oracle RLS/column restrictions and hard slot constraints. Existing Korean apply mocks and the RLS baseline are updated for the new canonical lock/read. All cases remain unexecuted locally.

Required next steps: parent source review; combine the separately owned Python protocol patch; run the repository's required GitHub CI `check` (unit/integration/typecheck/build under the existing workflow); review migration/grants and index lock implications before any DB operation. Only the release owner may run the migration and deploy matching Node/Python revisions. Existing Oracle principals need the additive grants from0162; fresh provisioning uses the synchronized profile/generated SQL. Do not replay all CREATE ROLE statements for an existing principal.

After authorized release, observe matching receipt/domain/config values and each source's first real success/empty scan. Active legacy sources remain unknown until they produce current receipts; do not backfill from `lastRunAt`, `updated_at`, target dates or recent cache hits. Production progress/recovery and long-running starvation alerts have not been verified by this source-only work.
