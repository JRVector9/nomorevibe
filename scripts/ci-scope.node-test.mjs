import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyPaths, classifyTestProfile, detectScope } from './ci-scope.mjs';

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
  assert.match(readFileSync(output, 'utf8'), /^code_changed=false\ntest_profile=docs\nrules_version=v2\n$/);
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

test('only CSS under app/components and JSON messages select the UI profile', () => {
  const cases = [
    [['app/globals.css'], 'ui'],
    [['components/me/avatar.css', 'messages/ko/common.json'], 'ui'],
    [['docs/release.md', 'README.md', 'components/me/avatar.css'], 'ui'],
    [['messages/ko/common.ts'], 'full'],
    [['app/page.tsx'], 'full'],
    [['components/Auth.tsx'], 'full'],
    [['lib/db/schema.ts'], 'full'],
    [['scripts/worker.ts'], 'full'],
    [['app/globals.css', 'package-lock.json'], 'full'],
    [['messages/ko/common.json', '.github/workflows/ci.yml'], 'full'],
    [['styles/global.css'], 'full'],
    [['messages/ko/common.json.ts'], 'full'],
    [['app/../lib/worker.css'], 'full'],
    [['components/./avatar.css'], 'full'],
    [['messages/ko/common.json\n'], 'full'],
    [[], 'full'],
  ];
  for (const [paths, expected] of cases) {
    assert.equal(classifyTestProfile(paths), expected, JSON.stringify(paths));
  }
});

test('renaming runtime code into a CSS path cannot hide the removed runtime path', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nmv-ci-rename-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.test');
  git('config', 'user.name', 'CI');
  writeFileSync(join(cwd, 'worker.ts'), 'export const worker = true;\n');
  git('add', '.');
  git('commit', '-qm', 'before');
  const before = git('rev-parse', 'HEAD');
  mkdirSync(join(cwd, 'app'));
  git('mv', 'worker.ts', 'app/style.css');
  git('commit', '-qm', 'rename');
  const after = git('rev-parse', 'HEAD');
  assert.equal(detectScope({ eventName: 'push', baseSha: before, headSha: after, cwd }).testProfile, 'full');
});


test('real CSS-only diffs choose UI and missing comparison commits choose full', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nmv-ci-ui-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.test');
  git('config', 'user.name', 'CI');
  mkdirSync(join(cwd, 'app'));
  writeFileSync(join(cwd, 'app/globals.css'), 'body { color: red; }\n');
  git('add', '.');
  git('commit', '-qm', 'before');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'app/globals.css'), 'body { color: blue; }\n');
  git('add', '.');
  git('commit', '-qm', 'after');
  const after = git('rev-parse', 'HEAD');
  const output = join(cwd, 'output');
  assert.deepEqual(detectScope({ eventName: 'pull_request', baseSha: before, headSha: after, cwd, output }),
    { codeChanged: true, testProfile: 'ui', rulesVersion: 'v2' });
  assert.equal(readFileSync(output, 'utf8'), 'code_changed=true\ntest_profile=ui\nrules_version=v2\n');
  assert.equal(detectScope({ eventName: 'push', baseSha: '0'.repeat(40), headSha: after, cwd }).testProfile, 'full');
  assert.equal(detectScope({ eventName: 'push', baseSha: after, headSha: after, cwd }).testProfile, 'full');
});

function replaceRuntimeChangeWithCss({ whitespace = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'nmv-ci-replace-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'ci@example.test');
  git('config', 'user.name', 'CI');
  mkdirSync(join(cwd, 'app'));
  mkdirSync(join(cwd, 'lib'));
  writeFileSync(join(cwd, 'app/globals.css'), 'body { color: red; }\n');
  writeFileSync(join(cwd, 'lib/runtime.ts'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'lib/runtime.ts'), `export const value = 2;${whitespace ? '  ' : ''}\n`);
  git('add', '.');
  git('commit', '-qm', 'actual runtime change');
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', base);
  writeFileSync(join(cwd, 'app/globals.css'), 'body { color: blue; }\n');
  git('add', '.');
  git('commit', '-qm', 'replacement CSS change');
  git('replace', head, git('rev-parse', 'HEAD'));
  assert.equal(git('diff', '--name-only', base, head), 'app/globals.css');
  assert.equal(git('--no-replace-objects', 'diff', '--name-only', base, head), 'lib/runtime.ts');
  return { cwd, baseSha: base, headSha: head, eventName: 'pull_request' };
}

test('local Git replacement refs cannot disguise runtime changes as CSS-only', () => {
  assert.equal(detectScope(replaceRuntimeChangeWithCss()).testProfile, 'full');
});

test('local Git replacement refs cannot hide whitespace failures in the real commits', () => {
  assert.throws(() => detectScope(replaceRuntimeChangeWithCss({ whitespace: true })), /ci_diff_whitespace_error/);
});
