#!/usr/bin/env python3
"""Fail-closed new-job detection and read-only scheduler registration proof."""

import importlib.util
import json
import math
import re
import subprocess
import time
from pathlib import Path


_SPEC = importlib.util.spec_from_file_location('catalog_shared', Path(__file__).with_name('deploy_shared_images.py'))
shared = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(shared)
CATALOG_PATH = 'lib/jobs/catalog.ts'
SHA = re.compile(r'[a-f0-9]{40}')
NAME = re.compile(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*')
TOKENS = re.compile(r'''\s+|//[^\n]*|/\*[\s\S]*?\*/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+(?:_[0-9]+)*|[^\s]''')
REGISTRATION_SCRIPT = (
    "import postgres from 'postgres';"
    "const names=JSON.parse(process.argv[1]);"
    "const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false,connect_timeout:10,onnotice:()=>{}});"
    "try{const rows=await sql.begin('read only',async tx=>{await tx`SET LOCAL statement_timeout='5s'`;"
    "return tx`SELECT name FROM public.jobs WHERE name=ANY(${sql.array(names)}::text[]) ORDER BY name`;});"
    "console.log(JSON.stringify({names:rows.map(row=>row.name)}));}finally{await sql.end({timeout:5});}")


class CatalogError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _names(names):
    if (not isinstance(names, (list, tuple)) or any(not isinstance(name, str) or len(name) > 128
            or not NAME.fullmatch(name) for name in names) or len(set(names)) != len(names)):
        raise CatalogError('catalog_names_invalid')
    return list(names)


def _literal(tokens):
    if (len(tokens) != 1 or len(tokens[0]) < 2 or tokens[0][0] not in ('"', "'")
            or tokens[0][-1] != tokens[0][0] or '\\' in tokens[0]):
        raise CatalogError('catalog_shape_unknown')
    return tokens[0][1:-1]


def catalog_names(source):
    """Recognize the current literal metadata format; never execute TypeScript.

    This deliberately supports only flat object literals and literal interval
    products. Spreads, calls, computed properties, aliases and unknown fields
    require explicit parser review instead of silently missing a job.
    """
    if not isinstance(source, str) or len(source) > 4 * 1024 * 1024:
        raise CatalogError('catalog_shape_unknown')
    tokens = [match[0] for match in TOKENS.finditer(source)
              if not match[0].isspace() and not match[0].startswith(('//', '/*'))]
    declarations = [index for index in range(len(tokens) - 2)
                    if tokens[index:index + 3] == ['export', 'const', 'JOB_CATALOG']]
    if len(declarations) != 1:
        raise CatalogError('catalog_shape_unknown')
    declaration = declarations[0]
    index = declaration + 3
    if index >= len(tokens) or tokens[index] not in (':', '='):
        raise CatalogError('catalog_shape_unknown')
    depth = 0
    while index < len(tokens) and tokens[index] != '=':
        token = tokens[index]
        if token == '{': depth += 1
        if token == '}': depth -= 1
        if depth < 0 or token in ('export', 'const', 'let', '(') or token == ';' and depth == 0:
            raise CatalogError('catalog_shape_unknown')
        index += 1
    if index >= len(tokens) or depth != 0 or tokens[index:index + 2] != ['=', '[']:
        raise CatalogError('catalog_shape_unknown')
    index += 2
    names = []
    try:
        while tokens[index] != ']':
            if tokens[index] != '{': raise CatalogError('catalog_shape_unknown')
            index += 1
            fields = {}
            while tokens[index] != '}':
                key = tokens[index]
                if key not in ('name', 'role', 'intervalMs', 'lane', 'batchVersion') or key in fields:
                    raise CatalogError('catalog_shape_unknown')
                if tokens[index + 1] != ':': raise CatalogError('catalog_shape_unknown')
                index += 2
                start = index
                while tokens[index] not in (',', '}'): index += 1
                value = tokens[start:index]
                if key in ('name', 'role', 'lane'):
                    fields[key] = _literal(value)
                    _names([fields[key]])
                elif key == 'batchVersion':
                    if value != ['1']: raise CatalogError('catalog_shape_unknown')
                    fields[key] = 1
                else:
                    if value != ['null'] and not re.fullmatch(
                            r'[0-9]+(?:_[0-9]+)*(?:\*[0-9]+(?:_[0-9]+)*)*', ''.join(value)):
                        raise CatalogError('catalog_shape_unknown')
                    fields[key] = value
                if tokens[index] == ',': index += 1
            if not {'name', 'role', 'intervalMs'}.issubset(fields):
                raise CatalogError('catalog_shape_unknown')
            names.append(fields['name'])
            index += 1
            if tokens[index] == ',': index += 1
            elif tokens[index] != ']': raise CatalogError('catalog_shape_unknown')
        end = index + 1
        if tokens[end] != ';': raise CatalogError('catalog_shape_unknown')
        # The existing exports read with map/filter or a for-of loop. Do not
        # accept an append, indexed mutation, or alias as an exhaustive literal.
        for position, token in enumerate(tokens):
            if token != 'JOB_CATALOG' or position == declaration + 2:
                continue
            if position > end and (tokens[position + 1:position + 3] in (['.', 'map'], ['.', 'filter'])
                                  or tokens[position - 1] == 'of'):
                continue
            raise CatalogError('catalog_shape_unknown')
    except IndexError:
        raise CatalogError('catalog_shape_unknown') from None
    return _names(names)


def _git(repo, *args):
    try:
        result = subprocess.run(['git', '--no-replace-objects', '-C', str(repo), *args],
                                capture_output=True, timeout=30, check=True)
        return result.stdout
    except (OSError, subprocess.SubprocessError):
        raise CatalogError('catalog_history_unproven') from None


def catalog_additions(snapshot, sha, repo):
    """Compare every actual baseline's exact catalog tree to the target tree."""
    baseline = snapshot.get('baseline') if isinstance(snapshot, dict) else None
    if (not isinstance(sha, str) or not SHA.fullmatch(sha) or not isinstance(baseline, dict) or not baseline):
        raise CatalogError('catalog_baseline_invalid')
    releases = set()
    for state in baseline.values():
        release = state.get('release') if isinstance(state, dict) else None
        if not isinstance(release, str) or not SHA.fullmatch(release):
            raise CatalogError('catalog_baseline_invalid')
        releases.add(release)
    for release in releases | {sha}:
        if _git(repo, 'rev-parse', '--verify', release + '^{commit}').strip() != release.encode():
            raise CatalogError('catalog_history_unproven')
    additions, target_names = set(), None
    for release in sorted(releases):
        _git(repo, 'merge-base', '--is-ancestor', release, sha)
        changed = _git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z',
                        release, sha, '--', CATALOG_PATH)
        if not changed:
            continue
        if changed != (CATALOG_PATH + '\0').encode():
            raise CatalogError('catalog_history_unproven')
        try:
            previous_names = catalog_names(_git(repo, 'show', release + ':' + CATALOG_PATH).decode('utf-8'))
            if target_names is None:
                target_names = catalog_names(_git(repo, 'show', sha + ':' + CATALOG_PATH).decode('utf-8'))
        except UnicodeError:
            raise CatalogError('catalog_shape_unknown') from None
        additions.update(set(target_names) - set(previous_names))
    return sorted(additions)


