# Discovery alerts: Python transport and independent observer

This is the source contract for the Python portion of discovery monitoring, based on `efb4d6ce`. Node source collection/classification and durable cursor evidence are a separate coordinated change. This document does not claim deployment, live recovery, or test execution.

## Optional envelope

Monitor heartbeat, SSH gateway report, and Oracle accept:

```json
{"discoveryFailures":{"v":1,"covered":["github-latest","show-hn"],"failures":[{"source":"github-latest","reason":"no_progress"}]}}
```

The seven fixed sources are `github-latest`, `github-full`, `show-hn`, `korean-query`, `korean-shared`, `korean-language`, and `korean-apply`. The four fixed reasons are `no_progress`, `worker_missing`, `consumer_missing`, and `upstream_stalled`.

The envelope permits exactly `v`, `covered`, and `failures`; version is integer `1` (Python booleans are rejected). Each array has at most seven entries. Coverage sources and failure sources are unique, each failure source belongs to coverage, and failure objects have exactly `source` and `reason`. Unknown names, private fields, bare `[]`, and malformed structures are rejected. An absent field or `{"v":1,"covered":[],"failures":[]}` is unknown, never an all-source clear. Output is sorted by source.

## Fleet observation and alert lifecycle

`scripts/ops/recovery_gateway.py` validates the optional heartbeat field in the bounded existing read-only monitor probe. Only fresh monitor replicas are usable. Across every fresh replica, coverage is the intersection and known faults are the union for covered sources. A missing/invalid optional field leaves merged coverage empty. Contradictory reasons for one source remove only that source and its fault from merged coverage. A stale monitor or unreadable probe emits no discovery clear; the existing stale-monitor behavior remains unchanged.

`scripts/ops/oracle_watchdog.py` validates the same shape and observes each covered fault independently. Two consecutive fresh observations of the same source/reason, separated by at most 150 seconds, produce an incident event. Missing host/metadata, uncovered source, clock rollback, longer gap, corrupt history, and changed reason restart that source's consecutive counter. Current release/version turnover alone does not erase continuous evidence. The event can make aggregate DOWN even if its service otherwise reports OK, and it remains independently observable when aggregate is already DOWN.

`scripts/ops/incident_notifications.py` stores durable receipt signatures as `<host>/<service>/discovery-<source>/<reason>`. A discovery incident clears only when a valid fresh gateway report explicitly covers its source and omits that exact failure. Coverage for a different source cannot clear it. Changed reason clears the old reason and requires two new matching fault observations before the new alert. Missing/stale reports, empty coverage, observer restart, and release turnover preserve sent/pending receipts. Failed notification ACKs retain pending incidents for retry. Existing review, generic stage, provider, capacity, service, and receiver receipt namespaces are unchanged.

Only fixed names/reasons enter the report, event, state, or alert. No query, repository, raw cursor, model name, response body, credential, or private remote error is added by this protocol.

## Recovery boundary and deployment order

Discovery metadata grants no recovery action. Existing local fenced workers/supervisors own process and job recovery. Discovery producers must account for enabled/current-owner/current-child intent, due/backoff clocks, scheduler evidence, durable cursor/empty-scan success, admission caps, and quotas before claiming coverage or a fault. No source may be restarted, unpaused, or given new API quota because its yield is zero or evidence is unknown. Provider/model shutdown intent and AI2 independence remain separate policies.

Install the compatible Oracle trio first (`oracle_watchdog.py`, `incident_notifications.py`, and Oracle's sibling `recovery_gateway.py`), then M3/mini SSH `recovery_gateway.py`, then the producer/monitor image. An old gateway drops the unknown optional field; a new gateway can emit a field an old Oracle validator rejects, so reversing this order causes unknown host observations. Preserve state/config/key files and existing receipt/recovery attempt history. Do not start a concurrent `--once` observer or replay uncertain mutation commands.

## Files and verification

Only these source files changed:

- `scripts/ops/recovery_gateway.py`
- `scripts/ops/oracle_watchdog.py`
- `scripts/ops/incident_notifications.py`

New CI-only regressions are `tests/test_recovery_discovery.py` and `tests/test_oracle_watchdog_discovery.py`. They cover the embedded Node probe and strict schemas; replica intersection/union/conflict/old/stale cases; all seven independent incidents; explicit source clear and reason replacement; unknown-source counter reset; gap/rollback/corrupt history; inclusive 150-second freshness; release/restart receipt persistence; namespace isolation; ACK retry; and no discovery recovery authority. The transport tests use local file/Node fixtures and stub Docker command output; observer/notifier tests use temporary state and injected notification callbacks, without SSH, Docker, DB, or network services.

No tests, local compiler, lint, typecheck, build, or production calls were executed by this agent. Existing required GitHub CI already discovers both test prefixes. For the next agent, review this source diff and the coordinated Node producer diff, then let required CI execute:

```sh
python3 -B -m unittest discover -s tests -p 'test_recovery*.py'
python3 -B -m unittest discover -s tests -p 'test_oracle_watchdog*.py'
```

Remaining live evidence includes source classification against actual enabled ownership/backoff states, old/new replica rollout, gateway/report source hashes, notification ACK receipt, explicit per-source clear/re-alert, and recovery staying within existing local fences. These are not complete merely because this protocol exists.
