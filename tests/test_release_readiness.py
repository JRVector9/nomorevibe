"""Read-only GitHub release readiness proof, with fake API graphs and ZIPs."""

import copy
import importlib.util
import io
import json
import stat
import unittest
import zipfile
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/release_readiness.py'
SPEC = importlib.util.spec_from_file_location('release_readiness', SOURCE)
readiness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(readiness)

REPO = 'JRVector9/nomorevibe'
SHA = 'a' * 40
TREE = 'b' * 40
RUN_ID = 50
ATTEMPT = 2
REPO_ID = 777
PREFIX = '/repos/' + REPO
IMAGES = {'worker': 'ghcr.io/jrvector9/nomorevibe-worker@sha256:' + 'c' * 64,
          'web': 'ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:' + 'd' * 64}


def receipt(image_kind, **overrides):
    return {'schemaVersion': 1, 'release': SHA, 'tree': TREE, 'kind': image_kind,
            'image': IMAGES[image_kind], 'runId': RUN_ID, 'runAttempt': ATTEMPT,
            'testProfile': 'full', 'rulesVersion': 'v2', **overrides}


def archive(kind, payload=None, *, name=None, extra=None, mode=None):
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        entry = zipfile.ZipInfo(name or f'release-image-{kind}.json')
        if mode is not None:
            entry.create_system = 3
            entry.external_attr = mode << 16
        value = json.dumps(receipt(kind) if payload is None else payload).encode()
        zipped.writestr(entry, value)
        if extra:
            zipped.writestr(extra, b'{}')
    return result.getvalue()


class FakeGraph:
    def __init__(self):
        self.requests, self.downloads = [], []
        self.main = {'sha': SHA, 'commit': {'tree': {'sha': TREE}}}
        self.run = {'id': RUN_ID, 'run_attempt': ATTEMPT, 'event': 'push',
                    'path': '.github/workflows/ci.yml', 'head_branch': 'main', 'head_sha': SHA,
                    'repository': {'full_name': REPO, 'id': REPO_ID},
                    'head_repository': {'full_name': REPO, 'id': REPO_ID},
                    # refresh-caches may still be running after check and publish.
                    'status': 'in_progress', 'conclusion': None}
        self.runs = [copy.deepcopy(self.run)]
        self.jobs = [{'id': index, 'name': name, 'status': 'completed', 'conclusion': 'success',
                      'run_id': RUN_ID, 'run_attempt': ATTEMPT, 'head_sha': SHA}
                     for index, name in enumerate(('check', 'publish-worker-image', 'publish-web-image'), 1)]
        self.jobs.append({'id': 4, 'name': 'refresh-caches', 'status': 'in_progress', 'conclusion': None})
        self.artifacts = [{'id': 100 + index, 'name': f'release-image-{kind}-{SHA}',
                           'expired': False, 'size_in_bytes': 500,
                           'workflow_run': {'id': RUN_ID, 'repository_id': REPO_ID,
                                            'head_repository_id': REPO_ID, 'head_sha': SHA,
                                            'head_branch': 'main'}}
                          for index, kind in enumerate(('worker', 'web'), 1)]
        self.archives = {101: archive('worker'), 102: archive('web')}
        self.error = None
        self.main_reads = 0
        self.new_main_on_final_read = False

    def api(self, path):
        self.requests.append(path)
        if self.error:
            raise self.error
        if path == PREFIX + '/commits/main':
            self.main_reads += 1
            value = copy.deepcopy(self.main)
            if self.main_reads > 1 and self.new_main_on_final_read:
                value['sha'] = 'f' * 40
            return value
        if path.startswith(PREFIX + '/actions/workflows/ci.yml/runs?'):
            return {'workflow_runs': copy.deepcopy(self.runs), 'total_count': len(self.runs)}
        if path == PREFIX + f'/actions/runs/{RUN_ID}':
            return copy.deepcopy(self.run)
        if path.startswith(PREFIX + f'/actions/runs/{RUN_ID}/jobs?'):
            return {'jobs': copy.deepcopy(self.jobs), 'total_count': len(self.jobs)}
        if path.startswith(PREFIX + f'/actions/runs/{RUN_ID}/artifacts?'):
            return {'artifacts': copy.deepcopy(self.artifacts), 'total_count': len(self.artifacts)}
        raise AssertionError('unexpected API path: ' + path)

    def download(self, path):
        self.downloads.append(path)
        artifact_id = int(path.rsplit('/', 2)[1])
        return self.archives[artifact_id]


