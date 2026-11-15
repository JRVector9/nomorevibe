#!/usr/bin/env python3
"""DB host disk alert — Oracle onetwoday oneshot timer (2026-11-15 owner-approved).

On 2026-11-15 the shared Postgres volume filled twice (03:10Z PANIC, 07:09Z three-hour outage) with no alert.
Every minute this reads node_exporter (Tailscale, plain HTTP — node_exporter has no TLS there) on each DB host,
computes df-style use% for the configured mounts, and sends Telegram through the watchdog's existing incident
destination:
  - once when a mount reaches alertPercent, again every repeatSeconds while it stays at or above clearPercent,
  - once when it falls below clearPercent (hysteresis — no flapping between clear and alert),
  - once when a host has been unreadable for unreadableSeconds, and once when it is readable again.
A failed send is not recorded, so the next run retries. No URL, token or response body enters logs or state.
It never touches the watchdog's own state, Kuma pushes or recovery decisions.
"""
import argparse
import fcntl
import json
import math
import os
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from incident_notifications import send_telegram, validate_destination  # noqa: E402

HEADER_ALERT = 'NoMoreVibe 장애 알림'
HEADER_CLEAR = 'NoMoreVibe 알림 해제'
METRICS_LIMIT = 8 * 1024 * 1024
URL_PATTERN = re.compile(r'http://(?:100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}):9100/metrics')
HOST_PATTERN = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,39}')
MOUNT_PATTERN = re.compile(r'/[A-Za-z0-9._/-]{0,63}')
SAMPLE = re.compile(r'^node_filesystem_(size|free|avail)_bytes\{([^}]*)\}\s+([0-9.eE+-]+)$')
LABEL = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')


def read_config(path):
    config = json.loads(Path(path).read_text())
    hosts, mounts = config.get('hosts'), config.get('mounts')
    if (not isinstance(hosts, dict) or not 1 <= len(hosts) <= 8 or
            not all(isinstance(k, str) and HOST_PATTERN.fullmatch(k) and isinstance(v, str) and URL_PATTERN.fullmatch(v)
                    for k, v in hosts.items())):
        raise ValueError('db_disk_hosts_invalid')
    if (not isinstance(mounts, list) or not 1 <= len(mounts) <= 8 or
            not all(isinstance(m, str) and MOUNT_PATTERN.fullmatch(m) for m in mounts)):
        raise ValueError('db_disk_mounts_invalid')
    numbers = {'alertPercent': (50, 99), 'clearPercent': (40, 98), 'repeatSeconds': (600, 7 * 86400),
               'unreadableSeconds': (120, 86400)}
    for key, (low, high) in numbers.items():
        value = config.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError('db_disk_' + key + '_invalid')
    if not config['clearPercent'] < config['alertPercent']:
        raise ValueError('db_disk_hysteresis_invalid')
    for key in ('destinationFrom', 'state'):
        if not isinstance(config.get(key), str) or not config[key].startswith('/'):
            raise ValueError('db_disk_' + key + '_invalid')
    return config


def read_destination(path):
    return validate_destination(json.loads(Path(path).read_text()).get('incidentNotifications'))