def _unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('duplicate_key')
        result[key] = value
    return result


def verify_registered(client, names, *, timeout=60, pause=2, monotonic=None, sleep=None):
    """Wait only for safe pending rows; unreadable/foreign results stop at once."""
    names = _names(names)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
           or value <= 0 for value in (timeout, pause)):
        raise CatalogError('catalog_wait_invalid')
    if not names:
        return {'registered': True, 'requestedCount': 0, 'registeredCount': 0, 'productionMutations': 0, 'skipped': True}
    monotonic, sleep = monotonic or time.monotonic, sleep or time.sleep
    deadline = monotonic() + timeout
    try:
        app = client.app('publisher-m3')
        service = app.get('appName') if isinstance(app, dict) else None
        if not isinstance(service, str) or not re.fullmatch(r'[a-z0-9-]+', service):
            raise ValueError('service_invalid')
    except Exception:
        raise CatalogError('catalog_registration_unknown') from None
    while monotonic() < deadline:
        try:
            raw = shared.ssh_python(shared.M3[1], shared.REMOTE_MIGRATIONS, service,
                json.dumps(names, separators=(',', ':')), REGISTRATION_SCRIPT,
                timeout=min(60, deadline - monotonic()))
            state = json.loads(raw, object_pairs_hook=_unique_json)
            if not isinstance(state, dict) or set(state) != {'names'}:
                raise ValueError('state_invalid')
            registered = _names(state['names'])
            if not set(registered).issubset(names):
                raise ValueError('unexpected_job')
        except Exception:
            raise CatalogError('catalog_registration_unknown') from None
        if set(registered) == set(names):
            return {'registered': True, 'requestedCount': len(names), 'registeredCount': len(registered),
                    'productionMutations': 0}
        remaining = deadline - monotonic()
        if remaining > 0:
            sleep(min(pause, remaining))
    raise CatalogError('catalog_jobs_not_registered')
