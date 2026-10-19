"""Exercise the release-tag command with shell fakes; no credentials or network."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / '.claude/prod.sh'
SHA = 'a' * 40


@unittest.skipUnless(shutil.which('jq'), 'requires jq, as does prod.sh')
class ReleaseTagTests(unittest.TestCase):
    def invoke(self, status='200', targets=('text',), sha=SHA):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            startup = fixture / 'shell-fixture.sh'
            startup.write_text(r'''
git() { case "$*" in *fetch*) return 0;; *rev-parse*) printf '%s\n' "$FIXTURE_SHA";; *) return 99;; esac; }
security() { printf 'offline-fixture'; }
curl() {
  case "$*" in
    *application.one*) printf 'read\n' >> "$FIXTURE_CALLS"; printf '%s' '{"env":"RELEASE_TAG=old\nKEEP=unchanged","buildSecrets":"fixture","createEnvFile":true,"buildArgs":"fixture"}';;
    *application.saveEnvironment*)
      printf 'write\n' >> "$FIXTURE_CALLS"
      jq -e --arg sha "$FIXTURE_SHA" '.env == ("RELEASE_TAG=" + $sha + "\nKEEP=unchanged") and .buildSecrets == "fixture" and .createEnvFile == true and .buildArgs == "fixture"' >/dev/null || return 98
      printf '{}\n%s' "$FIXTURE_STATUS";;
    *) return 97;;
  esac
}
''')
            calls = fixture / 'calls'
            env = {**os.environ, 'BASH_ENV': str(startup), 'FIXTURE_SHA': SHA,
                   'FIXTURE_STATUS': status, 'FIXTURE_CALLS': str(calls)}
            result = subprocess.run(['bash', str(SCRIPT), 'set-release', sha, *targets],
                                    env=env, capture_output=True, text=True, timeout=5)
            return result, calls.read_text().splitlines() if calls.exists() else []

    def test_success_preserves_environment_and_build_fields(self):
        result, calls = self.invoke(targets=('text', 'text-mini'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, ['read', 'write', 'read', 'write'])
        self.assertNotIn('offline-fixture', result.stdout + result.stderr)

    def test_http_failures_stop_before_a_second_app(self):
        for status in ('403', '500', '000'):
            with self.subTest(status=status):
                result, calls = self.invoke(status, targets=('text', 'text-mini'))
                self.assertEqual(result.returncode, 4, result.stderr)
                self.assertEqual(calls, ['read', 'write'])

    def test_invalid_later_target_causes_no_api_call(self):
        result, calls = self.invoke(targets=('text', 'crawler'))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])

    def test_invalid_sha_causes_no_api_call(self):
        result, calls = self.invoke(sha='invalid')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
