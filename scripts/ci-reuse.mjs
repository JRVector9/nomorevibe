/**
 * main push 에서 같은 트리를 PR 이 이미 검사했으면 그 결과를 다시 쓴다.
 *
 * main 은 PR 이 최신 base 위에서 `check` 를 통과해야만 squash 병합된다. 그래서 병합 커밋의 트리는 대개 PR CI 가
 * 실제로 검사한 트리(refs/pull/N/merge 의 트리)와 바이트까지 같다. 같은 트리를 main 에서 15분 더 돌리지 않고
 * 바로 이미지를 만든다.
 *
 * 재사용은 아래가 모두 맞을 때만 한다. 하나라도 어긋나거나 API 가 실패하면 전체 검사를 돈다.
 *  - 이 커밋을 merge_commit_sha 로 가진, main 으로 병합된 같은 저장소 PR 이 정확히 하나다(fork PR 은 늘 전체 검사).
 *  - 그 PR head 로 돈 CI(.github/workflows/ci.yml, pull_request) 실행이 성공으로 끝났다.
 *  - 그 실행의 `check` 잡이 실제 검사를 마친 뒤 올린 `ci-tested-tree-<트리>` artifact 가 있고, 그 트리가 이 커밋의 트리와 같다.
 *    (artifact 는 문서만 바뀐 실행에서는 올리지 않는다 — 검사를 실제로 돌린 트리만 증거가 된다.)
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
export const WORKFLOW_PATH = '.github/workflows/ci.yml';

export function testedTreeArtifact(tree) {
  if (!SHA.test(tree ?? '')) throw new Error('ci_reuse_tree_invalid');
  return `ci-tested-tree-${tree}`;
}

/**
 * 재사용할 PR 실행을 찾는다. 반환: { runId, prNumber, headSha } 또는 { reason }.
 * api(path) 는 GitHub REST 응답 JSON 을 돌려준다(테스트에서 바꿔 끼운다).
 */
export async function findTestedRun({ repo, sha, tree, api, sleep = ms => new Promise(done => setTimeout(done, ms)), attempts = 3 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !SHA.test(sha ?? '') || !SHA.test(tree ?? '')) return { reason: 'input_invalid' };

  // 병합 직후에는 커밋과 PR 의 연결이 몇 초 늦게 보일 수 있다
  let merged = [];
  for (let attempt = 1; attempt <= attempts && merged.length === 0; attempt++) {
    if (attempt > 1) await sleep(5000);
    const pulls = await api(`/repos/${repo}/commits/${sha}/pulls`);
    merged = (Array.isArray(pulls) ? pulls : []).filter(pull => pull?.merge_commit_sha === sha && pull?.merged_at
      && pull?.base?.ref === 'main' && pull?.base?.repo?.full_name === repo);
  }
  if (merged.length !== 1) return { reason: merged.length ? 'pull_request_ambiguous' : 'pull_request_not_found' };
  const [pull] = merged;
  if (pull.head?.repo?.full_name !== repo) return { reason: 'pull_request_from_fork' };
  const headSha = pull.head?.sha;
  if (!SHA.test(headSha ?? '')) return { reason: 'pull_request_head_invalid' };

  const listed = await api(`/repos/${repo}/actions/artifacts?name=${encodeURIComponent(testedTreeArtifact(tree))}&per_page=100`);
  const candidates = (listed?.artifacts ?? [])
    .filter(artifact => artifact?.name === testedTreeArtifact(tree) && artifact.expired === false
      && artifact.workflow_run?.head_sha === headSha
      && Number.isInteger(artifact.workflow_run?.id)
      && artifact.workflow_run.head_repository_id === artifact.workflow_run.repository_id)
    .sort((a, b) => b.workflow_run.id - a.workflow_run.id);
  if (candidates.length === 0) return { reason: 'tested_tree_not_found' };

  for (const artifact of candidates) {
    const run = await api(`/repos/${repo}/actions/runs/${artifact.workflow_run.id}`);
    if (run?.event === 'pull_request' && run.status === 'completed' && run.conclusion === 'success'
      && run.path === WORKFLOW_PATH && run.head_sha === headSha
      && run.repository?.full_name === repo && run.head_repository?.full_name === repo) {
      return { runId: run.id, runAttempt: run.run_attempt, runUrl: run.html_url, prNumber: pull.number, headSha };
    }
  }
  return { reason: 'tested_run_not_successful' };
}

export function githubApi({ token, fetchImpl = fetch, base = 'https://api.github.com' }) {
  return async path => {
    const response = await fetchImpl(`${base}${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`github_api_${response.status}`);
    return response.json();
  };
}

/**
 * main push 의 코드 변경만 재사용을 찾는다. 결과는 늘 run_tests / reused_run 두 줄로 남긴다.
 * 무엇이 실패하든 run_tests=true(전체 검사)로 끝낸다 — 이 스크립트가 검사를 건너뛰게 만드는 길은 증거를 찾았을 때뿐이다.
 */
export async function planTests({ eventName, ref, codeChanged, repo, sha, tree, api, sleep, log = console.log }) {
  if (codeChanged !== 'true') return { runTests: false, reusedRun: '', reason: 'code_unchanged' };
  if (eventName !== 'push' || ref !== 'refs/heads/main') return { runTests: true, reusedRun: '', reason: 'not_main_push' };
  try {
    const found = await findTestedRun({ repo, sha, tree, api, ...(sleep ? { sleep } : {}) });
    if (found.runId) {
      log(`Reusing PR #${found.prNumber} CI run ${found.runUrl ?? found.runId} (attempt ${found.runAttempt}) for tree ${tree}`);
      return { runTests: false, reusedRun: String(found.runId), reason: 'tested_tree_reused', ...found };
    }
    log(`Full CI: ${found.reason}`);
    return { runTests: true, reusedRun: '', reason: found.reason };
  } catch (error) {
    log(`Full CI: reuse lookup failed (${error?.message ?? 'unknown'})`);
    return { runTests: true, reusedRun: '', reason: 'lookup_failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const plan = await planTests({
    eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, codeChanged: process.env.CODE_CHANGED,
    repo: process.env.GITHUB_REPOSITORY, sha: process.env.HEAD_SHA, tree: process.env.HEAD_TREE,
    api: githubApi({ token: process.env.GITHUB_TOKEN }),
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_tests=${plan.runTests}\nreused_run=${plan.reusedRun}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, plan.reusedRun
      ? `Tests reused from PR #${plan.prNumber}: ${plan.runUrl} (tree \`${process.env.HEAD_TREE}\`)\n`
      : `Tests: ${plan.runTests ? 'full run' : 'skipped (documentation only)'} — ${plan.reason}\n`);
  }
}
