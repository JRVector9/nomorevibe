import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / 'scripts/ops/db_disk_alert.py'
sys.path.insert(0, str(PATH.parent))
spec = importlib.util.spec_from_file_location('db_disk_alert', PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

GB = 1_000_000_000


def metrics(mounts):
    """mounts: mount → (size, free, avail) in GB"""
    lines = ['# HELP node_filesystem_avail_bytes x', 'node_cpu_seconds_total{cpu="0",mode="idle"} 1']
    for mount, (size, free, avail) in mounts.items():
        labels = f'device="/dev/x",device_error="",fstype="xfs",mountpoint="{mount}"'
        lines += [f'node_filesystem_size_bytes{{{labels}}} {size * GB:e}', f'node_filesystem_free_bytes{{{labels}}} {free * GB:e}',
                  f'node_filesystem_avail_bytes{{{labels}}} {avail * GB:e}']
    return '\n'.join(lines) + '\n'


def base_config(tmp):
    return {'hosts': {'V9-Primary': 'http://100.64.0.11:9100/metrics', 'V9-Replica': 'http://100.64.0.12:9100/metrics'},
            'mounts': ['/', '/data/postgres'], 'alertPercent': 80, 'clearPercent': 75, 'repeatSeconds': 21600,
            'unreadableSeconds': 600, 'destinationFrom': '/etc/nomorevibe-watchdog/config.json', 'state': str(Path(tmp) / 'state.json')}


class Harness:
    def __init__(self, tmp):
        self.config = base_config(tmp)
        self.pages = {}
        self.sent = []
        self.accept = True

    def set(self, host, mounts):
        self.pages[self.config['hosts'][host]] = metrics(mounts) if mounts is not None else None

    def run(self, now):
        def send(destination, text):
            self.sent.append(text)
            return self.accept
        return mod.run(self.config, now=now, fetch=lambda url: self.pages.get(url), send=send,
                       destination={'botToken': '123456:' + 'a' * 30, 'chatId': '-100123'})


OK = {'/': (98, 40, 35), '/data/postgres': (70, 40, 40)}           # / 62.4% · data 42.9%
HIGH = {'/': (98, 40, 35), '/data/postgres': (70, 10, 10)}          # data 86%
MID = {'/': (98, 40, 35), '/data/postgres': (70, 16, 16)}           # data ~77%
LOW = OK


class DbDiskAlertTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.h = Harness(self.tmp.name)
        self.h.set('V9-Replica', OK)

    def tearDown(self):
        self.tmp.cleanup()

    def test_df_style_percent(self):
        usage = mod.mount_usage(metrics({'/data/postgres': (70, 40, 40), '/other': (10, 1, 1)}), {'/data/postgres', '/'})
        self.assertEqual(usage, {'/data/postgres': {'percent': 42.9, 'availGb': 40.0, 'sizeGb': 70.0}})
        # reserved blocks (avail < free) count like df: used / (used + avail)
        usage = mod.mount_usage(metrics({'/': (98, 17, 12)}), {'/'})
        self.assertEqual(usage['/']['percent'], round(100 * 81 / 93, 1))

    def test_quiet_when_below_threshold(self):
        self.h.set('V9-Primary', OK)
        result = self.h.run(1000)
        self.assertEqual((result['messages'], self.h.sent), (0, []))
        self.assertEqual(result['usage']['V9-Primary'], {'/': 62.4, '/data/postgres': 42.9})

    def test_alert_once_repeat_after_interval_then_clear_with_hysteresis(self):
        self.h.set('V9-Primary', HIGH)
        self.h.run(1000)
        self.assertEqual(len(self.h.sent), 1)
        self.assertIn('NoMoreVibe 장애 알림', self.h.sent[0])
        self.assertIn('V9-Primary /data/postgres 사용 85.7%', self.h.sent[0])
        self.h.run(1060)
        self.h.set('V9-Primary', MID)  # between clear and alert: still high, no message
        self.h.run(1120)
        self.assertEqual(len(self.h.sent), 1)
        self.h.run(1000 + 21600)
        self.assertEqual(len(self.h.sent), 2)
        self.assertIn('계속 높음', self.h.sent[1])
        self.h.set('V9-Primary', LOW)
        self.h.run(1000 + 21660)
        self.assertEqual(len(self.h.sent), 3)
        self.assertIn('NoMoreVibe 알림 해제', self.h.sent[2])
        self.h.run(1000 + 21720)
        self.assertEqual(len(self.h.sent), 3)
        self.h.set('V9-Primary', MID)  # rising back to MID after a clear is not an alert
        self.h.run(1000 + 21780)
        self.assertEqual(len(self.h.sent), 3)

    def test_failed_send_is_retried_next_run(self):
        self.h.set('V9-Primary', HIGH)
        self.h.accept = False
        self.assertFalse(self.h.run(1000)['delivered'])
        self.h.accept = True
        self.assertTrue(self.h.run(1060)['delivered'])
        self.assertEqual(len(self.h.sent), 2)
        self.h.run(1120)
        self.assertEqual(len(self.h.sent), 2)

    def test_unreadable_host_alerts_once_after_grace_and_clears(self):
        self.h.set('V9-Primary', None)
        for now in (1000, 1300, 1599):
            self.h.run(now)
        self.assertEqual(self.h.sent, [])
        self.h.run(1600)
        self.assertEqual(len(self.h.sent), 1)
        self.assertIn('V9-Primary 의 node_exporter 를 10분째 읽지 못함', self.h.sent[0])
        self.h.run(1660)
        self.assertEqual(len(self.h.sent), 1)
        self.h.set('V9-Primary', OK)
        self.h.accept = False
        self.h.run(1720)
        self.h.accept = True
        self.h.run(1780)
        self.assertEqual(len(self.h.sent), 3)
        self.assertIn('DB 디스크 다시 읽힘 — V9-Primary', self.h.sent[2])
        self.h.run(1840)
        self.assertEqual(len(self.h.sent), 3)

    def test_unreadable_does_not_clear_a_high_mount(self):
        self.h.set('V9-Primary', HIGH)
        self.h.run(1000)
        self.h.set('V9-Primary', None)
        self.h.run(1060)
        self.h.set('V9-Primary', HIGH)
        self.h.run(1120)
        self.assertEqual(len(self.h.sent), 1)

    def test_message_and_state_hold_no_url_or_token(self):
        self.h.set('V9-Primary', HIGH)
        self.h.run(1000)
        state = Path(self.h.config['state']).read_text()
        for text in (self.h.sent[0], state):
            self.assertNotIn('100.64.0.11', text)
            self.assertNotIn('aaaaaaaaaa', text)

    def test_config_validation(self):
        path = Path(self.tmp.name) / 'config.json'
        good = base_config(self.tmp.name)
        path.write_text(json.dumps(good))
        self.assertEqual(mod.read_config(path)['alertPercent'], 80)
        for patch in ({'hosts': {'x': 'http://8.8.8.8:9100/metrics'}}, {'hosts': {'x': 'https://100.64.0.11:9100/metrics'}},
                      {'mounts': ['relative']}, {'clearPercent': 80}, {'alertPercent': 100}, {'repeatSeconds': 1},
                      {'destinationFrom': 'relative.json'}):
            path.write_text(json.dumps({**good, **patch}))
            with self.assertRaises(ValueError):
                mod.read_config(path)


if __name__ == '__main__':
    unittest.main()
