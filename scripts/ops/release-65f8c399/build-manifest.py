"""Supa 65f8c399 ops-runner manifest/profile builder. Local files only: no SSH, DB, systemd or device access.
Inputs are the verbatim outputs of the reviewed read helpers (docker_reader.py x3, systemd_reader.py on supa), captured just before prepare.
Identity is recomputed exactly like admin-models-boundary-adapter.py linux_identity(); prepare re-checks it and refuses any mismatch.
  python3 -I build-manifest.py --job=<OPS_JOB_UUID> --out-dir=/abs/<OPS_JOB_UUID> --adapter=/abs/scripts/ops/admin-models-boundary-adapter.py \
    --affected-group=<request group_id> --container-progress-root=/abs/remote/private/dir \
    --owner=jr@m3Ultra:/abs/owner.json --gateway-m3=jr@m3Ultra:/abs/gw-m3.json --gateway-mini=<user@host>:/abs/gw-mini.json --provider=jr@supa:/abs/supa.json
"""
import datetime, hashlib, json, os, pathlib, re, sys

REQUEST_ID = '65f8c399-ff4b-47bc-8f4d-6e4a682cf6a7'
HELPERS = ('guards.py', 'docker_reader.py', 'docker_stopped.py', 'docker_action.py', 'systemd_reader.py', 'systemd_action.py', 'native_action.py', 'systemd_handoff.py')
ROOT_PROGRESS = '/var/lib/nmv-admin-models-root/progress'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')


def fail(code):
    sys.stderr.write(json.dumps({'error': code}) + '\n')
    sys.exit(2)


def linux_identity(target):
    # Verbatim body of admin-models-boundary-adapter.py linux_identity (kept in parity by tests/test_release_65f8c399_manifest.py).
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


def sha(data):
    return hashlib.sha256(data).hexdigest()


def build(job, out_dir, adapter, group, container_progress, inputs):
    """inputs: role -> (ssh host, reader JSON). Returns (manifest bytes, profile bytes, warnings)."""
    if not UUID.match(job) or pathlib.Path(out_dir).name != job or not os.path.isabs(out_dir): fail('job_uuid_and_out_dir_named_by_job_required')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,119}', group): fail('affected_group_invalid')
    if not os.path.isabs(container_progress) or '..' in pathlib.Path(container_progress).parts: fail('container_progress_root_absolute_required')
    helpers = pathlib.Path(adapter).parent / 'admin_models_helpers'
    targets, warnings = [], []
    for key, role, kind in (('owner', 'owner', 'container'), ('gateway-m3', 'gateway', 'container'), ('gateway-mini', 'gateway', 'container'), ('provider', 'provider', 'systemd')):
        host, expected = inputs[key]
        if not re.fullmatch(r'[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+', host): fail('ssh_host_user_at_host_required:' + key)
        target = {'key': key, 'role': role, 'kind': kind, 'host': host, 'identity': {'host': host.split('@', 1)[1] if kind == 'container' else 'supa'},
                  'expected': expected, 'progressRoot': ROOT_PROGRESS if kind == 'systemd' else container_progress}
        if kind == 'systemd':
            target['rootHandoff'] = True
            if expected.get('unit') != 'vllm.service': fail('provider_reader_not_vllm')
        else:
            if len(expected.get('containers', [])) != 1: fail('single_current_container_required:' + key)
        target['identity'] = linux_identity(target)
        targets.append(target)
    owner_procs = targets[0]['expected']['containers'][0]['inside'].get('processes', [])
    manifest = {'version': 1, 'id': job, 'action': 'request-release', 'targetId': REQUEST_ID, 'requiresSudo': False, 'stateDirectory': out_dir,
                'targets': targets, 'sourceHashes': {name: sha((helpers / name).read_bytes()) for name in HELPERS}}
    raw = (json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    profile = {'version': 1, 'jobId': job, 'action': 'request-release', 'targetId': REQUEST_ID, 'requiresSudo': False, 'affectedGroups': [group],
               'adapter': {'path': adapter, 'sha256': sha(pathlib.Path(adapter).read_bytes())},
               'material': {'path': str(pathlib.Path(out_dir) / 'manifest.json'), 'sha256': sha(raw)}, 'artifactDirectory': out_dir}
    if not any(p.get('owner', {}).get('instanceId') for p in owner_procs): warnings.append('owner_reader_shows_no_role_lease_owner_check_request_owner')
    return raw, (json.dumps(profile, separators=(',', ':')) + '\n').encode(), warnings


def main(argv):
    opts = {}
    for arg in argv:
        m = re.fullmatch(r'--([a-z0-9-]+)=(.+)', arg)
        if not m or m.group(1) in opts: fail('option:' + arg.split('=')[0])
        opts[m.group(1)] = m.group(2)
    need = ('job', 'out-dir', 'adapter', 'affected-group', 'container-progress-root', 'owner', 'gateway-m3', 'gateway-mini', 'provider')
    if set(opts) != set(need): fail('required:' + ','.join(sorted(set(need) - set(opts))))
    inputs = {}
    for key in ('owner', 'gateway-m3', 'gateway-mini', 'provider'):
        host, _, path = opts[key].partition(':')
        if not os.path.isabs(path): fail('reader_output_absolute_path_required:' + key)
        inputs[key] = (host, json.loads(pathlib.Path(path).read_bytes()))
    out = opts['out-dir']
    raw, profile, warnings = build(opts['job'], out, opts['adapter'], opts['affected-group'], opts['container-progress-root'], inputs)
    os.mkdir(out, 0o700)  # new once-directory; an existing one is never reused
    for name, data in (('manifest.json', raw), ('profile.json', profile)):
        fd = os.open(os.path.join(out, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as handle: handle.write(data)
    print(json.dumps({'manifest': os.path.join(out, 'manifest.json'), 'manifestSha256': sha(raw), 'profile': os.path.join(out, 'profile.json'),
                      'profileSha256': sha(profile), 'warnings': warnings}))


if __name__ == '__main__':
    main(sys.argv[1:])
