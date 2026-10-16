"""Install rendered nomorevibe-core units and placeholder env files under one root directory.

Without --apply the root must be a caller-owned staging directory (never "/"); no command runs.
With --apply the root must be "/": the nonroot account is created when absent, env placeholders are
root-owned0600, and only `systemctl daemon-reload` runs. No unit is enabled or started here; filling
an env file or installing a unit is never readiness evidence.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from manage_release import render_units


SERVICE_USER = 'nomorevibe-core'
UNIT_DIR = Path('etc/systemd/system')
ENV_DIR = Path('etc/nomorevibe-core')
ROLES = ('translation', 'product-health', 'site-evidence', 'official-news', 'scheduler')
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


def env_placeholder(role):
    source = Path(__file__).parent / ('scheduler.env.example' if role == 'scheduler' else 'role.env.example')
    lines = source.read_text().splitlines()
    if role != 'scheduler':
        lines = [f'WORKER_ROLE={role}' if line == 'WORKER_ROLE=' else line for line in lines]
    return '\n'.join(lines) + '\n'


def install_units(root, cpu_quota_percent, memory_bytes, tasks, roles, *, apply=False, live_root='/', runner=subprocess.run):
    """live_root/runner exist for local fixtures only; the CLI never passes them."""
    if not roles or any(role not in ROLES for role in roles) or len(set(roles)) != len(roles):
        raise ValueError('install_roles_invalid')
    root = _root(root, apply, live_root)
    units = render_units(cpu_quota_percent, memory_bytes, tasks)
    commands = []
    if apply:
        found = runner(['getent', 'passwd', SERVICE_USER], stdout=subprocess.DEVNULL, check=False)
        if found.returncode == 2:
            commands.append(['useradd', '--system', '--user-group', '--no-create-home',
                             '--home-dir', '/var/lib/nomorevibe-core', '--shell', '/usr/sbin/nologin', SERVICE_USER])
        elif found.returncode != 0:
            raise RuntimeError('service_account_lookup_failed')
        for command in commands:
            runner(command, check=True)
    written = []
    for name, content in sorted(units.items()):
        _write_atomic(root / UNIT_DIR / name, content, 0o644)
        written.append(str(UNIT_DIR / name))
    (root / ENV_DIR).mkdir(parents=True, exist_ok=True)
    # The nonroot launcher reads the approved identity record here; env files themselves stay0600.
    os.chmod(root / ENV_DIR, 0o755)
    preserved = []
    for role in roles:
        target = root / ENV_DIR / f'{role}.env'
        if target.is_symlink():
            raise ValueError('install_path_symlink')
        if target.exists():
            # Existing env files may already hold operator secrets; never rewrite them.
            preserved.append(str(ENV_DIR / f'{role}.env'))
            continue
        # Root writes on --apply, so the placeholder is root-owned0600 outside the release.
        _write_atomic(target, env_placeholder(role), 0o600)
        written.append(str(ENV_DIR / f'{role}.env'))
    if apply:
        runner(['systemctl', 'daemon-reload'], check=True)
        commands.append(['systemctl', 'daemon-reload'])
    return {'written': written, 'preserved': preserved, 'commands': commands, 'enabled': [], 'started': [],
            'activationAllowed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--cpu-quota-percent', required=True, type=int)
    parser.add_argument('--memory-bytes', required=True, type=int)
    parser.add_argument('--tasks', required=True, type=int)
    parser.add_argument('--role', required=True, action='append', choices=ROLES)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        result = install_units(args.root, args.cpu_quota_percent, args.memory_bytes, args.tasks, args.role, apply=args.apply)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'code': 'oracle_unit_install_failed'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
