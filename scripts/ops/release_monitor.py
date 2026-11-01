#!/usr/bin/env python3
"""Read-only monitor rollout proof, including acknowledgements after container boot.

The watcher records ok=true only after the receiver returns HTTP success and
{ok:true}. These receipts prove receiver acknowledgement, not alert delivery.
Raw Docker logs and private runtime/API records never leave this module's
read-only inspection calls or enter its returned completion receipt.
"""
import importlib.util
import inspect
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fleet = _load('monitor_fleet', 'release_runtime.py')
git = fleet.git_rollout
MAX_RECEIPT_AGE_SECONDS = 90
PUSH_FIELDS = frozenset(('verified', 'primary', 'external', 'fresh', 'stateUp'))
# Operator decision 2026-10-31: the monitor push proof waits five minutes, then a deployment that is itself proven
# (new deployment done, runtime contract, image/RELEASE_TAG/healthy) is handed to a human instead of stopping the
# run. Only the monitor verification uses this limit; every other app keeps its own timeout.
MONITOR_VERIFY_TIMEOUT_SECONDS = 300
HUMAN_REVIEW = 'human_review_required'
# What the operator confirms by hand after a human-review hand-over (codes only; the docs explain each).
OPERATOR_CHECKS = ('monitor_push_event_state_and_receipts', 'capacity_unknowns_alarm_reasons',
                   'kuma_primary_and_external_heartbeat')
CAPACITY_STATUSES = ('ok', 'review', 'alarm', 'unknown')
MONITOR_OVERALLS = ('ok', 'unknown', 'alarm')
SAFE_REASON = re.compile(r'[a-z][a-z0-9_]{0,39}')


def _timestamp(value):
    """Strict RFC3339Nano, with exact ordering on Python 3.9 as well as newer hosts."""
    if not isinstance(value, str):
        return None
    parts = re.fullmatch(r'([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})'
                         r'(?:\.([0-9]{1,9}))?(Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])', value)
    # RFC3339 -00:00 denotes an unknown local offset, not a known UTC instant.
    if parts is None or parts[3] == '-00:00':
        return None
    try:
        parsed = datetime.fromisoformat(parts[1] + ('+00:00' if parts[3] == 'Z' else parts[3]))
        elapsed = parsed - datetime(1970, 1, 1, tzinfo=timezone.utc)
        return Decimal(elapsed.days * 86400 + elapsed.seconds) + Decimal('0.' + (parts[2] or '0'))
    except (ValueError, OverflowError):
        return None


def push_receipt_verdict(lines, started_at, *, now=None):
    """Parse timestamped docker logs; only the latest push event can pass.

    Both acknowledgements must belong to one up event, after this container's
    boot and within 90 seconds. stdout/stderr ordering is resolved by Docker's
    timestamps. The output contains booleans only, including on parse failure.
    """
    result = {'verified': False, 'primary': False, 'external': False, 'fresh': False, 'stateUp': False}
    now = Decimal(str(time.time() if now is None else now))
    started = _timestamp(started_at)
    if started is None or started > now + 5 or not isinstance(lines, (list, tuple)) or len(lines) > 128:
        return result
    events = []
    for line in lines:
        if not isinstance(line, str) or len(line) > 16384:
            return result
        timestamp, _, body = line.partition(' ')
        logged = _timestamp(timestamp)
        if logged is None:
            continue
        try:
            event = json.loads(body)
        except (ValueError, TypeError):
            continue
        if isinstance(event, dict) and event.get('event') == 'monitor.push':
            events.append((logged, event))
    if not events:
        return result
    latest_time = max(item[0] for item in events)
    latest = [event for timestamp, event in events if timestamp == latest_time]
    if len(latest) != 1:
        return result
    event = latest[0]
    result['stateUp'] = event.get('state') == 'up'
    receipts = event.get('receipts')
    if (not isinstance(receipts, list) or len(receipts) != 2 or
            any(not isinstance(row, dict) for row in receipts) or
            any(not isinstance(row.get('target'), str) for row in receipts) or
            {row.get('target') for row in receipts} != {'primary', 'external'}):
        return result
    valid_times = []
    for receipt in receipts:
        attempted = _timestamp(receipt.get('attemptedAt'))
        fresh = bool(attempted is not None and started <= attempted <= now + 5 and
                     attempted <= latest_time + 5 and now - attempted <= MAX_RECEIPT_AGE_SECONDS)
        result[receipt['target']] = receipt.get('ok') is True and fresh
        valid_times.append(fresh)
    result['fresh'] = bool(all(valid_times) and started <= latest_time <= now + 5 and
                           now - latest_time <= MAX_RECEIPT_AGE_SECONDS)
    result['verified'] = all(result[key] for key in ('primary', 'external', 'fresh', 'stateUp'))
    return result


