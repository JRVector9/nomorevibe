"""Reviewed V1 coordinator. Only a private, hash-bound manifest supplies hosts/snapshots.
No DB credentials, model POST, sudo, TTL, arbitrary queue command or automatic mutation retry.
The public runner invokes prepare, stop/resume-stop, verify-stop, restore, verify-restored.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

HELPERS = Path(__file__).with_name('admin_models_helpers')
PHASES = {'prepare', 'plan', 'stop', 'resume-stop', 'verify-stop', 'refresh-evidence', 'restore', 'resume-restore', 'verify-restored'}


class BoundaryError(ValueError):
    pass


def need(ok, code):
    if not ok:
        raise BoundaryError(code)


def canon(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def private(path, directory=False):
    path = Path(path)
    need(path.is_absolute() and '..' not in path.parts, 'private_absolute_path_required')
    for current in (*reversed(path.parents), path):
        info = current.lstat()
        need(not current.is_symlink() and info.st_uid in (0, os.geteuid()) and not info.st_mode & 0o022, 'untrusted_operator_path')
    if directory:
        need(path.is_dir() and path.stat().st_mode & 0o077 == 0, 'private_directory_required')
    else:
        need(path.is_file() and path.stat().st_size <= 5 * 1048576, 'bounded_private_file_required')
    return path


def save(path, value):
    raw = canon(value) + b'\n'
    temporary = path.with_name(path.name + '.' + str(uuid.uuid4()) + '.new')
    with temporary.open('xb') as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return sha(raw)


def configuration(targets):
    return sha(canon([{k: target['expected'].get(k) for k in ('serviceSpecSansReplicaSha256', 'unitFileSha256', 'unitConfigurationSha256')}
                      if target['kind'] != 'launchd' else target['nativeMaterial']['configs'] | {
                          'plist': target['identity']['plistSha256'], 'entry': target['identity']['entrySha256']}
                      for target in targets]))


def main(phase, envelope):
    need(phase in PHASES, 'phase_denied')
    raw = private(envelope['material']['path']).read_bytes()
    need(sha(raw) == envelope['material']['sha256'], 'reviewed_manifest_changed')
    manifest = json.loads(raw)
    need(manifest['version'] == 1 and all(manifest[k] == envelope[k] for k in ('id', 'action', 'targetId')), 'manifest_operation_mismatch')
    need(manifest.get('requiresSudo') is False, 'human_on_device_sudo_stop_restore_required')
    targets = manifest['targets']
    need([target['role'] for target in targets] == ['owner', 'gateway', 'gateway', 'provider'], 'v1_target_order_required')
    need(len({target['key'] for target in targets}) == 4 and all(re.fullmatch('[a-z][a-z0-9-]{0,40}', target['key']) for target in targets), 'distinct_targets_required')
    need(all(target['kind'] in ('container', 'systemd', 'launchd') and re.fullmatch(r'[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+', target['host']) for target in targets), 'target_denied')
    need(not any(re.search(r'(^|[.@-])m1([.@-]|$)', target['host']) for target in targets), 'human_on_device_sudo_stop_restore_required')
    root = private(manifest['stateDirectory'], True)
    lock_file = (root / 'coordinator.lock').open('a')
    fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    need(root.name == envelope['id'], 'operation_directory_required')
    path = root / 'adapter-state.json'
    state = json.loads(private(path).read_bytes()) if path.exists() else {'id': envelope['id'], 'manifestHash': sha(raw), 'targets': {}}
    need(state['manifestHash'] == sha(raw) and state['id'] == envelope['id'], 'prepared_manifest_changed')
    context = envelope['context']
    state['phase'] = phase
    save(path, state)

    def source(name):
        data = private(HELPERS / name).read_bytes()
        need(sha(data) == manifest['sourceHashes'][name], 'reviewed_helper_changed')
        return data.decode()

    # Verify EVERY source before the first remote call, including files used only during restoration.
    for name in ('guards.py', 'docker_reader.py', 'docker_stopped.py', 'docker_action.py', 'systemd_reader.py', 'systemd_action.py', 'native_action.py'):
        source(name)

    def remote(target, program, payload=None, argv=None):
        # No credential-bearing environment/output is copied into a receipt. Source and payload are pinned operator data.
        bootstrap = ('import io,json,sys,os\nos.environ["PATH"]="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"\n'
                     + 'sys.argv=' + repr(argv or ['reviewed']) + '\n'
                     + 'sys.stdin=io.TextIOWrapper(io.BytesIO(' + repr(json.dumps(payload or {}).encode()) + '))\n'
                     + program)
        result = subprocess.run(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target['host'],
                                 '/usr/bin/python3 -I -'], input=bootstrap, capture_output=True, text=True, timeout=245)
        need(not result.stderr and len(result.stdout.encode()) <= 5 * 1048576, 'remote_outcome_unknown')
        value = json.loads(result.stdout)
        # native helper returns a structured known failure after successful bootout.
        need(result.returncode == 0 or target['kind'] == 'launchd' and value.get('state') == 'failed', 'remote_outcome_unknown')
        return value

    def linux_identity(target):
        value = target['expected']
        if target['kind'] == 'systemd':
            unit = value['unitProperties']
            proc = next(p for p in value['processes'] if p['pid'] == int(unit['MainPID']))
            started = datetime.datetime.strptime(unit['ExecMainStartTimestamp'], '%a %Y-%m-%d %H:%M:%S UTC').replace(tzinfo=datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            return {'host': target['identity']['host'], 'hostBootId': value['hostBootId'], 'kind': 'systemd', 'service': 'vllm.service',
                    'serviceRevision': value['unitConfigurationSha256'], 'incarnationId': unit['InvocationID'], 'startedAt': started,
                    'pid': proc['pid'], 'startTicks': str(proc['startTicks']), 'pidNamespace': re.search(r'\d+', proc['pidNamespace'])[0], 'cgroup': unit['ControlGroup']}
        container = value['containers'][0]
        inside = container['inside']
        proc = inside['pid1']
        started = datetime.datetime.fromisoformat(container['startedAt'].replace('Z', '+00:00')).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        return {'host': target['identity']['host'], 'hostBootId': value['hostBootId'], 'kind': 'container', 'service': value['serviceName'],
                'serviceRevision': str(value['serviceVersion']), 'incarnationId': container['id'], 'startedAt': started, 'pid': container['hostPid'],
                'startTicks': str(proc['startTicks']), 'pidNamespace': re.search(r'\d+', proc['pidNamespace'])[0],
                'cgroup': inside['cgroupNamespace'] + ':' + inside['cgroupRelativePath']}

    for target in targets:
        if target['kind'] != 'launchd':
            need(linux_identity(target) == target['identity'], 'canonical_identity_not_physical_snapshot')

    guards = {}
    exec(compile(source('guards.py'), '<reviewed-guards>', 'exec'), guards)

    def native(target, action, prior=None):
        payload = {'action': action, 'material': target['nativeMaterial'], 'materialSha256': sha(canon(target['nativeMaterial'])), 'expectedIdentity': target['identity']}
        if prior is not None:
            payload['restoring' if action == 'verify-restored' else 'stopped'] = prior
        return remote(target, source('native_action.py'), payload)

    def observe(target):
        if target['kind'] == 'launchd':
            value = native(target, 'inspect')
            need(value.get('state') == 'inspect_verified', 'native_prepare_unproven')
            return value
        name = 'docker_reader.py' if target['kind'] == 'container' else 'systemd_reader.py'
        value = remote(target, source(name), argv=['readonly', target['expected'].get('serviceName', 'vllm.service')])
        if target['kind'] == 'container':
            guards['check_docker_before'](target['expected'], value)
        else:
            need(value.get('operatorUid') == 0, 'human_on_device_sudo_stop_restore_required')
            need(all(value[k] == target['expected'][k] for k in ('hostBootId', 'unitFileSha256', 'unitConfigurationSha256', 'unitProperties', 'processes')), 'systemd_prepare_changed')
        return value

    def artifact(value):
        raw = canon(value) + b'\n'
        name = sha(raw)
        file = root / (name + '.json')
        if file.exists():
            need(private(file).read_bytes() == raw, 'artifact_conflict')
        else:
            save(file, value)
        return name

    def action(target, mode, prior=None):
        if target['kind'] == 'launchd':
            return native(target, {'stop': 'stop', 'verify-stopped': 'verify', 'restore': 'restore', 'read-restore-progress': 'verify-restored'}[mode], prior)
        payload = {'requestId': envelope['id'], 'expected': target['expected'], 'service': target['expected'].get('serviceName', 'vllm.service'),
                   'mode': mode, 'operationHash': state['manifestHash'], 'progressRoot': target['progressRoot']}
        reader = source('docker_reader.py' if target['kind'] == 'container' else 'systemd_reader.py')
        payload.update(reader=reader, readerSha256=sha(reader.encode()))
        if target['kind'] == 'container':
            stopped_reader = source('docker_stopped.py')
            payload.update(stoppedReader=stopped_reader, stoppedReaderSha256=sha(stopped_reader.encode()))
            payload.update(waitExitCode=(prior or {}).get('waitExitCode'), stoppedServiceVersion=(prior or {}).get('serviceVersion'))
        program = (source('guards.py') + '\n' if target['kind'] == 'container' else '') + source('docker_action.py' if target['kind'] == 'container' else 'systemd_action.py')
        return remote(target, program, payload)

    def verify(target):
        item = state['targets'].get(target['key'], {})
        need(item.get('stopAttempted'), 'target_not_stopped')
        if target['kind'] == 'launchd':
            need(item.get('stopped'), 'native_stop_ack_missing_human_readback_required')
            value = action(target, 'verify-stopped', item['stopped'])
            need(value.get('state') == 'verify_stop_verified', 'native_exit_unproven')
        else:
            # Read durable ack even after an SSH timeout. Never send a second stop.
            value = action(target, 'read-stop-progress')
            need(value.get('verified') is True, 'physical_exit_unproven')
        item['stopped'] = value
        save(path, state)
        return value

    if phase == 'prepare':
        need(not state['targets'], 'prepare_already_started')
        observed = [observe(target) for target in targets]
        if context.get('request'):
            owner = context['request']['owner']
            need(any(proc.get('owner') == owner for proc in observed[0]['containers'][0]['inside']['processes']), 'request_owner_incarnation_changed')
        state['beforeArtifactHash'] = artifact({'at': stamp(), 'context': context, 'observed': observed})
        state['configurationHash'] = configuration(targets)
        save(path, state)
        return {'ok': True, 'configurationHash': state['configurationHash']}

    need(state.get('configurationHash') and context.get('drained', {}).get('mode') == 'draining', 'prepare_and_drain_required')
    if phase == 'plan':
        need(envelope['action'] == 'request-release' and not state['targets'], 'plan_before_mutation_required')
        if not state.get('plan'):
            state['plan'] = {'version': 1, 'kind': 'provider_boundary_plan', 'createdAt': stamp(), 'request': context['request'], 'control': context['drained'],
                             'owner': targets[0]['identity'], 'gateways': [target['identity'] for target in targets[1:3]],
                             'provider': targets[3]['identity'], 'beforeArtifactHash': state['beforeArtifactHash']}
            save(path, state)
        return {'ok': True, 'plan': state['plan']}

    if phase in ('stop', 'resume-stop'):
        need(envelope['action'] == 'model-restart' or state.get('plan'), 'reviewed_plan_required')
        for index, target in enumerate(targets):
            for previous in targets[:index]:
                verify(previous)
            item = state['targets'].setdefault(target['key'], {})
            if item.get('stopAttempted'):
                verify(target)
                continue
            observe(target)  # Original identity/source/idle CAS immediately before first mutation.
            item['stopAttempted'] = True
            save(path, state)
            value = action(target, 'stop')
            item['stopped'] = value
            save(path, state)
            if target['kind'] == 'launchd' and value.get('state') != 'stop_verified':
                return {'ok': False, 'code': value.get('errorCode') if value.get('stage') == 'verify-stop' else 'native_stop_unproven'}
            need(value.get('verified') is True or value.get('state') == 'stop_verified', 'stop_unproven')
        return {'ok': True}

    if phase in ('verify-stop', 'refresh-evidence'):
        if phase == 'refresh-evidence':
            need(envelope['action'] == 'request-release', 'release_only_evidence_refresh')
            for target in targets:
                verify(target)
            state['plan']['createdAt'] = stamp()
            save(path, state)
        proofs = []
        for target in targets:
            value = verify(target)
            record = {'at': stamp(), 'identity': target['identity'], 'readback': value}
            proof = {'identity': target['identity'], 'observedAt': record['at'], 'mainPid': 0, 'oldPidAbsent': True, 'serviceStopped': True, 'replacements': 0,
                     'autoRestartBlocked': True, 'artifactHash': artifact(record)}
            if target['kind'] == 'launchd':
                proof.update(method='launchd_process_group_empty', observedHostBootId=target['identity']['hostBootId'], launchdDisabled=True,
                             launchdUnloaded=True, oldPidESRCH=True, processGroupESRCH=True, allKnownDescendantsESRCH=True, replacementPids=[], ownedListeners=[])
            elif target['kind'] == 'systemd':
                proof.update(method='systemd_and_cgroup_empty', cgroupPopulated=False, cgroupPids=[])
            else:
                proof.update(method='private_pid_namespace_end', pidMode=value['pidMode'], initPid=1, initNamespace=target['identity']['pidNamespace'],
                             selfNamespace=target['identity']['pidNamespace'], waitExitCode=value['waitExitCode'], containerStatus=value['status'], running=False)
            proofs.append(proof)
        if envelope['action'] == 'model-restart':
            return {'ok': True, 'exits': proofs}
        # JS canonical hashing uses recursively sorted JSON with UTF-8; all identity/request fields are ASCII.
        plan = state['plan']
        receipt = {'version': 1, 'kind': 'provider_boundary_receipt', 'planHash': sha(canon(plan)), 'owner': proofs[0], 'gateways': proofs[1:3], 'provider': proofs[3]}
        plan_path, receipt_path = root / 'plan.json', root / 'receipt.json'
        plan_sha = save(plan_path, plan)
        save(receipt_path, receipt)
        return {'ok': True, 'plan': plan, 'receipt': receipt, 'releaseFiles': {'plan': str(plan_path), 'planSha': plan_sha, 'receipt': str(receipt_path)}}

    if phase in ('restore', 'resume-restore', 'verify-restored'):
        for target in reversed(targets):
            item = state['targets'].get(target['key'], {})
            need(item.get('stopped'), 'stop_ack_required_before_restore')
            if phase in ('restore', 'resume-restore') and not item.get('restoreAttempted'):
                # All remaining boundaries stay stopped until their turn; no blind enable/start.
                verify(target)
                item['restoreAttempted'] = True
                save(path, state)
                value = action(target, 'restore', item['stopped'])
                item['restoring'] = value
                save(path, state)
            need(item.get('restoreAttempted'), 'restore_not_started')
            value = action(target, 'read-restore-progress', item.get('restoring') if target['kind'] == 'launchd' else item['stopped'])
            need(value.get('verified') is True or value.get('state') == 'restore_verified', 'restore_unproven')
            item['restored'] = value
            save(path, state)
        # Helpers above re-read exact original spec, source hashes, boot and new healthy incarnation.
        return {'ok': True, 'configurationHash': configuration(targets)}
    raise ValueError('phase_denied')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(5 * 1048576 + 1)
        need(len(raw) <= 5 * 1048576 and len(sys.argv) == 2, 'bounded_envelope_required')
        result = main(sys.argv[1], json.loads(raw))
    except BoundaryError as error:
        code = str(error)
        result = {'ok': False, 'code': code, 'manual': code == 'human_on_device_sudo_stop_restore_required'}
    except Exception:
        result = {'ok': False, 'code': 'boundary_phase_unproven_check_private_journal'}
    print(json.dumps(result))
    sys.exit(0 if result['ok'] else 1)
