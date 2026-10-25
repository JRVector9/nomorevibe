import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRequiredCheck } from './ci-check.mjs';

const jobs = ['typecheck', 'lint', 'unit', 'build', 'integration', 'integration-ledger'];
function needs(profile = 'full', runTests = 'true', reusedRun = '') {
  return Object.fromEntries([
    ['scope', { result: 'success', outputs: { code_changed: String(profile !== 'docs'), test_profile: profile,
      rules_version: 'v2', run_tests: runTests, reused_run: reusedRun } }],
    ...jobs.map(name => [name, { result: runTests === 'false' || (profile === 'ui' && name.startsWith('integration')) ? 'skipped' : 'success' }]),
  ]);
}

test('full, UI, documentation and certified-reuse gates accept only their exact result matrix', () => {
  for (const input of [needs(), needs('ui'), needs('docs', 'false'), needs('full', 'false', '101'), needs('ui', 'false', '101')]) {
    assert.doesNotThrow(() => validateRequiredCheck(input));
    for (const name of jobs) {
      for (const wrong of ['failure', 'cancelled', 'unknown', input[name].result === 'success' ? 'skipped' : 'success']) {
        assert.throws(() => validateRequiredCheck({ ...input, [name]: { result: wrong } }), /ci_check/);
      }
    }
  }
});

test('invalid scope evidence, omitted jobs and unsupported profiles always fail closed', () => {
  for (const scope of [
    { result: 'failure' },
    ...[{ test_profile: '' }, { test_profile: 'unknown' }, { rules_version: 'v1' }, { code_changed: 'false' },
      { run_tests: '' }, { run_tests: 'false' }, { reused_run: '101' }].map(outputs => ({ result: 'success', outputs: { ...needs().scope.outputs, ...outputs } })),
  ]) assert.throws(() => validateRequiredCheck({ ...needs(), scope }), /ci_check/);
  const missing = needs();
  delete missing.integration;
  assert.throws(() => validateRequiredCheck(missing), /ci_check/);
  assert.throws(() => validateRequiredCheck({ ...needs(), unclassified: { result: 'success' } }), /ci_check/);
  for (const reusedRun of ['', 'none', '0', '12\n']) assert.throws(() => validateRequiredCheck(needs('ui', 'false', reusedRun)), /ci_check/);
  assert.throws(() => validateRequiredCheck(needs('docs', 'true')), /ci_check/);
  assert.throws(() => validateRequiredCheck(needs('docs', 'false', '101')), /ci_check/);
});
