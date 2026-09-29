import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyPaths, detectScope } from './ci-scope.mjs';

test('only root operations docs and docs/ files take the short path', () => {
  assert.equal(classifyPaths(['README.md', 'PENDING.md', 'docs/operations/release.md']), false);
  assert.equal(classifyPaths(['docs/operations/release.md', 'app/page.tsx']), true);
  assert.equal(classifyPaths(['.github/workflows/ci.yml']), true);
  assert.equal(classifyPaths(['AGENTS.md']), true);
  assert.equal(classifyPaths([]), true);
});

test('a real docs-only git diff writes code_changed=false', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nmv-ci-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.test');
  git('config', 'user.name', 'CI');
  writeFileSync(join(cwd, 'README.md'), '# Before\n');
  git('add', '.');
  git('commit', '-qm', 'before');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'README.md'), '# After\n');
  git('add', '.');
  git('commit', '-qm', 'after');
  const after = git('rev-parse', 'HEAD');
  const output = join(cwd, 'output');

  const result = detectScope({ eventName: 'pull_request', baseSha: before, headSha: after, cwd, output });

  assert.equal(result.codeChanged, false);
  assert.match(readFileSync(output, 'utf8'), /^code_changed=false\n$/);
});

test('missing diff and manual dispatch run the full checks', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nmv-ci-scope-'));
  assert.equal(detectScope({ eventName: 'pull_request', baseSha: '', headSha: '', cwd }).codeChanged, true);
  assert.equal(detectScope({ eventName: 'workflow_dispatch', baseSha: '', headSha: '', cwd }).codeChanged, true);
});

test('a whitespace error in documentation still fails the required gate', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nmv-ci-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.test');
  git('config', 'user.name', 'CI');
  writeFileSync(join(cwd, 'README.md'), '# Before\n');
  git('add', '.');
  git('commit', '-qm', 'before');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'README.md'), '# After  \n');
  git('add', '.');
  git('commit', '-qm', 'after');
  const after = git('rev-parse', 'HEAD');

  assert.throws(() => detectScope({ eventName: 'push', baseSha: before, headSha: after, cwd }),
    /ci_diff_whitespace_error/);
});
