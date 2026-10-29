"""Supa administrator argv executor and read-only, root-owned receipt collector.
No sudo, remote mutation, TTL release, or DB access. Installed beside the pinned helpers.
"""
import hashlib
import types
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys

INSTALL = Path('/usr/local/libexec/nmv-admin-models')
RESULTS = Path('/var/lib/nmv-admin-models-root/results')
PROGRESS = '/var/lib/nmv-admin-models-root/progress'
LIMIT = 5 * 1048576


def need(ok, code):
    if not ok:
        raise ValueError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def trusted_root(path, directory=False):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'root_absolute_path_required')
    for part in (*reversed(path.parents), path):
        info = part.lstat()
        need(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'root_owned_path_required')
    need(path.is_dir() if directory else path.is_file(), 'root_file_type_invalid')
    return path


def bounded(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_size <= LIMIT, 'bounded_task_required')
        raw = os.read(fd, LIMIT + 1)
        need(len(raw) <= LIMIT, 'bounded_task_required')
        return raw
    finally:
        os.close(fd)


def modules(task):
    values = {}
    for name in ('systemd_action.py', 'systemd_reader.py', 'systemd_handoff.py'):
        raw = bounded(trusted_root(INSTALL / name))
        need(digest(raw) == task['sourceHashes'][name], 'root_helper_source_changed')
        values[name] = raw.decode()
    module = types.ModuleType('reviewed_systemd_action')
    exec(compile(values['systemd_action.py'], '<reviewed-systemd-action>', 'exec'), module.__dict__)
    return module, values['systemd_reader.py']


def validate_task(task):
    need(set(task) == {'version', 'nonce', 'targetKey', 'payload', 'sourceHashes'} and task['version'] == 1, 'root_task_shape_invalid')
    need(re.fullmatch('[a-f0-9]{32}', task['nonce']) and re.fullmatch('[a-z][a-z0-9-]{0,40}', task['targetKey']), 'root_task_identity_invalid')
    value = task['payload']
    need(value['mode'] in ('stop', 'restore') and value['service'] == 'vllm.service' and value['progressRoot'] == PROGRESS, 'supa_root_scope_required')
    need(re.fullmatch('[a-f0-9]{64}', value['operationHash']) and str(__import__('uuid').UUID(value['requestId'])) == value['requestId'], 'root_operation_binding_required')
    need(set(task['sourceHashes']) == {'systemd_action.py', 'systemd_reader.py', 'systemd_handoff.py'}
         and all(re.fullmatch('[a-f0-9]{64}', v) for v in task['sourceHashes'].values()), 'root_helper_hashes_required')
    return digest(canonical(task))


def payload(task, reader):
    return dict(task['payload'], reader=reader, readerSha256=digest(reader.encode()))


def save_once(path, value, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(canonical(value) + b'\n')
            output.flush()
            os.fsync(output.fileno())
    finally:
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def execute(request_path, expected_hash):
    need(os.geteuid() == 0, 'administrator_root_execution_required')
    need(re.fullmatch('[a-f0-9]{64}', expected_hash), 'reviewed_task_hash_required')
    task = json.loads(bounded(request_path))
    task_hash = validate_task(task)
    need(task_hash == expected_hash, 'reviewed_task_changed')
    trusted_root(RESULTS, True)
    module, reader = modules(task)
    value = payload(task, reader)
    result_file = RESULTS / (task_hash + '.json')
    need(not result_file.exists(), 'root_result_exists_collect_readonly')
    marker = RESULTS / (task_hash + '.attempt.json')
    # Serialize root invocations. An interrupted mutation is NEVER sent again.
    import fcntl
    lock = os.open(RESULTS / (task_hash + '.lock'), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if marker.exists():
            need(json.loads(bounded(trusted_root(marker))) == {'taskHash': task_hash}, 'root_attempt_binding_changed')
            value['mode'] = 'read-stop-progress' if value['mode'] == 'stop' else 'read-restore-progress'
        else:
            save_once(marker, {'taskHash': task_hash}, 0o600)
        result = module.operate(value, module.NativeBackend(value), Path(PROGRESS))
        need(result.get('verified') is True, 'root_physical_evidence_missing')
        save_once(result_file, {'version': 1, 'taskHash': task_hash, 'result': result}, 0o644)
    finally:
        os.close(lock)
    return {'ok': True, 'resultPath': str(result_file), 'taskHash': task_hash}


def collect(task):
    task_hash = validate_task(task)
    trusted_root(RESULTS, True)
    result_file = RESULTS / (task_hash + '.json')
    if not result_file.exists():
        return {'state': 'root_result_missing'}
    record = json.loads(bounded(trusted_root(result_file)))
    need(set(record) == {'version', 'taskHash', 'result'} and record['version'] == 1 and record['taskHash'] == task_hash
         and record['result'].get('verified') is True, 'root_result_binding_invalid')
    module, reader = modules(task)
    value = payload(task, reader)
    expected = value['expected']
    module.BOOT = expected['hostBootId']
    module.INVOCATION = expected['unitProperties']['InvocationID']
    module.OLD_PID = int(expected['unitProperties']['MainPID'])
    module.validate_expected(expected)
    backend = module.NativeBackend(value)
    # A root receipt is an ACK, not a fresh exit proof. Re-read boot, configuration,
    # MainPID, recursive cgroup and original process start ticks at collection time.
    if value['mode'] == 'stop':
        module.empty(record['result'])
        live = backend.stopped()
        module.empty(live)
    else:
        module.restored(record['result'], expected)
        live = backend.wait_ready()
        module.restored(live, expected)
        need(live['restoredIdentity']['unitProperties'] == record['result']['restoredIdentity']['unitProperties'], 'root_restored_incarnation_changed')
    return dict(live, verified=True, rootTaskHash=task_hash, rootResultHash=digest(canonical(record)))


if __name__ == '__main__':
    os.umask(0o022)
    signal.alarm(55)
    try:
        if len(sys.argv) == 4 and sys.argv[1] == 'execute':
            outcome = execute(sys.argv[2], sys.argv[3])
        elif sys.argv[1:] == ['collect']:
            raw = sys.stdin.buffer.read(LIMIT + 1)
            need(len(raw) <= LIMIT, 'bounded_task_required')
            outcome = collect(json.loads(raw))
        else:
            raise ValueError('root_handoff_arguments_denied')
        print(json.dumps(outcome))
    except Exception as error:
        # Never serialize subprocess output, configuration, metrics or exception text.
        known = {'root_owned_path_required', 'root_file_type_invalid', 'root_result_binding_invalid',
                 'root_helper_source_changed', 'supa_full_cgroup_exit_unproved', 'pinned_systemd_identity_required',
                 'pinned_systemd_process_required', 'supa_restore_config_or_identity_changed', 'root_restored_incarnation_changed',
                 'reviewed_task_changed', 'root_result_exists_collect_readonly', 'durable_supa_ack_binding_invalid'}
        code = str(error) if isinstance(error, ValueError) and str(error) in known else 'root_installation_or_evidence_unproven'
        print(json.dumps({'state': 'root_handoff_unproven', 'code': code}))
        sys.exit(0 if sys.argv[1:] == ['collect'] else 1)
