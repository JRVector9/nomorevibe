#!/usr/bin/env python3
"""Local deployment impact proof and pure per-app expected-state contracts.

No credentials, remote Git refs, Dokploy calls, or production writes belong here.
Only explicit runtime boundaries may narrow a deployment. Unknown paths, malformed
diffs, and unproven commit ancestry select every registered production app.
"""

import copy
import re
import subprocess
from pathlib import Path, PurePosixPath


SCHEMA_VERSION = 1
RULES_VERSION = 'deployment-scope-v2'
CONSUMER_PARENT_ROLES = {'ai1': 'reviewer', 'ai2': 'reviewer', 'agent-scan': 'crawler'}
PAIR_ROLES = ('publisher', 'reviewer', 'crawler', 'web', 'text', 'maintenance', 'scheduler')
SINGLE_ROLES = {'connect-agent': 'connect-agent-m3', 'monitor': 'monitor-m3'}
SHA = re.compile(r'[0-9a-f]{40}')
HASH = re.compile(r'[0-9a-f]{64}')
IMMUTABLE_IMAGE = re.compile(r'(?:[^\s@]+@)?sha256:[0-9a-f]{64}')

# These are reviewed operator-only entrypoints, never imported/launched by a
# production Node entrypoint. .dockerignore excludes scripts/ops and .github;
# worker COPY scripts does not include the former. CI entrypoints also have no
# production callers. CI risk/test selection is separate from runtime impact.
# Do not broaden this to scripts/ops/**: runtime support scripts exist there.
# Changes to new/unknown tools or workflows remain fail-closed.
LOCAL_OPERATOR_FILES = frozenset({
    'scripts/ops/deploy_shared_images.py',
    'scripts/ops/deploy_git_apps.py',
    'scripts/ops/deployment_scope.py',
    'scripts/ops/deploy_release.py',
    'scripts/ops/release_runtime.py',
    'scripts/ops/release_observer.py',
    'scripts/ops/release_readiness.py',
    'scripts/ops/release_monitor.py',
    'scripts/ops/release_catalog.py',
    'scripts/ops/oracle_activation_check.py',
    # Installed separately on the Oracle watchdog host; excluded from Docker images.
    'scripts/ops/incident_notifications.py',
    '.claude/prod.sh',
    'scripts/ci-scope.mjs',
    'scripts/ci-reuse.mjs',
    'scripts/ci-check.mjs',
    'scripts/ci-scope.node-test.mjs',
    'scripts/ci-reuse.node-test.mjs',
    'scripts/ci-check.node-test.mjs',
})
DOC_FILES = frozenset({'README.md', 'PENDING.md', 'AGENTS.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE'})
WEB_MESSAGE_NAMES = frozenset({'auth', 'browse', 'common', 'detail', 'global-error', 'launch', 'policy'})
WEB_LOCALES = frozenset({'en', 'ko', 'zh-Hans', 'zh-Hant'})
PASSIVE_ASSET_SUFFIXES = frozenset({'.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico',
                                    '.woff', '.woff2', '.ttf', '.otf'})
ENTRYPOINT_ROLES = {
    'scripts/scheduler.ts': 'scheduler',
    'scripts/scheduler.sh': 'scheduler',
    'scripts/connect-agent.ts': 'connect-agent',
    'scripts/watch-failover-readiness.ts': 'monitor',
    'scripts/monitor-healthcheck.ts': 'monitor',
}


