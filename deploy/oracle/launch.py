#!/usr/bin/env python3
"""Oracle role/consumer launcher. The fixed process starts only when every readiness check is verified.

Checks run in a fixed order and stop at the first result that is not verified: installed release, runtime
account/platform, host budget, OCI identity, then the existing runtime preflight (batch, DB authority,
timeouts and the PR10d canary, or for the scheduler its attested tick canary of the current boot). Any unknown or
rejected result exits78. No flag, environment variable,
supplied receipt or local marker can skip a check. Database election and per-claim admission still apply
after start; this gate never writes DB state.

--consumer=<name> starts an item consumer (claims work without a role lease) under its parent role's supervisor.
The same release, runtime, budget and identity checks apply, plus TZ=UTC. Its preflight is the consumer preflight
(identity, exact DB profile, timeouts, UTC timezone and the consumer's own readiness); it never requires batch
versioned mode or a canary, because consumers share queues with M3/mini without stopping them.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import platform
import pwd
import subprocess
import sys


ROLES = ('crawler', 'reviewer', 'publisher', 'text', 'maintenance', 'translation',
         'product-health', 'site-evidence', 'official-news', 'scheduler')
# Same Oracle-first split roles and model-bound roles as lib/jobs/batches.ts.
SPLIT_ROLES = ('translation', 'product-health', 'site-evidence', 'official-news')
MODEL_ROLES = ('translation', 'reviewer', 'publisher', 'text')
# Oracle consumer name -> parent role. Each name must also exist in lib/runtime/consumer-registry.ts (same role),
# lib/runtime/oracle-db-profile.ts ORACLE_CONSUMER_DB_PROFILES and lib/runtime/oracle-consumer-preflight.ts
# ORACLE_CONSUMER_READINESS; otherwise the preflight or supervisor refuses it. An unlisted name never starts.
CONSUMERS = {'agent-scan': 'crawler'}
FAILURE = {'code': 'oracle_runtime_preflight_unavailable'}
BASE = Path('/opt/nomorevibe-core')
APPROVED_IDENTITY = Path('/etc/nomorevibe-core/oracle-identity.json')
CGROUP_ROOT = Path('/sys/fs/cgroup')
PROC_CGROUP = Path('/proc/self/cgroup')
SLICE = 'nomorevibe-core.slice'
SERVICE_USER = 'nomorevibe-core'
HOST = 'oracle-osaka-smoke'
TARGET = {'tenancy': 'surfguide', 'region': 'ap-osaka-1', 'instance': 'osaka-smoke'}
PREFLIGHT_TIMEOUT_SECONDS = 90
MAX_PREFLIGHT_BYTES = 1024 * 1024
REQUIRED_PREFLIGHT = ('identity', 'batch', 'database', 'timeouts')
PREFLIGHT_CHECKS = ('identity', 'runtime', 'host', 'release', 'database', 'timeouts', 'budget', 'model', 'batch', 'admission')
# A consumer report has its own kind and exact key set. Batch/model/admission must say not_applicable, never verified.
CONSUMER_REQUIRED_PREFLIGHT = ('identity', 'database', 'timeouts', 'timezone', 'consumer')
CONSUMER_NOT_APPLICABLE = ('model', 'batch', 'admission')
CONSUMER_PREFLIGHT_CHECKS = PREFLIGHT_CHECKS + ('timezone', 'consumer')


class Unverified(Exception):
    def __init__(self, check, reason):
        super().__init__(f'{check}:{reason}')
        self.check, self.reason = check, reason


def _require(condition, check, reason):
    if not condition:
        raise Unverified(check, reason)


def _owned(path, owner_uid):
    """Owner-only writable. Symlink modes are meaningless; their owner is still checked."""
    stat = path.lstat()
    return stat.st_uid == owner_uid and (path.is_symlink() or not stat.st_mode & 0o022)


def check_release(env, base, launcher, owner_uid):
    from release_contract import sha
    from manage_release import verify_installed_release
    try:
        release_sha = sha(env.get('RELEASE_TAG'), 40)
    except ValueError:
        raise Unverified('release', 'release_tag_invalid') from None
    current = base / 'current'
    _require(current.is_symlink() and PurePosixPath(os.readlink(current)).parts == ('releases', release_sha),
             'release', 'current_release_mismatch')
    release = base / 'releases' / release_sha
    _require(Path(launcher).resolve() == (release / 'deploy/oracle/launch.py').resolve(), 'release', 'launcher_outside_release')
    try:
        manifest = verify_installed_release(release)
    except (OSError, ValueError):
        raise Unverified('release', 'release_tree_unverified') from None
    # A symlinked /opt/nomorevibe-core (offline staging root) is checked at both the link and its target.
    entries = [base, base.resolve(), base / 'releases', current, release, *release.rglob('*')]
    _require(all(_owned(path, owner_uid) for path in entries), 'release', 'release_not_root_owned')
    return release, manifest


def check_runtime(platform_info, user):
    _require(platform_info == {'system': 'Linux', 'machine': 'aarch64', 'libc': 'glibc'}, 'runtime', 'runtime_platform_mismatch')
    _require(sys.version_info >= (3, 11), 'runtime', 'python_version_unsupported')
    _require(user == (SERVICE_USER, False), 'runtime', 'service_account_mismatch')


def check_budget(env, role, release_sha, proc_cgroup, cgroup_root, consumer=None):
    from release_contract import load_json
    try:
        options = load_json(env.get('HOST_DB_BUDGET') or '')
        policy, process = options['policy'], options['process']
        kind = 'scheduler-parent' if role == 'scheduler' else 'role-parent'
        if consumer is None:
            # A role process never borrows a consumer slot (only the reviewer's explicit legacy slot is its own).
            slot = process.get('consumer') in ((None, 'legacy') if role == 'reviewer' else (None,))
            listed = policy['schedulerReplicas'] >= 1 if role == 'scheduler' else role in policy['roles']
        else:
            slot = process.get('consumer') == consumer
            listed = type(policy.get('consumers')) is list and consumer in policy['consumers']
        declared = (options['mode'] == 'enabled' and policy['host'] == HOST and policy['release'] == release_sha
                    and process['host'] == HOST and process['release'] == release_sha and process['kind'] == kind
                    and process['role'] == role and env.get('WORKER_ROLE') == role and env.get('PHYSICAL_HOST') == HOST
                    and slot and listed)
    except (ValueError, KeyError, TypeError, AttributeError):
        declared = False
    _require(declared, 'budget', 'host_db_budget_undeclared')
    # cgroup v2 single line: this process must already run inside the shared core slice.
    lines = proc_cgroup.read_text().splitlines() if proc_cgroup.is_file() else []
    parts = PurePosixPath(lines[0][3:]).parts if len(lines) == 1 and lines[0].startswith('0::/') else ()
    _require(len(parts) >= 2 and parts[1] == SLICE, 'budget', 'core_slice_not_applied')
    limits = {}
    for name in ('cpu.max', 'memory.max', 'pids.max'):
        path = cgroup_root / SLICE / name
        limits[name] = path.read_text().split() if path.is_file() else []
    # The kernel must enforce numeric aggregate limits; "max" means unbounded.
    _require(len(limits['cpu.max']) == 2 and all(value.isdigit() for value in limits['cpu.max'])
             and all(len(limits[name]) == 1 and limits[name][0].isdigit() for name in ('memory.max', 'pids.max')),
             'budget', 'core_slice_unbounded')


def check_identity(approved_path, fetch, owner_uid):
    from release_contract import load_json
    import oci_identity
    _require(approved_path.is_file() and not approved_path.is_symlink() and _owned(approved_path, owner_uid),
             'identity', 'approved_identity_unavailable')
    try:
        return oci_identity.validate_identity(load_json(approved_path.read_bytes()), oci_identity.observed_identity(fetch()))
    except ValueError:
        raise Unverified('identity', 'oci_identity_unverified') from None


def run_preflight(argv, cwd, env):
    result = subprocess.run(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=PREFLIGHT_TIMEOUT_SECONDS, check=False)
    return result.returncode, result.stdout


def check_preflight(role, env, release, release_sha, runner, consumer=None):
    from release_contract import load_json
    target = f'--consumer={consumer}' if consumer is not None else f'--role={role}'
    argv = [str(release / 'runtime/bin/node'), '--import', 'tsx', 'scripts/worker-oracle-preflight.ts', target]
    try:
        code, output = runner(argv, release, env)
        _require(code == 78 and len(output) <= MAX_PREFLIGHT_BYTES, 'preflight', 'preflight_failed')
        report = load_json(output)
        checks, workload = report['checks'], report['workload']
        if consumer is None:
            kind, keys, owner = 'nomorevibe-oracle-runtime-preflight', PREFLIGHT_CHECKS, True
        else:
            kind, keys, owner = 'nomorevibe-oracle-consumer-preflight', CONSUMER_PREFLIGHT_CHECKS, report['consumer'] == consumer
        shaped = (report['kind'] == kind and report['version'] == 1 and owner
                  and report['role'] == role and report['configuredHost'] == TARGET
                  and report['instanceId'] == env.get('SERVICE_INSTANCE_ID') and report['releaseSha'] == release_sha
                  and report['ready'] is False and report['activationAllowed'] is False
                  and type(checks) is dict and set(checks) == set(keys))
    except (subprocess.TimeoutExpired, OSError, ValueError, KeyError, TypeError):
        raise Unverified('preflight', 'preflight_unavailable') from None
    _require(shaped, 'preflight', 'preflight_report_mismatch')
    _require(all(type(value) is dict and value.get('status') != 'rejected' for value in checks.values()),
             'preflight', 'preflight_rejected')
    if consumer is not None:
        for name in CONSUMER_NOT_APPLICABLE:
            _require(checks[name].get('status') == 'not_applicable', 'preflight', f'{name}_unexpected')
    required = CONSUMER_REQUIRED_PREFLIGHT if consumer is not None else REQUIRED_PREFLIGHT + (('model',) if role in MODEL_ROLES else ())
    for name in required:
        _require(checks[name].get('status') == 'verified', 'preflight', f'{name}_unverified')
    # Admission exists only after election; the elected process re-checks it at every claim. The scheduler claims
    # nothing: its workload is ready only for the boot an attested canary tick recorded, which every restart replaces.
    _require(type(workload) is dict and workload.get('ready') is True, 'preflight', 'workload_unverified')
    return report


def role_command(role, release):
    node = str(release / 'runtime/bin/node')
    if role == 'scheduler':
        return node, [node, '--import', 'tsx', 'scripts/worker-supervisor.ts', '--role=scheduler']
    kind = 'primary' if role in SPLIT_ROLES else 'standby'
    return node, [node, '--import', 'tsx', 'scripts/role-worker.ts', f'--role={role}', f'--kind={kind}']


def consumer_command(consumer, release):
    """The parent role's supervisor runs the consumer's fixed child (lib/runtime/consumer-registry.ts)."""
    node = str(release / 'runtime/bin/node')
    return node, [node, '--import', 'tsx', 'scripts/worker-supervisor.ts', f'--role={CONSUMERS[consumer]}', f'--consumer={consumer}']


def gate(role, env, **fixtures):
    """Keyword arguments exist for local fixtures only; main() never passes them."""
    _require(role in ROLES, 'role', 'role_invalid')
    return _gate(role, None, env, **fixtures)


def consumer_gate(consumer, env, **fixtures):
    """Same fixed order as gate(); keyword arguments exist for local fixtures only."""
    _require(consumer in CONSUMERS, 'consumer', 'consumer_invalid')
    return _gate(CONSUMERS[consumer], consumer, env, **fixtures)


def _gate(role, consumer, env, *, base=BASE, launcher=__file__, owner_uid=0, platform_info=None, user=None,
          proc_cgroup=PROC_CGROUP, cgroup_root=CGROUP_ROOT, approved_identity=APPROVED_IDENTITY,
          fetch=None, runner=run_preflight):
    from release_contract import release_profile
    if platform_info is None:
        platform_info = {'system': platform.system(), 'machine': platform.machine(), 'libc': platform.libc_ver()[0]}
    if user is None:
        user = (pwd.getpwuid(os.getuid()).pw_name, os.getuid() == 0)
    if fetch is None:
        from oci_identity import fetch_instance_metadata as fetch
    release, manifest = check_release(env, base, launcher, owner_uid)
    # A consumer-profile release carries no pinned CLI; only consumers start from it.
    _require(consumer is not None or release_profile(manifest) == 'full', 'release', 'release_profile_mismatch')
    check_runtime(platform_info, user)
    # Operational timestamps are timezone-less UTC; a consumer process reading them in another zone shifts by hours.
    _require(consumer is None or env.get('TZ') == 'UTC', 'runtime', 'process_timezone_not_utc')
    check_budget(env, role, env['RELEASE_TAG'], proc_cgroup, cgroup_root, consumer)
    check_identity(approved_identity, fetch, owner_uid)
    check_preflight(role, env, release, env['RELEASE_TAG'], runner, consumer)
    return (consumer_command(consumer, release) if consumer is not None else role_command(role, release)), release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--role', choices=ROLES)
    target.add_argument('--consumer', choices=sorted(CONSUMERS))
    args = parser.parse_args()
    env = dict(os.environ)
    try:
        (node, argv), release = consumer_gate(args.consumer, env) if args.consumer is not None else gate(args.role, env)
    except Unverified as error:
        print(json.dumps({'check': error.check, 'reason': error.reason}))
        print(json.dumps(FAILURE), file=sys.stderr)
        return 78
    except Exception as error:
        # Import/IO faults are never readiness; only a fixed diagnostic is printed.
        print(json.dumps({'check': 'launcher', 'reason': type(error).__name__}))
        print(json.dumps(FAILURE), file=sys.stderr)
        return 78
    os.chdir(release)
    os.execve(node, argv, env)


if __name__ == '__main__':
    raise SystemExit(main())