# Use the exact same parser in offline tests and on the remote host. Only this
# boolean result crosses SSH; raw lines, URLs and response bodies stay remote.
REMOTE_PUSH_RECEIPTS = (
    'import json,re,subprocess,sys,time\nfrom datetime import datetime,timezone\nfrom decimal import Decimal\n'
    + 'MAX_RECEIPT_AGE_SECONDS=' + str(MAX_RECEIPT_AGE_SECONDS) + '\n'
    + inspect.getsource(_timestamp) + '\n' + inspect.getsource(push_receipt_verdict) + '\n'
    + r'''
cid,started=sys.argv[1:3]
result={'verified':False,'primary':False,'external':False,'fresh':False,'stateUp':False}
try:
 if re.fullmatch(r'[a-f0-9]{12,64}',cid) and _timestamp(started) is not None:
  command=['docker','logs','--timestamps','--since',started,'--tail','128',cid]
  logs=subprocess.run(command,capture_output=True,text=True,timeout=20)
  if logs.returncode==0 and len(logs.stdout)+len(logs.stderr)<=262144:
   result=push_receipt_verdict(logs.stdout.splitlines()+logs.stderr.splitlines(),started)
except Exception: pass
print(json.dumps(result))
''')


def read_push_receipts(short, runtime):
    containers = runtime.get('containers') or []
    if len(containers) != 1:
        return {key: False for key in PUSH_FIELDS}
    container = containers[0]
    cid, started = container.get('id'), (container.get('state') or {}).get('StartedAt')
    if not re.fullmatch(r'[a-f0-9]{12,64}', cid or '') or _timestamp(started) is None:
        return {key: False for key in PUSH_FIELDS}
    raw = git.shared.ssh_python(git.shared.app_metadata(short)[2][1], REMOTE_PUSH_RECEIPTS,
                                cid, started, timeout=30)
    result = json.loads(raw)
    if (not isinstance(result, dict) or set(result) != PUSH_FIELDS or
            any(type(value) is not bool for value in result.values())):
        return {key: False for key in PUSH_FIELDS}
    return result


def _runtime_ready(short, app, runtime, target, manifest, original_runtime):
    if (runtime.get('updateStatus') or {}).get('State') in git.shared.SWARM_ROLLBACK_STATES + git.shared.SWARM_STOP_STATES:
        raise git.shared.SwarmRollback(short, {'updateState': runtime['updateStatus']['State']})
    if (runtime.get('updateStatus') or {}).get('State') not in git.DEPLOYED_SETTLED_STATES:
        return False
    try:
        preserves = (git.runtime_contract_matches(original_runtime, runtime, target['sha']) and
                     fleet._preserves_containers(original_runtime, runtime, target['sha'], 'monitor'))
    except (KeyError, TypeError, ValueError):
        preserves = False
    if runtime.get('serviceId') != original_runtime.get('serviceId') or not preserves:
        raise git.shared.ReleaseStopped(short + '_runtime_contract_drift')
    version = (runtime.get('version') or {}).get('Index')
    previous_version = (original_runtime.get('version') or {}).get('Index')
    if type(version) is not int or type(previous_version) is not int or version <= previous_version:
        return False
    previous_ids = {row.get('id') for row in original_runtime.get('containers') or []}
    containers = runtime.get('containers') or []
    if not previous_ids or len(containers) != 1 or any(row.get('id') in previous_ids for row in containers):
        return False
    try:
        fleet._runtime_state(short, app, runtime, target['sha'], manifest, Path(__file__).resolve().parents[2])
    except ValueError:
        return False
    for container in containers:
        image = next((row for row in runtime.get('images') or [] if row.get('Id') == container.get('image')), {})
        if (((image.get('Config') or {}).get('Labels') or {}).get('org.opencontainers.image.revision') != target['sha'] or
                _timestamp((container.get('state') or {}).get('StartedAt')) is None):
            return False
    return True


