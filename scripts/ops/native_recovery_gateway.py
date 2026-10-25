#!/usr/bin/env python3
"""Forced command for one failed native consumer; never restarts a live unit.

Run with python3 -I from a root-owned installation. Recovery changes no unit,
release, environment, model or database policy. systemd has no atomic state CAS:
operators must disarm recoverEnabled before deliberately stopping this unit.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import time


UNIT = 'nomorevibe-core-consumer@agent-scan.service'
KEY = 'agent-scan'
PROPERTIES = ('Id', 'Names', 'LoadState', 'UnitFileState', 'ActiveState', 'SubState', 'MainPID',
              'StateChangeTimestampMonotonic', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload',
              'Transient', 'User', 'Group', 'ExecStart', 'ControlGroup', 'KillMode', 'Restart', 'Result', 'Slice')


def trusted_path(value, *, directory=False, private=False):
    """Reject symlinks and every non-root-owned or writable path component."""
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('untrusted_path')
    for current in (*reversed(path.parents), path):
        info = current.lstat()
        is_directory = current != path or directory
        if (info.st_uid != 0 or info.st_mode & 0o022 or
                not (stat.S_ISDIR(info.st_mode) if is_directory else stat.S_ISREG(info.st_mode))):
            raise ValueError('untrusted_path')
        if current == path and private and info.st_mode & 0o077:
            raise ValueError('private_file_required')
    return path


def load_shared():
    # -I intentionally removes the script directory from sys.path. Load the
    # exact trusted sibling instead of trusting CWD, PYTHONPATH or a search path.
    source = trusted_path(Path(__file__).absolute())
    shared = trusted_path(source.with_name('recovery_gateway.py'))
    spec = importlib.util.spec_from_file_location('_native_recovery_shared', shared)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command(argv):
    return load_shared().bounded_output(argv, limit=32768, timeout=25).decode('utf-8')


def read_config(value):
    path = trusted_path(value, private=True)
    config = json.loads(path.read_text())
    fields = {'state', 'unitFile', 'unitSha256', 'controlGroup', 'user', 'group', 'execStart', 'recoverEnabled'}
    if not isinstance(config, dict) or set(config) != fields:
        raise ValueError('invalid_configuration')
    if (type(config['recoverEnabled']) is not bool or config['user'] != 'nomorevibe-core' or
            config['group'] != 'nomorevibe-core' or not isinstance(config['unitSha256'], str) or
            not re.fullmatch('[a-f0-9]{64}', config['unitSha256']) or
            not isinstance(config['controlGroup'], str) or
            not re.fullmatch(r'/[a-z0-9_.@/-]+/' + re.escape(UNIT), config['controlGroup']) or
            '..' in Path(config['controlGroup']).parts or
            not isinstance(config['execStart'], str) or
            not re.fullmatch(r'/usr/bin/python3 /[a-zA-Z0-9_./-]+/deploy/oracle/launch\.py --consumer=agent-scan', config['execStart'])):
        raise ValueError('invalid_configuration')
    unit = trusted_path(config['unitFile'])
    if unit.name != 'nomorevibe-core-consumer@.service':
        raise ValueError('invalid_unit_identity')
    state = Path(config['state'])
    if not state.is_absolute() or state.name in ('', '.', '..') or '..' in state.parts:
        raise ValueError('invalid_state_path')
    trusted_path(state.parent, directory=True, private=True)
    for candidate in (state, Path(str(state) + '.lock'), state.with_suffix('.tmp')):
        if candidate.exists() or candidate.is_symlink():
            trusted_path(candidate, private=True)
    if state in (path, unit, Path(__file__).absolute(), Path(__file__).with_name('recovery_gateway.py').absolute()):
        raise ValueError('invalid_state_path')
    config['_configPath'] = str(path)
    return config


def cgroup_empty(group, *, root=Path('/sys/fs/cgroup')):
    """cgroup.events populated is recursive; an empty cgroup.procs is not."""
    if (not isinstance(group, str) or not group.startswith('/') or '..' in Path(group).parts or
            not group.endswith('/' + UNIT)):
        raise ValueError('invalid_cgroup')
    trusted_path(root, directory=True)
    trusted_path(root / 'cgroup.controllers')  # A missing v2 mount is not an absent unit.
    target = root / group.lstrip('/')
    try:
        target.lstat()
    except FileNotFoundError:
        trusted_path(target.parent, directory=True)
        return True
    trusted_path(target, directory=True)
    events = trusted_path(target / 'cgroup.events')
    with events.open() as source:
        content = source.read(1025)
    values = [line.split() for line in content.splitlines() if line.startswith('populated')]
    if len(content) > 1024 or len(values) != 1 or values[0] not in (['populated', '0'], ['populated', '1']):
        raise ValueError('invalid_cgroup_events')
    return values[0][1] == '0'


def properties(config, run):
    output = run(['/usr/bin/systemctl', 'show', '--no-pager', '--property=' + ','.join(PROPERTIES), UNIT])
    values = {}
    for line in output.splitlines():
        key, separator, value = line.partition('=')
        if not separator or key not in PROPERTIES or key in values:
            raise ValueError('invalid_unit_report')
        values[key] = value
    if set(values) != set(PROPERTIES):
        raise ValueError('incomplete_unit_report')
    unit = trusted_path(config['unitFile'])
    with unit.open('rb') as source:
        raw = source.read(262145)
    executable = config['execStart'].split(' ', 1)[0]
    prefix = '{ path=' + executable + ' ; argv[]=' + config['execStart'] + ' ; ignore_errors=no ;'
    if (len(raw) > 262144 or hashlib.sha256(raw).hexdigest() != config['unitSha256'] or
            values['Id'] != UNIT or values['Names'] != UNIT or values['LoadState'] != 'loaded' or
            values['UnitFileState'] != 'enabled' or values['FragmentPath'] != str(unit) or
            values['DropInPaths'] or values['NeedDaemonReload'] != 'no' or values['Transient'] != 'no' or
            values['User'] != config['user'] or values['Group'] != config['group'] or
            not values['ExecStart'].startswith(prefix) or values['ExecStart'].count('{') != 1 or
            values['ExecStart'].count('}') != 1 or not values['ExecStart'].endswith(' }') or
            values['Slice'] != Path(config['controlGroup']).parent.name or
            not (values['ControlGroup'] == config['controlGroup'] or
                 values['ControlGroup'] == '' and values['MainPID'] == '0' and
                 values['ActiveState'] in ('failed', 'inactive')) or
            values['KillMode'] not in ('mixed', 'control-group') or values['Restart'] != 'on-failure'):
        raise ValueError('unit_identity_changed')
    return values


def observe(config, *, run=command, uptime=None, empty_fn=cgroup_empty):
    row = {'key': KEY, 'version': None, 'replicas': 1, 'settled': False,
           'ok': False, 'recoverable': False, 'reason': 'native_unit_unknown'}
    try:
        values = properties(config, run)
        version = values['StateChangeTimestampMonotonic']
        pid = values['MainPID']
        if not re.fullmatch('[0-9]{1,16}', version) or not 0 < int(version) < 10 ** 16 or not pid.isdecimal():
            return row
        uptime = time.monotonic() if uptime is None else uptime
        age = uptime - int(version) / 1_000_000
        if not math.isfinite(age) or age < 0:
            return row
        row.update(version=int(version), settled=age >= 180)
        active = values['ActiveState']
        if active == 'active' and values['SubState'] == 'running' and int(pid) > 0:
            row.update(ok=True, reason='ok')
        elif active == 'inactive' and int(pid) == 0:
            row['reason'] = 'native_unit_inactive'
        elif active == 'failed':
            row['reason'] = 'native_unit_failed'
            if int(pid) == 0 and row['settled']:
                row['recoverable'] = empty_fn(config['controlGroup']) is True and config['recoverEnabled'] is True
        return row
    except Exception:
        row.update(ok=False, recoverable=False, reason='native_unit_unknown')
        return row


def probe(config):
    return {'services': [observe(config)]}


def start_unit(config, version, *, run=command, observe_fn=observe, empty_fn=cgroup_empty):
    if config.get('recoverEnabled') is not True:
        return {'result': 'refused'}
    if '_configPath' in config and read_config(config['_configPath']) != config:
        return {'result': 'refused'}
    row = observe_fn(config)
    if row.get('version') != version or row.get('recoverable') is not True or row.get('settled') is not True:
        return {'result': 'refused'}
    # There is no restart/stop/kill operation, nor any variable unit argument.
    run(['/usr/bin/systemctl', 'reset-failed', UNIT])
    # reset-failed clears the failed state. Recheck identity and recursive
    # emptiness before admission; fail job mode never replaces an operator job.
    values = properties(config, run)
    if (values['ActiveState'] != 'inactive' or values['SubState'] != 'dead' or values['MainPID'] != '0' or
            empty_fn(config['controlGroup']) is not True):
        return {'result': 'refused'}
    if '_configPath' in config and read_config(config['_configPath']) != config:
        return {'result': 'refused'}
    run(['/usr/bin/systemctl', 'start', '--job-mode=fail', UNIT])
    return {'result': 'requested'}


def recover(config, key, version, *, now=None, probe_fn=probe, start_fn=start_unit):
    if key != KEY or type(version) is not int or not 0 < version < 10 ** 16 or config.get('recoverEnabled') is not True:
        return {'result': 'refused'}
    path = Path(config['state'])
    trusted_path(path.parent, directory=True, private=True)
    lock_path = Path(str(path) + '.lock')
    if lock_path.exists() or lock_path.is_symlink():
        trusted_path(lock_path, private=True)
    fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            now = time.time() if now is None else now
            if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
                return {'result': 'limited'}
            if path.exists() or path.is_symlink():
                trusted_path(path, private=True)
                state = json.loads(path.read_text())
            else:
                state = {'attempts': {}}
            if not isinstance(state, dict) or set(state) != {'attempts'} or not isinstance(state['attempts'], dict):
                return {'result': 'limited'}
            attempts = state['attempts'].get(KEY, [])
            if not isinstance(attempts, list) or any(type(at) not in (int, float) or not math.isfinite(at) or at < 0 or at > now for at in attempts):
                return {'result': 'limited'}
            attempts = [at for at in attempts if now - at < 86400]
            if len(attempts) >= 2 or attempts and now - max(attempts) < 900:
                return {'result': 'limited'}
            row = next((row for row in probe_fn(config)['services'] if row.get('key') == KEY), {})
            if row.get('version') != version or row.get('recoverable') is not True or row.get('settled') is not True:
                return {'result': 'refused'}
            state['attempts'][KEY] = attempts + [now]
            # Reserve before reset-failed too: unknown SSH/command outcomes consume the budget.
            temporary = path.with_suffix('.tmp')
            if temporary.exists() or temporary.is_symlink():
                trusted_path(temporary, private=True)
            load_shared().save(path, state)
            return start_fn(config, version)
        except Exception:
            return {'result': 'unknown'}


def parse_command(value):
    if value == 'probe':
        return ('probe',)
    match = re.fullmatch(r'recover agent-scan ([0-9]{1,16})', value)
    if not match or not 0 < int(match[1]) < 10 ** 16:
        raise ValueError('command_denied')
    return ('recover', KEY, int(match[1]))


def main():
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--config', required=True)
        args = parser.parse_args()
        load_shared()
        config = read_config(args.config)
        action = parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
        result = probe(config) if action[0] == 'probe' else recover(config, *action[1:])
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': 'gateway_denied'}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
