#!/usr/bin/env python3
"""Read-only proof that main check and its required immutable images are ready.

GitHub CLI handles credentials internally. Captured command errors and raw API
responses never reach stdout. The optional cache job/workflow conclusion is not a
deployment gate: latest check, required publish jobs, and exact image receipts are.
"""

import io
import json
import re
import stat
import subprocess
import zipfile
from datetime import datetime, timezone


TRUSTED_REPO = 'JRVector9/nomorevibe'
WORKFLOW_PATH = '.github/workflows/ci.yml'
RULES_VERSION = 'v2'
SHA = re.compile(r'[0-9a-f]{40}')
IMAGE_PREFIXES = {'worker': 'ghcr.io/jrvector9/nomorevibe-worker@sha256:',
                  'web': 'ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:'}
MAX_RECEIPT_BYTES = 4096
MAX_ARCHIVE_BYTES = 65536
RECEIPT_FIELDS = frozenset({'schemaVersion', 'release', 'tree', 'kind', 'image', 'runId',
                            'runAttempt', 'testProfile', 'rulesVersion'})


class ReadinessError(RuntimeError):
    """A stable, non-secret reason why a deployment must not start."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _positive_integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def github_api(path):
    """Return GitHub JSON using gh's existing authentication, without printing it."""
    try:
        result = subprocess.run(['gh', 'api', path], capture_output=True, timeout=30, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise ReadinessError('github_api_failed') from None


def download_artifact(path):
    """Read the API's ZIP endpoint; callers first enforce the artifact size bound."""
    try:
        result = subprocess.run(['gh', 'api', path], capture_output=True, timeout=30, check=True)
        if len(result.stdout) > MAX_ARCHIVE_BYTES:
            raise ReadinessError('artifact_download_too_large')
        return result.stdout
    except (OSError, subprocess.SubprocessError):
        raise ReadinessError('artifact_download_failed') from None


def _fetch(api, path):
    try:
        response = api(path)
    except ReadinessError:
        raise
    except Exception:
        raise ReadinessError('github_api_failed') from None
    if not isinstance(response, dict):
        raise ReadinessError('github_api_invalid_response')
    return response


def _listed(api, path, field):
    """Bounded pagination; an incomplete listing cannot prove uniqueness/latest."""
    collected = []
    for page in range(1, 11):
        response = _fetch(api, path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        entries, total = response.get(field), response.get('total_count')
        if (not isinstance(entries, list) or not isinstance(total, int) or isinstance(total, bool)
                or total < 0 or any(not isinstance(entry, dict) for entry in entries)):
            raise ReadinessError('github_api_invalid_response')
        collected.extend(entries)
        if len(collected) >= total:
            if len(collected) != total:
                raise ReadinessError('github_api_invalid_response')
            return collected
        if len(entries) != 100:
            raise ReadinessError('github_api_incomplete_listing')
    raise ReadinessError('github_api_pagination_limit')


def _main_commit(api, prefix, sha):
    main = _fetch(api, prefix + '/commits/main')
    if main.get('sha') != sha:
        raise ReadinessError('target_not_main')
    commit = main.get('commit') or {}
    tree_object = commit.get('tree') if isinstance(commit, dict) else None
    tree = tree_object.get('sha') if isinstance(tree_object, dict) else None
    if not isinstance(tree, str) or not SHA.fullmatch(tree):
        raise ReadinessError('main_tree_invalid')
    return tree


def _trusted_run(run, sha, run_id):
    repository, head = run.get('repository') or {}, run.get('head_repository') or {}
    if (run.get('id') != run_id or not _positive_integer(run.get('id'))
            or not _positive_integer(run.get('run_attempt')) or run.get('event') != 'push'
            or run.get('path') != WORKFLOW_PATH or run.get('head_branch') != 'main'
            or run.get('head_sha') != sha or not isinstance(repository, dict) or not isinstance(head, dict)
            or repository.get('full_name') != TRUSTED_REPO or head.get('full_name') != TRUSTED_REPO
            or not _positive_integer(repository.get('id')) or not _positive_integer(head.get('id'))
            or head.get('id') != repository['id']):
        raise ReadinessError('ci_run_untrusted')


def _latest_run_id(api, prefix, sha):
    runs = _listed(api, prefix + '/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=' + sha,
                    'workflow_runs')
    candidates = [run for run in runs if run.get('head_sha') == sha]
    if not candidates:
        raise ReadinessError('ci_run_pending')
    if any(not _positive_integer(run.get('id')) for run in candidates):
        raise ReadinessError('ci_run_untrusted')
    latest_id = max(run['id'] for run in candidates)
    if sum(run['id'] == latest_id for run in candidates) != 1:
        raise ReadinessError('ci_run_ambiguous')
    return latest_id


def _job_passed(jobs, name, code, *, sha, run_id, run_attempt):
    matches = [job for job in jobs if job.get('name') == name]
    if not matches:
        raise ReadinessError(code + '_pending')
    if len(matches) != 1:
        raise ReadinessError(code + '_ambiguous')
    job = matches[0]
    for field, expected in (('run_id', run_id), ('run_attempt', run_attempt), ('head_sha', sha)):
        if field in job and job[field] != expected:
            raise ReadinessError(code + '_untrusted')
    if job.get('status') != 'completed':
        raise ReadinessError(code + '_pending')
    if job.get('conclusion') != 'success':
        raise ReadinessError(code + '_failed')
    return job


def _artifact_for_kind(artifacts, kind, sha, run):
    code = kind + '_artifact'
    matches = [artifact for artifact in artifacts if artifact.get('name') == f'release-image-{kind}-{sha}']
    if not matches:
        raise ReadinessError(code + '_pending')
    if len(matches) != 1:
        raise ReadinessError(code + '_ambiguous')
    artifact = matches[0]
    if artifact.get('expired') is not False:
        raise ReadinessError(code + '_expired')
    size = artifact.get('size_in_bytes')
    if (not _positive_integer(artifact.get('id')) or not _positive_integer(size) or size > MAX_ARCHIVE_BYTES):
        raise ReadinessError(code + '_untrusted')
    metadata = artifact.get('workflow_run')
    if metadata is not None:
        if not isinstance(metadata, dict):
            raise ReadinessError(code + '_untrusted')
        for field, value in (('id', run['id']), ('head_sha', sha), ('head_branch', 'main'),
                             ('repository_id', run['repository']['id']),
                             ('head_repository_id', run['repository']['id']),
                             ('run_attempt', run['run_attempt'])):
            if field in metadata and metadata[field] != value:
                raise ReadinessError(code + '_untrusted')
    return artifact


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_key')
        result[key] = value
    return result


def parse_image_artifact(raw, *, kind, sha, tree, run_id, run_attempt):
    """Read a single small JSON file without extracting any archive paths."""
    archive_code, receipt_code = kind + '_archive_invalid', kind + '_receipt_invalid'
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_ARCHIVE_BYTES:
        raise ReadinessError(archive_code)
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) != 1:
                raise ValueError('archive_entry_count')
            entry = entries[0]
            file_type = stat.S_IFMT(entry.external_attr >> 16)
            if (entry.filename != f'release-image-{kind}.json' or entry.is_dir()
                    or file_type not in (0, stat.S_IFREG) or entry.flag_bits & 1
                    or not 0 < entry.file_size <= MAX_RECEIPT_BYTES):
                raise ValueError('archive_entry_invalid')
            with archive.open(entry) as source:
                content = source.read(MAX_RECEIPT_BYTES + 1)
            if len(content) != entry.file_size or len(content) > MAX_RECEIPT_BYTES:
                raise ValueError('archive_content_size')
    except Exception:
        raise ReadinessError(archive_code) from None
    try:
        receipt = json.loads(content.decode('utf-8'), object_pairs_hook=_unique_json_object)
    except (ValueError, UnicodeError, RecursionError):
        raise ReadinessError(receipt_code) from None
    if (not isinstance(receipt, dict) or set(receipt) != RECEIPT_FIELDS
            or type(receipt.get('schemaVersion')) is not int or receipt['schemaVersion'] != 1
            or receipt.get('release') != sha or receipt.get('tree') != tree or receipt.get('kind') != kind
            or not _positive_integer(receipt.get('runId')) or receipt['runId'] != run_id
            or not _positive_integer(receipt.get('runAttempt')) or receipt['runAttempt'] != run_attempt
            or receipt.get('testProfile') not in ('full', 'ui') or receipt.get('rulesVersion') != RULES_VERSION
            or not isinstance(receipt.get('image'), str)
            or not re.fullmatch(re.escape(IMAGE_PREFIXES[kind]) + '[0-9a-f]{64}', receipt['image'])):
        raise ReadinessError(receipt_code)
    return receipt


def resolve_readiness(sha, *, repo=TRUSTED_REPO, required_kinds=('worker', 'web'), api=None, download=None):
    """Return verified readiness or a stable ReadinessError; never deploy or poll.

    Tests inject api(path)->dict and download(path)->bytes. A pending/failed API
    graph stops the caller; an older successful run is never a fallback.
    """
    if (not isinstance(sha, str) or not SHA.fullmatch(sha) or repo != TRUSTED_REPO
            or not isinstance(required_kinds, (tuple, list)) or not required_kinds
            or not all(isinstance(kind, str) and kind in IMAGE_PREFIXES for kind in required_kinds)
            or len(set(required_kinds)) != len(required_kinds)):
        raise ReadinessError('readiness_input_invalid')
    api, download = api or github_api, download or download_artifact
    prefix = '/repos/' + TRUSTED_REPO
    tree = _main_commit(api, prefix, sha)
    latest_id = _latest_run_id(api, prefix, sha)
    run = _fetch(api, prefix + f'/actions/runs/{latest_id}')
    _trusted_run(run, sha, latest_id)
    jobs = _listed(api, prefix + f'/actions/runs/{latest_id}/jobs?filter=latest', 'jobs')
    proof_args = {'sha': sha, 'run_id': latest_id, 'run_attempt': run['run_attempt']}
    _job_passed(jobs, 'check', 'check', **proof_args)
    for kind in required_kinds:
        _job_passed(jobs, f'publish-{kind}-image', kind + '_publish', **proof_args)
    artifacts = _listed(api, prefix + f'/actions/runs/{latest_id}/artifacts', 'artifacts')
    target, proofs = {'sha': sha}, {}
    profiles = set()
    for kind in required_kinds:
        artifact = _artifact_for_kind(artifacts, kind, sha, run)
        # The API path is constructed from trusted repo + numeric ID. Never
        # follow archive_download_url supplied by a receipt/API payload.
        try:
            raw = download(prefix + f'/actions/artifacts/{artifact["id"]}/zip')
        except ReadinessError:
            raise
        except Exception:
            raise ReadinessError('artifact_download_failed') from None
        receipt = parse_image_artifact(raw, kind=kind, sha=sha, tree=tree,
                                       run_id=latest_id, run_attempt=run['run_attempt'])
        target[kind] = receipt['image']
        profiles.add(receipt['testProfile'])
        proofs[kind] = {**receipt, 'artifactId': artifact['id']}
    if len(profiles) != 1:
        raise ReadinessError('image_profiles_mismatch')
    if _main_commit(api, prefix, sha) != tree:
        raise ReadinessError('main_tree_changed')
    if _latest_run_id(api, prefix, sha) != latest_id:
        raise ReadinessError('ci_run_changed')
    final_run = _fetch(api, prefix + f'/actions/runs/{latest_id}')
    _trusted_run(final_run, sha, latest_id)
    if final_run['run_attempt'] != run['run_attempt']:
        raise ReadinessError('ci_run_changed')
    final_jobs = _listed(api, prefix + f'/actions/runs/{latest_id}/jobs?filter=latest', 'jobs')
    _job_passed(final_jobs, 'check', 'check', **proof_args)
    for kind in required_kinds:
        _job_passed(final_jobs, f'publish-{kind}-image', kind + '_publish', **proof_args)
    return {'schemaVersion': 1, 'target': target, 'tree': tree, 'checkPassed': True, 'imagesReady': True,
            'runId': latest_id, 'runAttempt': run['run_attempt'], 'profile': profiles.pop(),
            'rulesVersion': RULES_VERSION, 'kindProofs': proofs,
            'verifiedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
