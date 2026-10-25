import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CI_RULES_VERSION, TEST_PROFILES } from './ci-scope.mjs';

const JOBS = ['typecheck', 'lint', 'unit', 'build', 'integration', 'integration-ledger'];
const fail = reason => { throw new Error(`ci_check_${reason}`); };

/** The branch-protection check accepts only each profile's exact success/skipped matrix. */
export function validateRequiredCheck(needs) {
  if (!needs || Object.keys(needs).sort().join(',') !== ['scope', ...JOBS].sort().join(',')) fail('jobs_invalid');
  if (needs.scope?.result !== 'success') fail('scope_failed');
  const { code_changed: codeChanged, test_profile: profile, rules_version: rulesVersion,
    run_tests: runTests, reused_run: reusedRun } = needs.scope.outputs ?? {};
  if (!TEST_PROFILES.includes(profile) || rulesVersion !== CI_RULES_VERSION) fail('profile_invalid');
  if (!['true', 'false'].includes(runTests) || typeof reusedRun !== 'string') fail('plan_invalid');
  if (codeChanged !== String(profile !== 'docs')) fail('code_scope_mismatch');
  if (profile === 'docs') {
    if (runTests !== 'false' || reusedRun !== '') fail('documentation_plan_invalid');
  } else if (runTests === 'false') {
    if (!/^[1-9][0-9]*$/.test(reusedRun)) fail('reuse_missing');
  } else if (reusedRun !== '') fail('unexpected_reuse');

  for (const name of JOBS) {
    const expected = runTests === 'false' || (profile === 'ui' && name.startsWith('integration')) ? 'skipped' : 'success';
    if (needs[name]?.result !== expected) fail(`${name}_expected_${expected}`);
  }
  return { testProfile: profile, rulesVersion, reusedRun };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const verdict = validateRequiredCheck(JSON.parse(process.env.NEEDS_JSON ?? '{}'));
  const summary = verdict.reusedRun
    ? `Tests reused from https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${verdict.reusedRun}`
    : `Required CI passed: ${verdict.testProfile}/${verdict.rulesVersion}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
