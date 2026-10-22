import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTestedRun, planTests, testedTreeArtifact } from './ci-reuse.mjs';

const REPO = 'JRVector9/nomorevibe';
const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const REPO_ID = 1335180461;

function fixture(overrides = {}) {
  const pull = { number: 591, merge_commit_sha: SHA, merged_at: '2026-10-22T01:23:49Z',
    base: { ref: 'main', repo: { full_name: REPO } }, head: { sha: HEAD, repo: { full_name: REPO } }, ...overrides.pull };
  const artifact = { name: testedTreeArtifact(TREE), expired: false,
    workflow_run: { id: 101, head_sha: HEAD, head_repository_id: REPO_ID, repository_id: REPO_ID }, ...overrides.artifact };
  const run = { id: 101, run_attempt: 1, html_url: 'https://github.com/x/runs/101', event: 'pull_request', status: 'completed',
    conclusion: 'success', path: '.github/workflows/ci.yml', head_sha: HEAD,
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...overrides.run };
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path === `/repos/${REPO}/commits/${SHA}/pulls`) return overrides.pulls ?? [pull];
    if (path.startsWith(`/repos/${REPO}/actions/artifacts?name=`)) return { artifacts: overrides.artifacts ?? [artifact] };
    if (path === `/repos/${REPO}/actions/runs/101`) return run;
    throw new Error(`unexpected ${path}`);
  };
  return { api, calls };
}

const find = (overrides, extra = {}) => findTestedRun({ repo: REPO, sha: SHA, tree: TREE, api: fixture(overrides).api,
  sleep: async () => {}, ...extra });

test('같은 저장소 PR 이 같은 트리를 성공으로 검사했으면 그 실행을 다시 쓴다', async () => {
  const { api, calls } = fixture();
  const found = await findTestedRun({ repo: REPO, sha: SHA, tree: TREE, api, sleep: async () => {} });
  assert.deepEqual(found, { runId: 101, runAttempt: 1, runUrl: 'https://github.com/x/runs/101', prNumber: 591, headSha: HEAD });
  assert.equal(calls[1], `/repos/${REPO}/actions/artifacts?name=ci-tested-tree-${TREE}&per_page=100`);
});

test('증거가 하나라도 어긋나면 재사용하지 않는다', async () => {
  assert.equal((await find({ pulls: [] })).reason, 'pull_request_not_found');
  assert.equal((await find({ pull: { merge_commit_sha: 'd'.repeat(40) } })).reason, 'pull_request_not_found');
  assert.equal((await find({ pull: { base: { ref: 'release', repo: { full_name: REPO } } } })).reason, 'pull_request_not_found');
  assert.equal((await find({ pull: { merged_at: null } })).reason, 'pull_request_not_found');
  assert.equal((await find({ pull: { head: { sha: HEAD, repo: { full_name: 'someone/fork' } } } })).reason, 'pull_request_from_fork');
  assert.equal((await find({ artifacts: [] })).reason, 'tested_tree_not_found');
  assert.equal((await find({ artifact: { expired: true } })).reason, 'tested_tree_not_found');
  assert.equal((await find({ artifact: { name: 'ci-tested-tree-other' } })).reason, 'tested_tree_not_found');
  assert.equal((await find({ artifact: { workflow_run: { id: 101, head_sha: 'e'.repeat(40), head_repository_id: REPO_ID, repository_id: REPO_ID } } })).reason,
    'tested_tree_not_found');
  assert.equal((await find({ artifact: { workflow_run: { id: 101, head_sha: HEAD, head_repository_id: 7, repository_id: REPO_ID } } })).reason,
    'tested_tree_not_found');
  for (const run of [{ conclusion: 'failure' }, { status: 'in_progress', conclusion: null }, { event: 'push' },
    { path: '.github/workflows/other.yml' }, { head_sha: 'e'.repeat(40) }, { head_repository: { full_name: 'someone/fork' } }]) {
    assert.equal((await find({ run })).reason, 'tested_run_not_successful', JSON.stringify(run));
  }
  assert.equal((await find({ pulls: [fixtureLikePull(1), fixtureLikePull(2)] })).reason, 'pull_request_ambiguous');
  assert.equal((await findTestedRun({ repo: REPO, sha: SHA, tree: 'nope', api: async () => [] })).reason, 'input_invalid');
});

function fixtureLikePull(number) {
  return { number, merge_commit_sha: SHA, merged_at: 'x', base: { ref: 'main', repo: { full_name: REPO } },
    head: { sha: HEAD, repo: { full_name: REPO } } };
}

test('병합 직후 PR 연결이 늦게 보이면 몇 번 다시 묻는다', async () => {
  const base = fixture();
  let asked = 0;
  const api = async path => {
    if (path.endsWith('/pulls') && asked++ < 2) return [];
    return base.api(path);
  };
  const found = await findTestedRun({ repo: REPO, sha: SHA, tree: TREE, api, sleep: async () => {} });
  assert.equal(found.runId, 101);
  assert.equal(asked, 3);
});

test('main push 만 재사용을 찾고, 실패하면 늘 전체 검사로 끝난다', async () => {
  const quiet = () => {};
  const { api } = fixture();
  const common = { codeChanged: 'true', repo: REPO, sha: SHA, tree: TREE, log: quiet, sleep: async () => {} };
  assert.deepEqual(await planTests({ ...common, eventName: 'push', ref: 'refs/heads/main', api: async path => (path.endsWith('/pulls') ? [] : api(path)) })
    .then(plan => [plan.runTests, plan.reusedRun]), [true, '']);
  const reused = await planTests({ ...common, eventName: 'push', ref: 'refs/heads/main', api });
  assert.equal(reused.runTests, false);
  assert.equal(reused.reusedRun, '101');
  for (const eventName of ['pull_request', 'workflow_dispatch']) {
    const plan = await planTests({ ...common, eventName, ref: 'refs/heads/main', api: async () => { throw new Error('must not call'); } });
    assert.deepEqual([plan.runTests, plan.reusedRun], [true, '']);
  }
  const failed = await planTests({ ...common, eventName: 'push', ref: 'refs/heads/main', api: async () => { throw new Error('github_api_502'); } });
  assert.deepEqual([failed.runTests, failed.reusedRun, failed.reason], [true, '', 'lookup_failed']);
  const docs = await planTests({ ...common, codeChanged: 'false', eventName: 'push', ref: 'refs/heads/main', api });
  assert.deepEqual([docs.runTests, docs.reusedRun], [false, '']);
});
