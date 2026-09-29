import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;

export function classifyPaths(paths) {
  return paths.length === 0 || paths.some(path =>
    path !== 'README.md' && path !== 'PENDING.md' && !path.startsWith('docs/'));
}

export function detectScope({ eventName, baseSha, headSha, cwd = process.cwd(), output } = {}) {
  let codeChanged = true;
  if ((eventName === 'pull_request' || eventName === 'push')
    && SHA.test(baseSha ?? '') && SHA.test(headSha ?? '') && baseSha !== headSha) {
    try {
      const changed = execFileSync('git', ['diff', '--name-only', '-z', baseSha, headSha], { cwd })
        .toString('utf8').split('\0').filter(Boolean);
      execFileSync('git', ['diff', '--check', baseSha, headSha], { cwd, stdio: 'pipe' });
      codeChanged = classifyPaths(changed);
    } catch (error) {
      // A missing comparison commit needs the full suite. Whitespace errors still fail CI.
      if (error?.status === 2) throw new Error('ci_diff_whitespace_error');
      codeChanged = true;
    }
  }
  if (output) appendFileSync(output, `code_changed=${codeChanged}\n`);
  return { codeChanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = detectScope({ eventName: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.BASE_SHA, headSha: process.env.HEAD_SHA,
    output: process.env.GITHUB_OUTPUT });
  console.log(result.codeChanged ? 'Full CI required' : 'Documentation-only CI');
}