def push_block_reason(receipts):
    """Safe code naming the first missing push proof, for the operator who takes over.

    All five booleans false means no usable monitor.push event was read at all (no event after boot,
    container count, SSH or parse failure); 'state not up' is the 2026-10-31 case: the watcher pushed
    down because the ledger raised a capacity alarm while the receivers acknowledged normally.
    """
    flags = {key: receipts.get(key) is True for key in PUSH_FIELDS} if isinstance(receipts, dict) else {}
    if not any(flags.values()):
        return 'monitor_push_receipts_unreadable'
    if not flags.get('stateUp'):
        return 'monitor_push_state_not_up'
    if not flags.get('fresh'):
        return 'monitor_push_receipt_stale'
    if not (flags.get('primary') and flags.get('external')):
        return 'monitor_push_receiver_not_acknowledged'
    return 'monitor_push_not_verified'


def _require_unchanged_window(client, short, expected, latest, runtime):
    """Logs and receipts must belong to the same stable container/spec/API window that was inspected."""
    after_app, after_latest = client.app(short), client.latest(short)
    after = git.inspect_runtime(short, after_app)
    if (git.stable_config(after_app) != git.stable_config(expected) or
            after_app.get('applicationStatus') != 'done' or after_latest.get('status') != 'done' or
            after_latest.get('deploymentId') != latest['deploymentId'] or
            (after.get('updateStatus') or {}).get('State') not in git.DEPLOYED_SETTLED_STATES or
            not fleet._same_runtime_window(runtime, after)):
        raise git.shared.ReleaseStopped(short + '_changed_during_push_readback')


def _deployment_receipt(short, target, latest, runtime):
    return {'app': short, 'deploymentId': latest['deploymentId'], 'deployment': 'done', 'service': 'healthy',
            'image': target['worker'], 'specHash': runtime['specHash'], 'containerId': runtime['containers'][0]['id'],
            'source': 'sha256-manifest'}


def check_monitor_deployed(client, short, target, original, old_id, manifest, expected_runtime, *,
                           timeout=MONITOR_VERIFY_TIMEOUT_SECONDS, pause=2):
    """Wait for one new monitor and both receiver acknowledgements; never mutate or retry deploy.

    Verified: new deployment done, runtime contract/image/RELEASE_TAG/healthy proven, and the latest
    monitor.push event is up, fresh and acknowledged by both receivers. When the timeout passes while
    the deployment itself is proven on the last poll and only that push proof is missing, the run is
    not stopped: the receipt carries verification=human_review_required, the reason code and the last
    observed receipt booleans. A deployment not proven on the last poll still raises TimeoutError.
    """
    if short != 'monitor-m3':
        raise ValueError('monitor_app_required')
    target = git.shared.validate_target(target['sha'], target['worker'], target['web'])
    expected = fleet.expected_api(short, original, target)
    if (not isinstance(expected_runtime, dict) or not expected_runtime.get('containers') or
            expected_runtime.get('specHash') != git.spec_hash(expected_runtime.get('serviceSpec')) or
            not isinstance(manifest, dict) or not manifest):
        raise ValueError('monitor_baseline_or_source_contract_invalid')
    deadline = time.monotonic() + timeout
    pending = None
    while time.monotonic() < deadline:
        app, latest = client.app(short), client.latest(short)
        if app.get('applicationStatus') == 'error' or latest.get('status') == 'error':
            raise git.shared.ReleaseStopped(short + '_deployment_error')
        # Only a deployment proven on the most recent poll may be handed over; a flapping runtime is not proven.
        pending = None
        if (latest.get('deploymentId') and latest['deploymentId'] != old_id and
                latest.get('status') == 'done' and app.get('applicationStatus') == 'done'):
            if git.stable_config(app) != git.stable_config(expected):
                raise git.shared.ReleaseStopped(short + '_saved_configuration_mismatch')
            runtime = git.inspect_runtime(short, app, manifest=manifest)
            if _runtime_ready(short, app, runtime, target, manifest, expected_runtime):
                receipts = read_push_receipts(short, runtime)
                if receipts.get('verified') is True and all(receipts.get(key) is True for key in PUSH_FIELDS):
                    _require_unchanged_window(client, short, expected, latest, runtime)
                    return {**_deployment_receipt(short, target, latest, runtime),
                            'pushReceipts': {'primary': True, 'external': True}}
                pending = (latest, runtime, receipts)
        time.sleep(pause)
    if pending is None:
        raise TimeoutError(short + '_source_health_or_push_verification_timeout')
    latest, runtime, receipts = pending
    _require_unchanged_window(client, short, expected, latest, runtime)
    return {**_deployment_receipt(short, target, latest, runtime),
            'pushReceipts': {key: receipts.get(key) is True for key in sorted(PUSH_FIELDS)},
            'verification': HUMAN_REVIEW, 'reason': push_block_reason(receipts), 'verifyTimeoutSeconds': timeout}


