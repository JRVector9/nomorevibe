"""Read-only hop readback for replaced-path release. Runs ON the target host: no stop, restart, model call or secret read.

stdin/payload: {"role", "host", "kind", "service"} plus optional "idle" probe and "allowAbsent".
stdout: {"hop": {...}, "artifact": "<canonical json>"} or {"error": code}, exit 1.
startedAt is the OLDEST process of the service, floored (container to ms, others to the second), so a pre-dispatch survivor can never look newer.
An absent service (allowed hops only) reports startedAt null; an idle probe reports whether the engine had zero running and waiting requests.
"""
import datetime
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

os.environ['PATH'] = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'


class HopError(Exception):
    pass


class Absent(Exception):
    def __init__(self, facts):
        super().__init__('absent')
        self.facts = facts


def need(ok, code):
    if not ok:
        raise HopError(code)


def run(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    need(result.returncode == 0, 'command_failed:' + os.path.basename(args[0]))
    return result.stdout


def iso(epoch_ms):
    return datetime.datetime.fromtimestamp(epoch_ms / 1000, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def now_ms():
    return int(time.time() * 1000)


def mac_tree(root):
    """pid/ppid/start(second) of root and every descendant, from one ps snapshot. lstart is local time."""
    rows = {}
    # -ww: the full, untruncated command line. Interpreted services (node, python) share an executable name.
    for line in run(['/bin/ps', '-axww', '-o', 'pid=,ppid=,lstart=,command=']).splitlines():
        m = re.match(r'\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$', line)
        if m:
            rows[int(m[1])] = {'ppid': int(m[2]), 'start': int(time.mktime(time.strptime(m[3], '%a %b %d %H:%M:%S %Y'))), 'command': m[4].strip()}
    need(root in rows, 'process_missing')
    tree, frontier = {root}, [root]
    while frontier:
        parent = frontier.pop()
        for pid, row in rows.items():
            if row['ppid'] == parent and pid not in tree:
                tree.add(pid)
                frontier.append(pid)
    return rows, tree


def mac_process_hop(pid, extra):
    rows, tree = mac_tree(pid)
    command = rows[pid]['command']
    # An older copy of the same service (identical full command line) outside this job could still hold an old call.
    others = sorted(p for p, row in rows.items() if row['command'] == command and p not in tree)
    need(not others, 'second_instance_present')
    oldest = min(rows[p]['start'] for p in tree)
    # Only the program name and a hash leave the host: arguments may carry paths or tokens.
    facts = {'pid': pid, 'command': os.path.basename(command.split(' ', 1)[0]), 'commandSha256': hashlib.sha256(command.encode()).hexdigest(),
             'processes': len(tree), 'oldestStartEpoch': oldest, **extra}
    return 'pid:%d:%d' % (pid, rows[pid]['start']), oldest * 1000, facts


def container(service):
    running = run(['docker', 'ps', '-q', '--no-trunc', '--filter', 'label=com.docker.swarm.service.name=' + service]).split()
    tasks = [json.loads(line) for line in run(['docker', 'service', 'ps', service, '--no-trunc', '--format', '{{json .}}']).splitlines() if line.strip()]
    live = [t for t in tasks if t.get('DesiredState') == 'Running' or str(t.get('CurrentState', '')).startswith('Running')]
    if not running and not live:
        raise Absent({'runningContainers': 0, 'runningTasks': 0})
    need(len(running) == 1, 'container_count_%d' % len(running))
    need(len(live) == 1, 'running_task_count_%d' % len(live))
    state = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', running[0]]))
    need(state.get('Running') is True and state.get('Pid', 0) > 0, 'container_not_running')
    m = re.match(r'^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$', state['StartedAt'])
    need(m, 'container_started_at_shape')
    base = datetime.datetime.strptime(m[1], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=datetime.timezone.utc)
    started = int(base.timestamp()) * 1000 + int(((m[2] or '0') + '000')[:3])
    # Every process inside the private PID namespace descends from its init, so init's start is the oldest.
    return running[0], started, {'containerId': running[0], 'startedAtRaw': state['StartedAt'], 'runningTasks': len(live),
                                 'taskIds': [t.get('ID') for t in live], 'runningContainers': 1}


def systemd(service):
    props = dict(line.split('=', 1) for line in run(['systemctl', 'show', service, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID',
                                                     '-p', 'InvocationID', '-p', 'ControlGroup']).splitlines() if '=' in line)
    need(props.get('ActiveState') == 'active' and props.get('InvocationID') and int(props.get('MainPID', '0')) > 0, 'unit_not_active')
    with open('/sys/fs/cgroup' + props['ControlGroup'] + '/cgroup.procs') as f:
        pids = [int(x) for x in f.read().split()]
    need(int(props['MainPID']) in pids, 'main_pid_outside_cgroup')
    with open('/proc/stat') as f:
        btime = int(next(line.split()[1] for line in f if line.startswith('btime ')))
    ticks = os.sysconf('SC_CLK_TCK')
    starts = []
    for pid in pids:
        with open('/proc/%d/stat' % pid) as f:
            starts.append(btime + int(f.read().rsplit(')', 1)[1].split()[19]) // ticks)
    oldest = min(starts)
    return props['InvocationID'], oldest * 1000, {'invocationId': props['InvocationID'], 'mainPid': int(props['MainPID']),
                                                  'processes': len(pids), 'oldestStartEpoch': oldest, 'subState': props.get('SubState')}


def launchd(service):
    result = subprocess.run(['/bin/launchctl', 'print', service], capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise Absent({'launchctlExit': result.returncode})
    pid = re.search(r'^\s*pid = (\d+)$', result.stdout, re.M)
    if not pid:
        raise Absent({'loaded': True, 'pid': None})
    need(re.search(r'^\s*state = running$', result.stdout, re.M), 'launchd_not_running')
    return mac_process_hop(int(pid[1]), {'service': service})


def listener(service):
    m = re.fullmatch(r'tcp:(127\.0\.0\.1|0\.0\.0\.0):(\d+)', service)
    need(m, 'listener_service_shape')
    out = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-iTCP@%s:%s' % (m[1], m[2]), '-sTCP:LISTEN', '-Fp'], capture_output=True, text=True, timeout=30).stdout
    pids = sorted({int(line[1:]) for line in out.splitlines() if line.startswith('p')})
    if not pids:
        raise Absent({'listeners': 0})
    need(len(pids) == 1, 'listener_count_%d' % len(pids))
    return mac_process_hop(pids[0], {'listener': service})


def get_json(url, token=None, raw=False):
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token} if token else {})
    with urllib.request.urlopen(request, timeout=5) as response:
        body = response.read(1048577)
    need(len(body) <= 1048576, 'probe_read_cap')
    return body.decode() if raw else json.loads(body)


def idle_counts(probe):
    """Zero running and zero waiting requests in the engine itself. Only counters leave the host, never the token."""
    if probe.get('type') == 'vllm-metrics':
        text = get_json('http://127.0.0.1:%d/metrics' % int(probe['port']), raw=True)
        total = {'running': 0.0, 'waiting': 0.0}
        for line in text.splitlines():
            m = re.match(r'^vllm:num_requests_(running|waiting)(?:\{[^}]*\})?\s+([0-9.eE+-]+)$', line)
            if m:
                total[m[1]] += float(m[2])
        return {'type': 'vllm-metrics', 'running': total['running'], 'waiting': total['waiting']}
    need(probe.get('type') == 'omlx-status', 'idle_probe_denied')
    with open(probe['settings']) as f:
        settings = json.load(f)
    status = get_json('http://127.0.0.1:%d/api/status' % int(settings['server']['port']), settings['auth']['api_key'])
    need(isinstance(status.get('active_requests'), int) and isinstance(status.get('waiting_requests'), int), 'omlx_status_shape')
    return {'type': 'omlx-status', 'running': status['active_requests'], 'waiting': status['waiting_requests']}


def collect(request):
    need(set(request) <= {'role', 'host', 'kind', 'service', 'idle', 'allowAbsent'} and {'role', 'host', 'kind', 'service'} <= set(request), 'request_shape')
    kind, service = request['kind'], request['service']
    need(kind in ('container', 'systemd', 'launchd', 'listener') and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}', service), 'request_denied')
    hop_request = {k: request[k] for k in ('role', 'host', 'kind', 'service')}
    try:
        incarnation, started, facts = {'container': container, 'systemd': systemd, 'launchd': launchd, 'listener': listener}[kind](service)
    except Absent as absent:
        need(request.get('allowAbsent') is True, 'service_absent')
        incarnation, started, facts = 'absent', None, {'absent': absent.facts}
    idle = None
    if request.get('idle') and started is not None:
        counts = idle_counts(request['idle'])
        facts = {**facts, 'idle': counts}
        idle = counts['running'] == 0 and counts['waiting'] == 0
    observed = now_ms()
    need(started is None or started <= observed, 'started_after_observation')
    artifact = {'version': 1, 'kind': 'replaced_path_hop_readback', 'request': hop_request, 'hostname': socket.gethostname(),
                'observedAt': iso(observed), 'startedAt': None if started is None else iso(started), 'incarnationId': incarnation, 'facts': facts}
    raw = json.dumps(artifact, sort_keys=True, separators=(',', ':'))
    hop = {**hop_request, 'incarnationId': incarnation, 'startedAt': None if started is None else iso(started), 'observedAt': iso(observed),
           'singleInstance': True, 'idle': idle, 'artifactHash': hashlib.sha256(raw.encode()).hexdigest()}
    return {'hop': hop, 'artifact': raw}


if __name__ == '__main__':
    try:
        payload = json.loads(sys.stdin.read(65536))
        print(json.dumps(collect(payload), sort_keys=True))
    except HopError as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - only the type leaves the host
        print(json.dumps({'error': type(error).__name__}))
        sys.exit(1)