def registered_apps(known_apps, consumer_apps):
    """Return only registered metadata, grouped standby → primary → consumers.

    A consumer with both registration fields empty is an explicit unprovisioned
    placeholder. Partial registrations and invalid metadata are errors.
    """
    registered = {}
    identities, names = set(), set()
    for is_consumer, source in ((False, known_apps), (True, consumer_apps)):
        if not isinstance(source, dict):
            raise ValueError('registered_app_metadata_invalid')
        for short, metadata in source.items():
            if (not isinstance(short, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', short)
                    or not isinstance(metadata, (tuple, list)) or len(metadata) != 4):
                raise ValueError('registered_app_metadata_invalid')
            identity, name, host, kind = metadata
            if is_consumer and identity == '' and name == '':
                continue
            if (not isinstance(identity, str) or not identity or not isinstance(name, str) or not name
                    or not isinstance(host, (tuple, list)) or len(host) != 2
                    or any(not isinstance(item, str) or not item for item in host)
                    or kind not in ('worker', 'web', 'scheduler', 'connect-agent', 'monitor')
                    or short in registered or identity in identities or name in names):
                raise ValueError('registered_app_metadata_invalid')
            if is_consumer and short.rsplit('-consumer-', 1)[0] not in CONSUMER_PARENT_ROLES:
                raise ValueError('registered_app_metadata_unknown_consumer')
            registered[short] = metadata
            identities.add(identity)
            names.add(name)
    order = []
    for short in registered:
        if '-consumer-' in short:
            continue
        order.append(short)
        role, _, host = short.rpartition('-')
        if host == 'm3':
            order.extend(item for item in registered if '-consumer-' in item
                         and CONSUMER_PARENT_ROLES[item.rsplit('-consumer-', 1)[0]] == role)
    if len(order) != len(registered):
        raise ValueError('registered_app_metadata_missing_consumer_parent')
    return tuple(order)


def apps_for_role(role, *, known_apps, consumer_apps):
    """Use actual hosts only; a role's provisioned consumers follow its pair."""
    apps = registered_apps(known_apps, consumer_apps)
    if role in PAIR_ROLES:
        selected = [app for app in apps if app in (role + '-mini', role + '-m3')
                    or '-consumer-' in app and CONSUMER_PARENT_ROLES[app.rsplit('-consumer-', 1)[0]] == role]
        if role + '-mini' not in selected or role + '-m3' not in selected:
            raise ValueError('registered_app_metadata_missing_role_pair')
        return tuple(selected)
    if role in SINGLE_ROLES and SINGLE_ROLES[role] in apps:
        return (SINGLE_ROLES[role],)
    raise ValueError('unknown_role')


def _valid_path(path):
    return (isinstance(path, str) and bool(path) and not path.startswith('/')
            and not any(ord(char) < 32 or ord(char) == 127 for char in path)
            and '\\' not in path and all(part not in ('', '.', '..') for part in path.split('/')))


def _valid_change(change):
    if not isinstance(change, dict) or set(change) != {'status', 'paths'}:
        return False
    status, paths = change['status'], change['paths']
    if not isinstance(status, str) or not isinstance(paths, list):
        return False
    count = 2 if re.fullmatch(r'[RC](?:100|0?[0-9]{1,2})', status) else 1
    if count == 1 and status not in ('A', 'M', 'D', 'T'):
        return False
    return len(paths) == count and all(_valid_path(path) for path in paths)


def _path_roles(path):
    if path in DOC_FILES or path.startswith(('docs/', 'tests/')) or path in LOCAL_OPERATOR_FILES:
        return (), 'no_runtime_change'
    if path in ENTRYPOINT_ROLES:
        return (ENTRYPOINT_ROLES[path],), 'isolated_runtime_entrypoint'
    parts = path.split('/')
    suffix = PurePosixPath(path).suffix.lower()
    if suffix == '.css' and parts[0] in ('app', 'components', 'styles'):
        return ('web',), 'web_stylesheet'
    if parts[0] == 'public' and suffix in PASSIVE_ASSET_SUFFIXES:
        return ('web',), 'web_passive_asset'
    if path in ('app/icon.svg', 'app/icon.png', 'app/apple-icon.png', 'app/favicon.ico'):
        return ('web',), 'web_passive_asset'
    if (len(parts) == 3 and parts[0] == 'messages' and parts[1] in WEB_LOCALES
            and parts[2].endswith('.ts') and parts[2][:-3] in WEB_MESSAGE_NAMES):
        # me.ts/labels.ts are also read by maintenance email jobs. Unknown
        # namespaces remain full until their runtime callers have been reviewed.
        return ('web',), 'web_message_namespace'
    # lib/jobs/registry.ts eagerly imports every handler, and HTTP cron also
    # consumes that registry. Handler filenames alone never prove role isolation.
    return None, 'unclassified_runtime_change'


def _expand_units(selected, *, known_apps, consumer_apps):
    expanded = set(selected)
    for app in tuple(selected):
        if '-consumer-' in app:
            role = CONSUMER_PARENT_ROLES[app.rsplit('-consumer-', 1)[0]]
        else:
            role = app.rsplit('-', 1)[0]
        if role in PAIR_ROLES:
            expanded.update(apps_for_role(role, known_apps=known_apps, consumer_apps=consumer_apps))
    return expanded


def _make_plan(apps, selected, reasons, changes):
    return {'schemaVersion': SCHEMA_VERSION, 'rulesVersion': RULES_VERSION,
            'mode': 'none' if not selected else 'full' if len(selected) == len(apps) else 'scoped',
            'allApps': list(apps), 'selectedApps': [app for app in apps if app in selected],
            'retainedApps': [app for app in apps if app not in selected],
            'reasons': sorted(set(reasons)), 'changes': copy.deepcopy(changes)}


def _requested_selection(selected, apps, requested_apps, *, known_apps, consumer_apps):
    if requested_apps is None:
        return selected
    if (not isinstance(requested_apps, (list, tuple)) or not all(isinstance(app, str) for app in requested_apps)
            or len(set(requested_apps)) != len(requested_apps) or set(requested_apps) - set(apps)):
        raise ValueError('unknown_requested_app')
    if not set(selected).issubset(requested_apps):
        raise ValueError('apps_cannot_shrink_scope')
    return _expand_units(set(requested_apps), known_apps=known_apps, consumer_apps=consumer_apps)


def classify_changes(changes, *, known_apps, consumer_apps, requested_apps=None):
    """Pure classifier. requested_apps may expand the inferred scope only."""
    apps = registered_apps(known_apps, consumer_apps)
    selected, reasons = set(), []
    if not isinstance(changes, list) or not all(_valid_change(change) for change in changes):
        selected, reasons, changes = set(apps), ['invalid_change_evidence'], []
    else:
        for change in changes:
            for path in change['paths']:
                roles, reason = _path_roles(path)
                reasons.append(reason)
                if roles is None:
                    selected.update(apps)
                else:
                    for role in roles:
                        selected.update(apps_for_role(role, known_apps=known_apps, consumer_apps=consumer_apps))
    selected = _requested_selection(selected, apps, requested_apps,
                                    known_apps=known_apps, consumer_apps=consumer_apps)
    if requested_apps is not None:
        reasons.append('explicit_scope_expansion')
    return _make_plan(apps, selected, reasons or ['no_tree_change'], changes)


def parse_name_status(raw):
    """Parse git --name-status -z without lossy whitespace/name splitting."""
    if not isinstance(raw, bytes) or raw and not raw.endswith(b'\0'):
        raise ValueError('invalid_git_diff')
    if not raw:
        return []
    try:
        tokens = raw[:-1].decode('utf-8', errors='strict').split('\0')
    except UnicodeError:
        raise ValueError('invalid_git_diff') from None
    changes, index = [], 0
    while index < len(tokens):
        status = tokens[index]
        count = 2 if status.startswith(('R', 'C')) else 1
        row = {'status': status, 'paths': tokens[index + 1:index + 1 + count]}
        if not _valid_change(row):
            raise ValueError('invalid_git_diff')
        changes.append(row)
        index += count + 1
    return changes


def read_git_changes(repo, before, after):
    """Prove local exact commit ancestry, then compare both trees (also for merges).

    Full SHAs prevent ref/option ambiguity. No remote/current-branch guessed base
    and no three-dot merge-base diff may silently omit changes from the baseline.
    Any unavailable object/history or failed proof is explicit untrusted evidence.
    """
    evidence = {'before': before, 'after': after, 'trusted': False, 'changes': []}
    if (not isinstance(before, str) or not SHA.fullmatch(before)
            or not isinstance(after, str) or not SHA.fullmatch(after)):
        return {**evidence, 'reason': 'invalid_commit_identity'}

    def git(*args):
        result = subprocess.run(['git', '--no-replace-objects', '-C', str(Path(repo)), *args],
                                capture_output=True, timeout=30)
        if result.returncode:
            raise ValueError('git_proof_failed')
        return result.stdout

    try:
        for sha in (before, after):
            if git('rev-parse', '--verify', sha + '^{commit}').decode().strip() != sha:
                raise ValueError('git_commit_not_exact')
        git('merge-base', '--is-ancestor', before, after)
        changes = parse_name_status(git('diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z',
                                        '--find-renames', before, after, '--'))
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        return {**evidence, 'reason': 'unproven_git_history'}
    return {**evidence, 'trusted': True, 'changes': changes, 'reason': 'exact_ancestor_tree_diff'}


def plan_deployment(repo, before, after, *, known_apps, consumer_apps, requested_apps=None):
    evidence = read_git_changes(repo, before, after)
    if evidence['trusted']:
        plan = classify_changes(evidence['changes'], known_apps=known_apps, consumer_apps=consumer_apps,
                                requested_apps=requested_apps)
    else:
        apps = registered_apps(known_apps, consumer_apps)
        selected = _requested_selection(set(apps), apps, requested_apps,
                                        known_apps=known_apps, consumer_apps=consumer_apps)
        plan = _make_plan(apps, selected, [evidence['reason']], [])
    return {**plan, 'git': evidence}


def _app_state(state, *, git_target=False):
    if (not isinstance(state, dict) or not isinstance(state.get('release'), str)
            or not SHA.fullmatch(state['release']) or not isinstance(state.get('specHash'), str)
            or not HASH.fullmatch(state['specHash'])
            or not {'release', 'image', 'specHash'}.issubset(state)
            or set(state) - {'release', 'image', 'specHash', 'sourceType', 'sourceRevision'}
            or 'sourceType' in state and state['sourceType'] not in ('docker', 'github')):
        raise ValueError('invalid_app_state')
    image = state.get('image')
    if not isinstance(image, str) or not IMMUTABLE_IMAGE.fullmatch(image):
        if not (git_target and image is None and state.get('sourceType') == 'github'
                and state.get('sourceRevision') == state['release']):
            raise ValueError('invalid_app_state')
    if 'sourceRevision' in state and (not isinstance(state['sourceRevision'], str)
                                     or not SHA.fullmatch(state['sourceRevision'])):
        raise ValueError('invalid_app_state')
    return copy.deepcopy(state)


def _validate_partition(plan):
    if (not isinstance(plan, dict) or plan.get('schemaVersion') != SCHEMA_VERSION
            or plan.get('rulesVersion') != RULES_VERSION):
        raise ValueError('invalid_scope_plan')
    names = [plan.get(key) for key in ('allApps', 'selectedApps', 'retainedApps')]
    if any(not isinstance(value, list) or not all(isinstance(app, str) for app in value)
           or len(value) != len(set(value)) for value in names):
        raise ValueError('invalid_scope_plan')
    apps, selected, retained = map(set, names)
    if (not apps or selected & retained or selected | retained != apps
            or plan.get('mode') != ('none' if not selected else 'full' if not retained else 'scoped')):
        raise ValueError('invalid_scope_plan')
    return names


def plan_for_baselines(repo, after, baseline, *, known_apps, consumer_apps, requested_apps=None):
    """Classify each app from its own actual release, so mixed releases stay safe.

    An old app is selected only if its own diff affects its runtime unit. Once
    selected, the complete role pair/consumers is included. Any unproven baseline
    history selects all apps, even when another baseline has a docs-only diff.
    """
    apps = registered_apps(known_apps, consumer_apps)
    if not isinstance(baseline, dict) or set(baseline) != set(apps):
        raise ValueError('baseline_apps_mismatch')
    for state in baseline.values():
        _app_state(state)
    evidence, selected, reasons, changes = {}, set(), [], []
    for app in apps:
        before = baseline[app]['release']
        if before not in evidence:
            evidence[before] = plan_deployment(repo, before, after, known_apps=known_apps,
                                               consumer_apps=consumer_apps)
            reasons.extend(evidence[before]['reasons'])
            changes.extend(evidence[before]['changes'])
        inferred = evidence[before]
        if not inferred['git']['trusted']:
            selected.update(apps)
        elif app in inferred['selectedApps']:
            selected.add(app)
    selected = _expand_units(selected, known_apps=known_apps, consumer_apps=consumer_apps)
    selected = _requested_selection(selected, apps, requested_apps,
                                    known_apps=known_apps, consumer_apps=consumer_apps)
    plan = _make_plan(apps, selected, reasons, changes)
    plan['after'] = after
    plan['baselineEvidence'] = {sha: value['git'] for sha, value in evidence.items()}
    return plan


def build_expected_apps(plan, baseline, targets):
    """Pure full-inventory contract: targets change; retained apps stay exact.

    A Git build's image may be unknown only for an explicitly typed target with
    sourceRevision. Its final observation must supply an immutable actual image
    and independently proven sourceRevision; RELEASE_TAG is not source proof.
    """
    apps, selected, retained = _validate_partition(plan)
    if not isinstance(baseline, dict) or set(baseline) != set(apps):
        raise ValueError('baseline_apps_mismatch')
    if not isinstance(targets, dict) or set(targets) != set(selected):
        raise ValueError('target_apps_mismatch')
    result = {}
    target_releases = set()
    for app in apps:
        previous = _app_state(baseline[app])
        result[app] = {'mode': 'retained' if app in retained else 'target', 'previous': previous,
                       'expected': copy.deepcopy(previous) if app in retained else _app_state(targets[app], git_target=True)}
        if app in selected:
            target_releases.add(result[app]['expected']['release'])
    proven_after = plan.get('after') or (plan.get('git') or {}).get('after')
    if len(target_releases) > 1 or proven_after is not None and target_releases and target_releases != {proven_after}:
        raise ValueError('target_release_mismatch')
    return result


def validate_observed_apps(expected, observed):
    """Return deterministic app/field mismatch codes, including retained drift."""
    if not isinstance(expected, dict) or not expected:
        raise ValueError('invalid_expected_apps')
    if not isinstance(observed, dict):
        raise ValueError('invalid_observed_apps')
    failures = []
    for app in sorted(set(expected) | set(observed)):
        if app not in expected:
            failures.append(app + ':unexpected_app')
            continue
        if app not in observed:
            failures.append(app + ':missing_app')
            continue
        row = expected[app]
        if not isinstance(row, dict) or row.get('mode') not in ('target', 'retained'):
            raise ValueError('invalid_expected_apps')
        wanted = _app_state(row.get('expected'), git_target=row['mode'] == 'target')
        previous = _app_state(row.get('previous'))
        if row['mode'] == 'retained' and previous != wanted:
            raise ValueError('invalid_expected_apps')
        try:
            actual = _app_state(observed[app])
        except ValueError:
            failures.append(app + ':invalid_app_state')
            continue
        for field in ('release', 'image', 'specHash', 'sourceType', 'sourceRevision'):
            if field in wanted and not (field == 'image' and wanted[field] is None) and actual.get(field) != wanted[field]:
                failures.append(app + ':' + field + '_mismatch')
    return failures