def capacity_alarm_summary(client):
    """Read-only summary of the crawler container's failover-readiness report, the same REMOTE_MONITOR read the
    deploy gates use: monitor overall, ledger status, counts and alarm reason codes. Request ids, URLs and values
    never enter the summary; any read or shape failure is reported as unread, never as ok."""
    try:
        app = client.app('crawler-m3')
        reports = json.loads(git.shared.ssh_python(git.shared.M3[1], git.shared.REMOTE_MONITOR, app['appName'], timeout=80))
        readiness = reports['check-failover-readiness.ts']
        capacity = readiness.get('capacityUnknowns') if isinstance(readiness, dict) else None
        if not isinstance(capacity, dict):
            raise ValueError('capacity_summary_missing')
    except Exception:
        return {'status': 'unread'}
    def count(value):
        return value if type(value) is int and 0 <= value <= 10 ** 9 else None
    reasons = capacity.get('alarmReasons')
    return {'status': capacity.get('status') if capacity.get('status') in CAPACITY_STATUSES else 'unread',
            'monitorOverall': readiness.get('overall') if readiness.get('overall') in MONITOR_OVERALLS else 'unknown',
            'count': count(capacity.get('count')), 'stuckDispatched': count(capacity.get('stuckDispatched')),
            'oldestAgeSeconds': count(capacity.get('oldestAgeSeconds')),
            'alarmReasons': sorted(reason for reason in reasons if isinstance(reason, str) and SAFE_REASON.fullmatch(reason))[:3]
            if isinstance(reasons, list) else []}


def human_review_record(client, evidence):
    """Safe hand-over record for the operator: codes, booleans and counts only; never URLs, log lines or values."""
    receipts = evidence.get('pushReceipts') if isinstance(evidence.get('pushReceipts'), dict) else {}
    flags = {key: receipts.get(key) is True for key in sorted(PUSH_FIELDS)}
    return {'app': evidence.get('app'), 'deploymentId': evidence.get('deploymentId'), 'status': 'human-review-required',
            'verification': HUMAN_REVIEW, 'reason': evidence.get('reason'),
            'verifyTimeoutSeconds': evidence.get('verifyTimeoutSeconds'),
            'deployment': evidence.get('deployment'), 'service': evidence.get('service'),
            'lastPushState': 'up' if flags['stateUp'] else 'unknown' if not any(flags.values()) else 'down',
            'pushReceipts': flags, 'capacityUnknowns': capacity_alarm_summary(client),
            'operatorChecks': list(OPERATOR_CHECKS), 'at': datetime.now(timezone.utc).isoformat()}
