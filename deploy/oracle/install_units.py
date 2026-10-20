"""Install rendered nomorevibe-core units and placeholder env files under one root directory.

Without --apply the root must be a caller-owned staging directory (never "/"); no command runs.
With --apply the root must be "/": the nonroot account is created when absent, env placeholders are
root-owned0600, and only `systemctl daemon-reload` runs. No unit is enabled or started here; filling
an env file or installing a unit is never readiness evidence.

--refresh-role additionally writes the inactive capability refresh service/timer templates and a refresh.env
placeholder (0600, never overwritten); with --apply it creates the separate nomorevibe-attest account. Enabling a
timer is a separate operator decision (README "Capability refresh policy"); this tool never enables it.

--consumer writes the consumer unit template and a consumer-<name>.env placeholder (0600, never overwritten) for a
consumer listed in launch.py CONSUMERS. It may be the only selection; it never enables or starts a unit either.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from launch import CONSUMERS
from manage_release import render_units


SERVICE_USER = 'nomorevibe-core'
UNIT_DIR = Path('etc/systemd/system')
ENV_DIR = Path('etc/nomorevibe-core')
ROLES = ('translation', 'product-health', 'site-evidence', 'official-news', 'scheduler')
REFRESH_ROLES = ('translation', 'product-health', 'site-evidence', 'official-news')
REFRESH_USER = 'nomorevibe-attest'
REFRESH_UNITS = ('nomorevibe-core-refresh@.service', 'nomorevibe-core-refresh@.timer')
CONSUMER_UNIT = 'nomorevibe-core-consumer@.service'
EXCLUDED = ('nomorevibe-x', 'mautic', 'mautic-retired-20261015T050901Z')


def _root(root, apply, live_root):
    root = Path(root)
    if not root.is_absolute() or root.is_symlink() or any(part in EXCLUDED for part in (*root.parts, *root.resolve().parts)):
        raise ValueError('install_root_invalid')
    if apply != (root.resolve() == Path(live_root).resolve()):
        # Live "/" only with --apply; --apply never targets a staging tree.
        raise ValueError('install_root_apply_mismatch')
    for relative in (Path('etc'), UNIT_DIR, Path('etc/nomorevibe-core')):
        if (root / relative).is_symlink():
            raise ValueError('install_path_symlink')
    return root


def _write_atomic(path, content, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def env_placeholder(role, consumer=None):
    name = {'scheduler': 'scheduler.env.example', 'refresh': 'refresh.env.example'}.get(role, 'role.env.example')
    source = Path(__file__).parent / ('consumer.env.example' if consumer is not None else name)
    lines = source.read_text().splitlines()
    if role not in ('scheduler', 'refresh'):
        lines = [f'WORKER_ROLE={role}' if line == 'WORKER_ROLE=' else line for line in lines]
    return '\n'.join(lines) + '\n'


def install_units(root, cpu_quota_percent, memory_bytes, tasks, roles, *, refresh_roles=(), consumers=(), apply=False,
                  live_root='/', runner=subprocess.run):
    """live_root/runner exist for local fixtures only; the CLI never passes them."""
    if (not roles and not consumers or any(role not in ROLES for role in roles) or len(set(roles)) != len(roles)
            or any(consumer not in CONSUMERS for consumer in consumers) or len(set(consumers)) != len(consumers)):
        raise ValueError('install_roles_invalid')
    if (any(role not in REFRESH_ROLES or role not in roles for role in refresh_roles)
            or len(set(refresh_roles)) != len(refresh_roles)):
        raise ValueError('install_refresh_roles_invalid')
    root = _root(root, apply, live_root)
    units = render_units(cpu_quota_percent, memory_bytes, tasks)
    if refresh_roles:
        units.update({name: (Path(__file__).parent / name).read_text() for name in REFRESH_UNITS})
    if consumers:
        units[CONSUMER_UNIT] = (Path(__file__).parent / CONSUMER_UNIT).read_text()
    commands = []
    if apply:
        # The refresh account is separate so the worker account can never read the refresh credential (/proc environ).
        for user, home in ((SERVICE_USER, '/var/lib/nomorevibe-core'),) + (((REFRESH_USER, '/var/lib/nomorevibe-attest'),) if refresh_roles else ()):
            found = runner(['getent', 'passwd', user], stdout=subprocess.DEVNULL, check=False)
            if found.returncode == 2:
                command = ['useradd', '--system', '--user-group', '--no-create-home',
                           '--home-dir', home, '--shell', '/usr/sbin/nologin', user]
                commands.append(command)
                runner(command, check=True)
            elif found.returncode != 0:
                raise RuntimeError('service_account_lookup_failed')
    written = []
    for name, content in sorted(units.items()):
        _write_atomic(root / UNIT_DIR / name, content, 0o644)
        written.append(str(UNIT_DIR / name))
    (root / ENV_DIR).mkdir(parents=True, exist_ok=True)
    # The nonroot launcher reads the approved identity record here; env files themselves stay0600.
    os.chmod(root / ENV_DIR, 0o755)
    preserved = []
    envs = [(f'{role}.env', env_placeholder(role)) for role in [*roles, *(['refresh'] if refresh_roles else [])]]
    envs += [(f'consumer-{consumer}.env', env_placeholder(CONSUMERS[consumer], consumer)) for consumer in consumers]
    for name, content in envs:
        target = root / ENV_DIR / name
        if target.is_symlink():
            raise ValueError('install_path_symlink')
        if target.exists():
            # Existing env files may already hold operator secrets; never rewrite them.
            preserved.append(str(ENV_DIR / name))
            continue
        # Root writes on --apply, so the placeholder is root-owned0600 outside the release.
        _write_atomic(target, content, 0o600)
        written.append(str(ENV_DIR / name))
    if apply:
        runner(['systemctl', 'daemon-reload'], check=True)
        commands.append(['systemctl', 'daemon-reload'])
    return {'written': written, 'preserved': preserved, 'commands': commands, 'enabled': [], 'started': [],
            'timersEnabled': [], 'activationAllowed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--cpu-quota-percent', required=True, type=int)
    parser.add_argument('--memory-bytes', required=True, type=int)
    parser.add_argument('--tasks', required=True, type=int)
    parser.add_argument('--role', action='append', default=[], choices=ROLES)
    parser.add_argument('--refresh-role', action='append', default=[], choices=REFRESH_ROLES)
    parser.add_argument('--consumer', action='append', default=[], choices=sorted(CONSUMERS))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        result = install_units(args.root, args.cpu_quota_percent, args.memory_bytes, args.tasks, args.role,
                               refresh_roles=args.refresh_role, consumers=args.consumer, apply=args.apply)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'code': 'oracle_unit_install_failed'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
