#!/usr/bin/env python3
"""Oracle role launcher. The fixed role process starts only when every readiness check is verified.

Checks run in a fixed order and stop at the first result that is not verified: installed release, runtime
account/platform, host budget, OCI identity, then the existing runtime preflight (batch, DB authority,
timeouts and the PR10d canary, or for the scheduler its attested tick canary of the current boot). Any unknown or
rejected result exits78. No flag, environment variable,
supplied receipt or local marker can skip a check. Database election and per-claim admission still apply
after start; this gate never writes DB state.
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


def check_budget(env, role, release_sha, proc_cgroup, cgroup_root):
    from release_contract import load_json
    try:
        options = load_json(env.get('HOST_DB_BUDGET') or '')
        policy, process = options['policy'], options['process']
        kind = 'scheduler-parent' if role == 'scheduler' else 'role-parent'
        declared = (options['mode'] == 'enabled' and policy['host'] == HOST and policy['release'] == release_sha
                    and process['host'] == HOST and process['release'] == release_sha and process['kind'] == kind
                    and process['role'] == role and env.get('WORKER_ROLE') == role and env.get('PHYSICAL_HOST') == HOST
                    and (policy['schedulerReplicas'] >= 1 if role == 'scheduler' else role in policy['roles']))
    except (ValueError, KeyError, TypeError):
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


def check_preflight(role, env, release, release_sha, runner):
    from release_contract import load_json
    argv = [str(release / 'runtime/bin/node'), '--import', 'tsx', 'scripts/worker-oracle-preflight.ts', f'--role={role}']
    try:
        code, output = runner(argv, release, env)
        _require(code == 78 and len(output) <= MAX_PREFLIGHT_BYTES, 'preflight', 'preflight_failed')
        report = load_json(output)
        checks, workload = report['checks'], report['workload']
        shaped = (report['kind'] == 'nomorevibe-oracle-runtime-preflight' and report['version'] == 1
                  and report['role'] == role and report['configuredHost'] == TARGET
                  and report['instanceId'] == env.get('SERVICE_INSTANCE_ID') and report['releaseSha'] == release_sha
                  and report['ready'] is False and report['activationAllowed'] is False
                  and type(checks) is dict and set(checks) == set(PREFLIGHT_CHECKS))
    except (subprocess.TimeoutExpired, OSError, ValueError, KeyError, TypeError):
        raise Unverified('preflight', 'preflight_unavailable') from None
    _require(shaped, 'preflight', 'preflight_report_mismatch')
    _require(all(type(value) is dict and value.get('status') != 'rejected' for value in checks.values()),
             'preflight', 'preflight_rejected')
    for name in REQUIRED_PREFLIGHT + (('model',) if role in MODEL_ROLES else ()):
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


def gate(role, env, *, base=BASE, launcher=__file__, owner_uid=0, platform_info=None, user=None,
         proc_cgroup=PROC_CGROUP, cgroup_root=CGROUP_ROOT, approved_identity=APPROVED_IDENTITY,
         fetch=None, runner=run_preflight):
    """Keyword arguments exist for local fixtures only; main() never passes them."""
    _require(role in ROLES, 'role', 'role_invalid')
    if platform_info is None:
        platform_info = {'system': platform.system(), 'machine': platform.machine(), 'libc': platform.libc_ver()[0]}
    if user is None:
        user = (pwd.getpwuid(os.getuid()).pw_name, os.getuid() == 0)
    if fetch is None:
        from oci_identity import fetch_instance_metadata as fetch
    release, _ = check_release(env, base, launcher, owner_uid)
    check_runtime(platform_info, user)
    check_budget(env, role, env['RELEASE_TAG'], proc_cgroup, cgroup_root)
    check_identity(approved_identity, fetch, owner_uid)
    check_preflight(role, env, release, env['RELEASE_TAG'], runner)
    return role_command(role, release), release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', required=True, choices=ROLES)
    args = parser.parse_args()
    env = dict(os.environ)
    try:
        (node, argv), release = gate(args.role, env)
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
