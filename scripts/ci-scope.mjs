import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;

// Bump whenever the profile allowlist or required job matrix changes. Old certificates cannot authorize a new matrix.
export const CI_RULES_VERSION = 'v2';
export const TEST_PROFILES = ['docs', 'ui', 'full'];

export function classifyTestProfile(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return 'full';
  let uiChanged = false;
  for (const path of paths) {
    // Unusual/unclassified paths fail closed, including traversal-looking names and newline output injection.
    if (typeof path !== 'string' || /[\\\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')) return 'full';
    if (path === 'README.md' || path === 'PENDING.md' || path.startsWith('docs/')) continue;
    if (/^(?:app|components)\/.+\.css$/.test(path) || /^messages\/.+\.json$/.test(path)) uiChanged = true;
    else return 'full';
  }
  return uiChanged ? 'ui' : 'docs';
}

export function classifyPaths(paths) {
  return classifyTestProfile(paths) !== 'docs';
}

export function detectScope({ eventName, baseSha, headSha, cwd = process.cwd(), output } = {}) {
  let testProfile = 'full';
  if ((eventName === 'pull_request' || eventName === 'push')
    && SHA.test(baseSha ?? '') && SHA.test(headSha ?? '') && baseSha !== headSha) {
    try {
      const changed = execFileSync('git', ['--no-replace-objects', 'diff', '--no-renames', '--name-only', '-z', baseSha, headSha], { cwd, stdio: 'pipe' })
        .toString('utf8').split('\0').filter(Boolean);
      execFileSync('git', ['--no-replace-objects', 'diff', '--check', baseSha, headSha], { cwd, stdio: 'pipe' });
      testProfile = classifyTestProfile(changed);
    } catch (error) {
      // A missing comparison commit needs the full suite. Whitespace errors still fail CI.
      if (error?.status === 2) throw new Error('ci_diff_whitespace_error');
      testProfile = 'full';
    }
  }
  const codeChanged = testProfile !== 'docs';
  if (output) appendFileSync(output, `code_changed=${codeChanged}\ntest_profile=${testProfile}\nrules_version=${CI_RULES_VERSION}\n`);
  return { codeChanged, testProfile, rulesVersion: CI_RULES_VERSION };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = detectScope({ eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.BASE_SHA, headSha: process.env.HEAD_SHA,
    output: process.env.GITHUB_OUTPUT });
  console.log(`CI profile: ${result.testProfile} (${result.rulesVersion})`);
}