class ReleaseReadinessTests(unittest.TestCase):
    def setUp(self):
        self.graph = FakeGraph()

    def resolve(self, **options):
        return readiness.resolve_readiness(SHA, repo=REPO, api=self.graph.api,
                                           download=self.graph.download, **options)

    def reject(self, code, **options):
        with self.assertRaises(readiness.ReadinessError) as raised:
            self.resolve(**options)
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(str(raised.exception), code)

    def test_check_and_required_images_are_ready_while_optional_cache_and_workflow_run(self):
        result = self.resolve()
        self.assertTrue(result['checkPassed'])
        self.assertTrue(result['imagesReady'])
        self.assertEqual(result['schemaVersion'], 1)
        self.assertEqual(result['target'], {'sha': SHA, **IMAGES})
        self.assertEqual(result['tree'], TREE)
        self.assertEqual(result['runId'], RUN_ID)
        self.assertEqual(result['runAttempt'], ATTEMPT)
        self.assertEqual(result['profile'], 'full')
        self.assertEqual(result['rulesVersion'], 'v2')
        self.assertRegex(result['verifiedAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        self.assertEqual(set(result['kindProofs']), {'worker', 'web'})
        self.assertEqual(self.graph.main_reads, 2)

    def test_only_required_kind_waits_for_its_publish_and_artifact(self):
        self.graph.jobs[2].update(status='in_progress', conclusion=None)
        self.graph.artifacts.pop()
        result = self.resolve(required_kinds=('worker',))
        self.assertEqual(result['target'], {'sha': SHA, 'worker': IMAGES['worker']})
        self.assertEqual(self.graph.downloads, [PREFIX + '/actions/artifacts/101/zip'])

    def test_ui_profile_is_bound_to_image_receipts(self):
        self.graph.archives = {101: archive('worker', receipt('worker', testProfile='ui')),
                               102: archive('web', receipt('web', testProfile='ui'))}
        self.assertEqual(self.resolve()['profile'], 'ui')

    def test_invalid_input_never_reads_an_api_or_download(self):
        for sha, repo, kinds in (('main', REPO, ('worker',)), (SHA, 'fork/nomorevibe', ('worker',)),
                                 (SHA, REPO, ('connect-agent',)), (SHA, REPO, ('web', 'web')),
                                 (SHA, REPO, ())):
            with self.subTest(sha=sha, repo=repo, kinds=kinds), self.assertRaises(readiness.ReadinessError):
                readiness.resolve_readiness(sha, repo=repo, required_kinds=kinds,
                                            api=self.graph.api, download=self.graph.download)
        self.assertEqual(self.graph.requests, [])
        self.assertEqual(self.graph.downloads, [])

    def test_api_failure_does_not_expose_its_message_or_download_anything(self):
        self.graph.error = RuntimeError('token=do-not-print')
        self.reject('github_api_failed')
        self.assertEqual(self.graph.downloads, [])

    def test_target_must_still_be_main_with_a_valid_tree(self):
        self.graph.main['sha'] = 'e' * 40
        self.reject('target_not_main')
        self.graph.main['sha'] = SHA
        self.graph.main['commit']['tree']['sha'] = 'invalid'
        self.reject('main_tree_invalid')

    def test_malformed_api_containers_have_stable_error_codes(self):
        for commit in ({'tree': []}, {'tree': 'invalid'}, ['invalid']):
            graph = FakeGraph()
            graph.main['commit'] = commit
            with self.subTest(commit=commit), self.assertRaisesRegex(readiness.ReadinessError, 'main_tree_invalid'):
                readiness.resolve_readiness(SHA, repo=REPO, api=graph.api, download=graph.download)

    def test_main_moving_during_the_proof_invalidates_readiness(self):
        self.graph.new_main_on_final_read = True
        self.reject('target_not_main')

    def test_no_main_push_run_is_pending_instead_of_using_a_pr(self):
        self.graph.runs = []
        self.reject('ci_run_pending')

    def test_latest_run_is_used_and_an_older_success_cannot_mask_it(self):
        self.graph.runs.append({**self.graph.run, 'id': RUN_ID - 1})
        self.graph.jobs[0].update(status='in_progress', conclusion=None)
        self.reject('check_pending')

    def test_run_origin_path_branch_sha_and_attempt_are_strict(self):
        mutations = ({'event': 'pull_request'}, {'path': '.github/workflows/other.yml'},
                     {'head_branch': 'feature'}, {'head_sha': 'e' * 40}, {'run_attempt': 0},
                     {'repository': {'full_name': 'fork/nomorevibe', 'id': REPO_ID}},
                     {'head_repository': {'full_name': REPO, 'id': REPO_ID + 1}})
        for mutation in mutations:
            graph = FakeGraph()
            graph.run.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(readiness.ReadinessError, 'ci_run_untrusted'):
                readiness.resolve_readiness(SHA, repo=REPO, api=graph.api, download=graph.download)

    def test_check_missing_failed_skipped_duplicate_or_wrong_attempt_cannot_pass(self):
        for mutation, code in (('missing', 'check_pending'), ('failed', 'check_failed'),
                               ('skipped', 'check_failed'), ('duplicate', 'check_ambiguous'),
                               ('attempt', 'check_untrusted')):
            graph = FakeGraph()
            if mutation == 'missing':
                graph.jobs.pop(0)
            elif mutation == 'duplicate':
                graph.jobs.append(copy.deepcopy(graph.jobs[0]))
            elif mutation == 'attempt':
                graph.jobs[0]['run_attempt'] = ATTEMPT - 1
            else:
                graph.jobs[0]['conclusion'] = 'failure' if mutation == 'failed' else 'skipped'
            with self.subTest(mutation=mutation), self.assertRaisesRegex(readiness.ReadinessError, code):
                readiness.resolve_readiness(SHA, repo=REPO, api=graph.api, download=graph.download)

    def test_required_image_publish_must_complete_successfully(self):
        self.graph.jobs[1].update(status='in_progress', conclusion=None)
        self.reject('worker_publish_pending')
        self.graph.jobs[1].update(status='completed', conclusion='failure')
        self.reject('worker_publish_failed')
        self.assertEqual(self.graph.downloads, [])

    def test_artifact_missing_duplicate_expired_or_foreign_metadata_blocks(self):
        for mutation, code in (('missing', 'worker_artifact_pending'),
                               ('duplicate', 'worker_artifact_ambiguous'),
                               ('expired', 'worker_artifact_expired'),
                               ('run', 'worker_artifact_untrusted'),
                               ('sha', 'worker_artifact_untrusted'),
                               ('repository', 'worker_artifact_untrusted'),
                               ('head_repository', 'worker_artifact_untrusted')):
            graph = FakeGraph()
            if mutation == 'missing':
                graph.artifacts.pop(0)
            elif mutation == 'duplicate':
                graph.artifacts.append(copy.deepcopy(graph.artifacts[0]))
            elif mutation == 'expired':
                graph.artifacts[0]['expired'] = True
            else:
                field = {'run': 'id', 'sha': 'head_sha', 'repository': 'repository_id',
                         'head_repository': 'head_repository_id'}[mutation]
                graph.artifacts[0]['workflow_run'][field] = 'e' * 40 if mutation == 'sha' else 999
            with self.subTest(mutation=mutation), self.assertRaisesRegex(readiness.ReadinessError, code):
                readiness.resolve_readiness(SHA, repo=REPO, api=graph.api, download=graph.download)

    def test_untrusted_artifact_download_urls_are_not_followed(self):
        self.graph.artifacts[0]['archive_download_url'] = 'https://attacker.invalid/secret'
        self.resolve(required_kinds=('worker',))
        self.assertEqual(self.graph.downloads, [PREFIX + '/actions/artifacts/101/zip'])

    def test_receipt_release_tree_kind_run_attempt_image_and_rules_must_match(self):
        mutations = ({'schemaVersion': 2}, {'release': 'e' * 40}, {'tree': 'e' * 40},
                     {'kind': 'web'}, {'runId': RUN_ID - 1}, {'runAttempt': ATTEMPT - 1},
                     {'image': IMAGES['web']}, {'image': 'ghcr.io/example/worker:latest'},
                     {'testProfile': 'docs'}, {'rulesVersion': 'v1'}, {'unexpected': True})
        for mutation in mutations:
            graph = FakeGraph()
            graph.archives[101] = archive('worker', receipt('worker', **mutation))
            with self.subTest(mutation=mutation), self.assertRaisesRegex(readiness.ReadinessError, 'worker_receipt_invalid'):
                readiness.resolve_readiness(SHA, repo=REPO, api=graph.api, download=graph.download)

    def test_profile_disagreement_between_image_receipts_is_rejected(self):
        self.graph.archives[102] = archive('web', receipt('web', testProfile='ui'))
        self.reject('image_profiles_mismatch')

    def test_zip_cannot_contain_extra_path_traversal_directory_or_symlink(self):
        for kwargs in ({'extra': 'extra.json'}, {'name': '../release-image-worker.json'},
                       {'name': '/release-image-worker.json'}, {'name': 'nested/release-image-worker.json'},
                       {'name': 'release-image-worker.json/'},
                       {'mode': stat.S_IFLNK | 0o777}):
            graph = FakeGraph()
            graph.archives[101] = archive('worker', **kwargs)
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(readiness.ReadinessError, 'worker_archive_invalid'):
                readiness.resolve_readiness(SHA, repo=REPO, api=graph.api, download=graph.download)

    def test_oversized_corrupt_or_duplicate_key_json_is_rejected(self):
        raw_values = [b'not-a-zip', archive('worker', {'large': 'x' * 5000}), b'x' * 70000]
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, 'w') as zipped:
            zipped.writestr('release-image-worker.json', '{"schemaVersion":1,"schemaVersion":1}')
        raw_values.append(raw.getvalue())
        for value in raw_values:
            graph = FakeGraph()
            graph.archives[101] = value
            with self.subTest(size=len(value)), self.assertRaises(readiness.ReadinessError):
                readiness.resolve_readiness(SHA, repo=REPO, api=graph.api, download=graph.download)

    def test_deep_json_and_corrupt_compressed_content_are_sanitized(self):
        result = io.BytesIO()
        with zipfile.ZipFile(result, 'w') as zipped:
            zipped.writestr('release-image-worker.json', '[' * 1500 + ']' * 1500)
        self.graph.archives[101] = result.getvalue()
        self.reject('worker_receipt_invalid')

    def test_rerun_starting_while_artifacts_are_downloaded_invalidates_the_proof(self):
        original_download = self.graph.download

        def start_rerun(path):
            value = original_download(path)
            self.graph.run['run_attempt'] = ATTEMPT + 1
            return value

        with self.assertRaisesRegex(readiness.ReadinessError, 'ci_run_changed'):
            readiness.resolve_readiness(SHA, repo=REPO, api=self.graph.api, download=start_rerun)

    def test_newer_push_run_starting_during_download_is_not_hidden_by_old_success(self):
        original_download = self.graph.download

        def start_new_run(path):
            if not any(run['id'] == RUN_ID + 1 for run in self.graph.runs):
                self.graph.runs.append({**self.graph.run, 'id': RUN_ID + 1})
            return original_download(path)

        with self.assertRaisesRegex(readiness.ReadinessError, 'ci_run_changed'):
            readiness.resolve_readiness(SHA, repo=REPO, api=self.graph.api, download=start_new_run)

    def test_check_state_changing_during_the_read_proof_is_revalidated(self):
        original_download = self.graph.download

        def change_check(path):
            self.graph.jobs[0]['conclusion'] = 'failure'
            return original_download(path)

        with self.assertRaisesRegex(readiness.ReadinessError, 'check_failed'):
            readiness.resolve_readiness(SHA, repo=REPO, api=self.graph.api, download=change_check)

    def test_download_failure_is_sanitized(self):
        def failed_download(path):
            raise RuntimeError('Authorization: secret')
        with self.assertRaisesRegex(readiness.ReadinessError, 'artifact_download_failed'):
            readiness.resolve_readiness(SHA, repo=REPO, api=self.graph.api, download=failed_download)


if __name__ == '__main__':
    unittest.main()