def fetch_metrics(url, *, timeout=5):
    """Return the metrics text or None. No redirects are followed and nothing about the failure is kept."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        opener = urllib.request.build_opener(NoRedirect, urllib.request.ProxyHandler({}))
        with opener.open(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            body = response.read(METRICS_LIMIT + 1)
            return None if len(body) > METRICS_LIMIT else body.decode('utf-8', 'replace')
    except Exception:
        return None


def mount_usage(text, mounts):
    """df-style use% per mount: (size − free) / (size − free + avail). Missing or nonsensical samples are left out."""
    seen = {}
    for line in text.splitlines():
        match = SAMPLE.match(line.strip())
        if not match:
            continue
        labels = dict(LABEL.findall(match.group(2)))
        mount = labels.get('mountpoint')
        if mount not in mounts:
            continue
        try:
            value = float(match.group(3))
        except ValueError:
            continue
        if math.isfinite(value) and value >= 0:
            seen.setdefault(mount, {})[match.group(1)] = value
    usage = {}
    for mount, values in seen.items():
        size, free, avail = values.get('size'), values.get('free'), values.get('avail')
        if size is None or free is None or avail is None or size <= 0 or free > size:
            continue
        used = size - free
        if used + avail <= 0:
            continue
        usage[mount] = {'percent': round(100 * used / (used + avail), 1), 'availGb': round(avail / 1e9, 1),
                        'sizeGb': round(size / 1e9, 1)}
    return usage


def evaluate(config, state, readings, now):
    """Pure transition: returns (messages, next_state). readings: host → {mount → usage} or None (unreadable)."""
    alert, clear = config['alertPercent'], config['clearPercent']
    messages = []
    nxt = {'mounts': dict(state.get('mounts', {})), 'hosts': dict(state.get('hosts', {}))}
    for host in config['hosts']:
        usage = readings.get(host)
        missing = usage is None or any(m not in usage for m in config['mounts'])
        hstate = dict(nxt['hosts'].get(host, {}))
        if missing:
            since = hstate.get('unreadableSince')
            since = since if type(since) in (int, float) and 0 <= since <= now else now
            hstate['unreadableSince'] = since
            if not hstate.get('unreadableSent') and now - since >= config['unreadableSeconds']:
                messages.append({'key': ('host', host), 'kind': 'alert',
                                 'line': f'DB 디스크 확인 불가 — {host} 의 node_exporter 를 {round((now - since) / 60)}분째 읽지 못함 '
                                         '(서버·Tailscale·node_exporter 확인 필요)'})
            nxt['hosts'][host] = hstate
        else:
            # unreadableSent stays until the "readable again" line is actually delivered (commit drops it)
            if hstate.get('unreadableSent'):
                messages.append({'key': ('host', host), 'kind': 'clear', 'line': f'DB 디스크 다시 읽힘 — {host}'})
            nxt['hosts'][host] = {'unreadableSent': True} if hstate.get('unreadableSent') else {}
        for mount in config['mounts']:
            key = host + ':' + mount
            mstate = dict(nxt['mounts'].get(key, {}))
            row = (usage or {}).get(mount)
            if row is None:
                continue  # unreadable: keep the previous high/low state, do not clear on missing data
            percent = row['percent']
            detail = f'{host} {mount} 사용 {percent}% (여유 {row["availGb"]}GB / {row["sizeGb"]}GB)'
            last = mstate.get('lastSent')
            last = last if type(last) in (int, float) and 0 <= last <= now else None
            if mstate.get('high'):
                if percent < clear:
                    messages.append({'key': ('mount', key), 'kind': 'clear', 'line': f'DB 디스크 {clear}% 아래로 — {detail}'})
                elif last is None or now - last >= config['repeatSeconds']:
                    messages.append({'key': ('mount', key), 'kind': 'repeat',
                                     'line': f'DB 디스크 계속 높음 — {detail} · 공간 정리 또는 증설 필요'})
            elif percent >= alert:
                messages.append({'key': ('mount', key), 'kind': 'alert',
                                 'line': f'DB 디스크 {alert}% 넘음 — {detail} · 공간 정리 또는 증설 필요'})
            mstate['percent'] = percent
            nxt['mounts'][key] = mstate
    return messages, nxt


def commit(next_state, messages, now):
    """Record only the messages that were actually delivered."""
    for message in messages:
        kind, key = message['kind'], message['key']
        if key[0] == 'host':
            hstate = next_state['hosts'].setdefault(key[1], {})
            if kind == 'alert':
                hstate['unreadableSent'] = True
            elif kind == 'clear':
                hstate.pop('unreadableSent', None)
        else:
            mstate = next_state['mounts'].setdefault(key[1], {})
            if kind in ('alert', 'repeat'):
                mstate['high'], mstate['lastSent'] = True, now
            elif kind == 'clear':
                mstate['high'] = False
                mstate.pop('lastSent', None)
    return next_state


def render(messages):
    alerts = [m['line'] for m in messages if m['kind'] in ('alert', 'repeat')]
    clears = [m['line'] for m in messages if m['kind'] == 'clear']
    parts = []
    if alerts:
        parts.append(HEADER_ALERT + '\n' + '\n'.join('· ' + line for line in alerts))
    if clears:
        parts.append(HEADER_CLEAR + '\n' + '\n'.join('· ' + line for line in clears))
    return '\n\n'.join(parts)[:4000]


def run(config, *, now=None, fetch=fetch_metrics, send=send_telegram, destination=None):
    now = time.time() if now is None else now
    path = Path(config['state'])
    try:
        state = json.loads(path.read_text())
        state = state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        state = {}
    readings = {}
    for host, url in config['hosts'].items():
        text = fetch(url)
        readings[host] = mount_usage(text, set(config['mounts'])) if text is not None else None
    messages, next_state = evaluate(config, state, readings, now)
    delivered = False
    if messages:
        delivered = send(destination if destination is not None else read_destination(config['destinationFrom']), render(messages))
        if delivered:
            next_state = commit(next_state, messages, now)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(next_state, sort_keys=True))
    os.replace(tmp, path)
    summary = {h: ({m: r['percent'] for m, r in (readings[h] or {}).items()} if readings[h] is not None else 'unreadable')
               for h in config['hosts']}
    return {'event': 'db_disk_alert', 'at': round(now), 'usage': summary, 'messages': len(messages), 'delivered': delivered}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = read_config(args.config)
    Path(config['state']).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(config['state'] + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(run(config), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
