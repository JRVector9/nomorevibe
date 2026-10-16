#!/usr/bin/env python3
"""Explicit isolated PG17 logical rehearsal. Never installs, starts workers, or enables DR."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import selectors
import shutil
import stat
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import restore_contract as contract
from restore_contract import RestoreError

DOCKER = '/opt/homebrew/bin/docker'
DATABASE = 'nomorevibe_test'
USER = 'nomorevibe'
CHILD_SECONDS = 60
ACTIVE_CHILDREN = set()
SQL_PATH = Path(__file__).with_name('restore_inventory.sql')
PSQL = ['psql', '-X', '-q', '-A', '-t', '-w', '-U', USER, '-d', DATABASE,
        '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate']
INFO_SQL = """SELECT jsonb_build_object('database',current_database(),'user',current_user,
 'version',current_setting('server_version_num')::int,'recovery',pg_is_in_recovery(),
 'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
 'size',(SELECT pg_database_size(current_database()))::text,
 'clients',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()));"""
EMPTY_SQL = """SELECT jsonb_build_object('objects',
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')+
 (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')+
 (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')+
 (SELECT count(*) FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema')+
 (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public'))+
 (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql')+
 (SELECT count(*) FROM pg_default_acl)+(SELECT count(*) FROM pg_largeobject_metadata)+
 (SELECT count(*) FROM pg_publication)+(SELECT count(*) FROM pg_subscription)+
 (SELECT count(*) FROM pg_event_trigger)+(SELECT count(*) FROM pg_foreign_server));"""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise RestoreError('invalid_arguments')


def finish_errors(original, cleanup):
    errors = ([original] if original is not None else []) + cleanup
    if len(errors) == 1:
        raise errors[0]
    if errors:
        raise BaseExceptionGroup('rehearsal_failed', errors)


def safe_error(error):
    def entry(item):
        if isinstance(item, BaseExceptionGroup):
            return [part for child in item.exceptions for part in entry(child)]
        return [{'code': item.code if isinstance(item, RestoreError) else
                 'interrupted' if isinstance(item, KeyboardInterrupt) else 'local_io_or_contract_error',
                 **({'processExit': item.process_exit} if isinstance(item, RestoreError)
                    and item.process_exit is not None else {})}]
    return {'kind': 'local-logical-restore-error', 'errors': entry(error),
            'readiness': 'unknown', 'automaticDrAllowed': False}


def _private_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb', buffering=0)


def _write_all(stream, value):
    remaining = memoryview(value)
    while remaining:
        written = stream.write(remaining)
        if not written:
            raise RestoreError('short_write')
        remaining = remaining[written:]


def _run_child(argv, output, *, limit, input_path=None, input_bytes=None):
    """One settled local child; both pipes drain even after a cap/write/timeout failure."""
    contract.positive(limit)
    contract.require(not (input_path is not None and input_bytes is not None))
    started, failure, cleanup, process = time.monotonic(), None, [], None
    handles, selector = [], selectors.DefaultSelector()
    try:
        sink = _private_file(output)
        handles.append(sink)
        errsink = _private_file(str(output) + '.stderr')
        handles.append(errsink)
        incoming = os.fdopen(os.open(input_path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') if input_path is not None else None
        if incoming:
            handles.append(incoming)
            contract.require(stat.S_ISREG(os.fstat(incoming.fileno()).st_mode), 'unsafe_archive_input')
        # Docker context is local configuration only. No PG URL/password/env fallback is forwarded.
        env = {key: os.environ[key] for key in ('PATH', 'HOME') if key in os.environ}
        env.update({'LC_ALL': 'C'})
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, shell=False, env=env)
        ACTIVE_CHILDREN.add(process.pid)
        for pipe, kind in ((process.stdout, 'out'), (process.stderr, 'err')):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, kind)
        pending = input_bytes or b''
        exhausted = incoming is None
        os.set_blocking(process.stdin.fileno(), False)
        selector.register(process.stdin, selectors.EVENT_WRITE, 'in')
        amounts = {'out': 0, 'err': 0}
        stopping_at = None
        while selector.get_map() or process.poll() is None:
            now = time.monotonic()
            if failure is None and now - started > CHILD_SECONDS:
                failure = RestoreError('child_timeout')
            if failure is not None and stopping_at is None:
                stopping_at = now
                if process.poll() is None:
                    try:
                        process.terminate()
                    except OSError as error:
                        cleanup.append(error)
            if stopping_at is not None and now - stopping_at > 2 and process.poll() is None:
                try:
                    process.kill()
                except OSError as error:
                    cleanup.append(error)
            if stopping_at is not None and now - stopping_at > 5:
                cleanup.append(RestoreError('child_pipe_drain_unconfirmed'))
                break
            try:
                events = selector.select(.05)
            except BaseException as error:
                if failure is None:
                    failure = error
                continue
            for key, _ in events:
                pipe, kind = key.fileobj, key.data
                try:
                    if kind == 'in':
                        if failure is not None:
                            selector.unregister(pipe)
                            pipe.close()
                            continue
                        if not pending and not exhausted:
                            pending = incoming.read(65536)
                            exhausted = not pending
                        if pending:
                            written = os.write(pipe.fileno(), pending[:65536])
                            pending = pending[written:]
                        elif exhausted:
                            selector.unregister(pipe)
                            pipe.close()
                    else:
                        block = os.read(pipe.fileno(), 65536)
                        if not block:
                            selector.unregister(pipe)
                            pipe.close()
                            continue
                        amounts[kind] += len(block)
                        cap = limit if kind == 'out' else 1048576
                        if amounts[kind] > cap:
                            if failure is None:
                                failure = RestoreError('stdout_limit' if kind == 'out' else 'stderr_limit')
                        elif failure is None:
                            _write_all(sink if kind == 'out' else errsink, block)
                except BrokenPipeError:
                    selector.unregister(pipe)
                    pipe.close()
                except BlockingIOError:
                    continue
                except BaseException as error:
                    if failure is None:
                        failure = error
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.wait()
            cleanup.append(error)
        if failure is None and process.returncode:
            failure = RestoreError('child_failed', process.returncode)
    except BaseException as error:
        if failure is None:
            failure = error
    finally:
        if process is not None:
            if process.poll() is None:
                try:
                    process.kill()
                    process.wait()
                except BaseException as error:
                    cleanup.append(error)
            for pipe in (process.stdin, process.stdout, process.stderr):
                try:
                    pipe.close()
                except BaseException as error:
                    cleanup.append(error)
            ACTIVE_CHILDREN.discard(process.pid)
        selector.close()
        for handle in reversed(handles):
            try:
                handle.close()
            except BaseException as error:
                cleanup.append(error)
    finish_errors(failure, cleanup)
    return {'exit': process.returncode, 'elapsedSeconds': time.monotonic() - started}


def _json_file(path, value):
    with _private_file(path) as stream:
        _write_all(stream, json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False).encode() + b'\n')


def _docker(identity, tag, command):
    return [DOCKER, 'exec', '-i', '-e', 'PGAPPNAME=' + tag, identity['id'], *command]


def _psql(identity, tag, sql, output):
    _run_child(_docker(identity, tag, PSQL), output, limit=67108864, input_bytes=sql.encode())
    return contract.load_json(Path(output).read_bytes())


def inspect_identity(identity, output):
    projection = ('{"Id":{{json .Id}},"Name":{{json .Name}},'
                  '"Config":{"Image":{{json .Config.Image}},"Labels":{"nomorevibe.scope":'
                  '{{json (index .Config.Labels "nomorevibe.scope")}}}},'
                  '"State":{"Running":{{json .State.Running}}},'
                  '"HostConfig":{"Memory":{{json .HostConfig.Memory}}},'
                  '"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}},'
                  '"Mounts":{{json .Mounts}}}')
    _run_child([DOCKER, 'inspect', '--type', 'container', '--format', projection, identity['id']],
               output, limit=1048576)
    values = contract.load_json(Path(output).read_bytes())
    contract.require(type(values) is dict, 'container_identity_mismatch')
    value = values
    contract.require(value['Id'] == identity['id'] and value['Name'] == '/' + identity['name']
                     and value['Config']['Image'] == identity['image'] and value['State']['Running'] is True
                     and value['Config']['Labels'].get('nomorevibe.scope') == identity['scope']
                     and value['HostConfig']['Memory'] == identity['memoryBytes'], 'container_identity_mismatch')
    bindings = value['NetworkSettings']['Ports']
    contract.require(bindings == {'5432/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(identity['port'])}]}, 'container_identity_mismatch')
    mounts = value['Mounts']
    contract.require(len(mounts) == 1 and mounts[0]['Type'] == 'volume'
                     and mounts[0]['Name'] == identity['volume'] and mounts[0]['RW'] is True
                     and mounts[0]['Destination'] == '/var/lib/postgresql/data', 'container_identity_mismatch')


def _info(identity, tag, output):
    value = _psql(identity, tag, INFO_SQL, output)
    contract.require(value['database'] == DATABASE and value['user'] == USER and value['owner'] == USER
                     and 170000 <= value['version'] < 180000 and value['recovery'] is False,
                     'database_identity_mismatch')
    contract.require(value['clients'] == 0, 'database_not_quiescent')
    return value


def _capture(identity, tag, output):
    _run_child(_docker(identity, tag, PSQL), output, limit=268435456,
               input_bytes=SQL_PATH.read_bytes())
    return contract.parse_inventory(output)


def _supported(value):
    catalog = value['catalog']
    contract.require(all(type(count) is int and count == 0 for count in catalog['unsupported'].values()), 'unsupported_source_objects')
    for rows in catalog.values():
        if isinstance(rows, list):
            for row in rows:
                contract.require(row.get('owner', USER) in (USER, 'pg_database_owner'), 'unsupported_owner')


def _backends(identity, tag, output):
    # A new observer is not counted. Every tagged dump/restore/capture backend must have ended.
    value = _psql(identity, tag + '-observer',
        "SELECT jsonb_build_object('pending',count(*)) FROM pg_stat_activity WHERE application_name="
        + "'" + tag + "' AND pid<>pg_backend_pid();", output)
    contract.require(value == {'pending': 0}, 'backend_settlement_unconfirmed')


def run(source, target, output_directory, *, max_source_bytes, max_archive_bytes, minimum_free_bytes):
    source, target = contract.parse_identity(source), contract.parse_identity(target)
    contract.check_pair(source, target)
    for value in (max_source_bytes, max_archive_bytes, minimum_free_bytes):
        contract.positive(value)
    requested = Path(output_directory)
    contract.require(requested.is_absolute() and requested.name not in ('', '.', '..')
                     and '..' not in requested.parts, 'unsafe_output_parent')
    # macOS /tmp and /var are OS-managed aliases; no caller-created parent symlink is followed.
    for parent_part in reversed(requested.parents):
        if parent_part.is_symlink():
            contract.require(str(parent_part) in ('/tmp', '/var'), 'unsafe_output_parent')
    parent = requested.parent.resolve(strict=True)
    contract.require(parent.stat().st_uid in (0, os.getuid()), 'unsafe_output_parent')
    directory = parent / requested.name
    directory.mkdir(mode=0o700)
    tag = 'nvrb-' + uuid.uuid4().hex
    original, cleanup, result = None, [], None
    verified = set()
    try:
        for side, own in (('source', source), ('target', target)):
            inspect_identity(own, directory / (side + '-inspect.json'))
            verified.add(side)
            _info(own, tag, directory / (side + '-info.json'))
            for tool in ('psql', 'pg_dump', 'pg_restore'):
                version = directory / (side + '-' + tool + '-version.txt')
                _run_child(_docker(own, tag, [tool, '--version']), version, limit=4096)
                contract.require(version.read_text().startswith(tool + ' (PostgreSQL) 17.'), 'cli_version_mismatch')
        contract.assert_empty(_psql(target, tag, EMPTY_SQL, directory / 'target-empty-before.json'))
        before = _capture(source, tag, directory / 'source-before.jsonl')
        _supported(before)
        _json_file(directory / 'source-before-summary.json', before)
        info = _info(source, tag, directory / 'source-size.json')
        contract.require(int(info['size']) <= max_source_bytes, 'source_size_limit')
        spaces = {'archiveHostFreeBytes': shutil.disk_usage(directory).free}
        for side, own in (('source', source), ('target', target)):
            path = directory / (side + '-disk.txt')
            _run_child(_docker(own, tag, ['df', '-Pk', '/var/lib/postgresql/data']), path, limit=8192)
            lines = path.read_text().splitlines()
            contract.require(len(lines) == 2 and len(lines[1].split()) >= 6, 'disk_space_unknown')
            spaces[side + 'VolumeFreeBytes'] = int(lines[1].split()[3]) * 1024
        _json_file(directory / 'space.json', spaces)
        contract.require(all(value >= minimum_free_bytes for value in spaces.values()), 'insufficient_free_space')
        partial, archive = directory / 'archive.partial', directory / 'archive.dump'
        dump = _run_child(_docker(source, tag, ['pg_dump', '-Fc', '-b', '-w', '-U', USER, '-d', DATABASE]),
                          partial, limit=max_archive_bytes)
        receipt = contract.archive_receipt(partial)
        # Hard-link publication fails if a path exists; no rename-overwrite race.
        os.link(partial, archive, follow_symlinks=False)
        partial.unlink()
        _json_file(directory / 'archive-receipt.json', receipt)
        _run_child(_docker(target, tag, ['pg_restore', '--list']), directory / 'archive-list.txt',
                   input_path=archive, limit=67108864)
        contract.verify_archive(archive, receipt)
        inspect_identity(target, directory / 'target-reinspect.json')
        _info(target, tag, directory / 'target-reinfo.json')
        contract.assert_empty(_psql(target, tag, EMPTY_SQL, directory / 'target-empty-final.json'))
        contract.verify_archive(archive, receipt)
        restored = _run_child(_docker(target, tag, ['pg_restore', '--exit-on-error', '--single-transaction',
                               '-w', '-U', USER, '-d', DATABASE]), directory / 'restore.stdout',
                              input_path=archive, limit=67108864)
        verification_started = time.monotonic()
        after = _capture(source, tag, directory / 'source-after.jsonl')
        destination = _capture(target, tag, directory / 'target-after.jsonl')
        _json_file(directory / 'source-after-summary.json', after)
        _json_file(directory / 'target-after-summary.json', destination)
        contract.require(before == after, 'source_changed')
        result = contract.compare_snapshots(before, destination)
        if any(row['name'] == 'vector' for row in before['catalog']['extensions']):
            vector = _psql(target, tag, "SELECT jsonb_build_object('distance','[1,2,3]'::public.vector <-> '[1,2,3]'::public.vector);", directory / 'vector.json')
            contract.require(vector == {'distance': 0}, 'extension_operation_mismatch')
        result.update({'archive': receipt, 'source': source, 'target': target,
                       'finishedAt': datetime.now(timezone.utc).isoformat(),
                       'dumpSeconds': dump['elapsedSeconds'], 'restoreSeconds': restored['elapsedSeconds'],
                       'verifySeconds': time.monotonic() - verification_started, 'space': spaces})
    except BaseException as error:
        original = error
    finally:
        for side, own in (('source', source), ('target', target)):
            if side not in verified:
                continue
            try:
                _backends(own, tag, directory / (side + '-backends.json'))
            except BaseException as error:
                cleanup.append(error)
    try:
        finish_errors(original, cleanup)
    except BaseException as error:
        try:
            _json_file(directory / 'error.json', safe_error(error))
        except BaseException as save_error:
            finish_errors(error, [save_error])
        raise
    _json_file(directory / 'report.json', result)
    return result


def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        parser.add_argument('command', choices=('run',))
        for field in ('source-identity', 'target-identity', 'output-directory'):
            parser.add_argument('--' + field, required=True)
        for field in ('max-source-bytes', 'max-archive-bytes', 'minimum-free-bytes'):
            parser.add_argument('--' + field, required=True, type=int)
        args = parser.parse_args(argv)
        value = run(contract.read_identity(args.source_identity), contract.read_identity(args.target_identity),
                    args.output_directory, max_source_bytes=args.max_source_bytes,
                    max_archive_bytes=args.max_archive_bytes, minimum_free_bytes=args.minimum_free_bytes)
        print(json.dumps(value, sort_keys=True))
        return 0
    except BaseException as error:
        print(json.dumps(safe_error(error), sort_keys=True))
        return 130 if isinstance(error, KeyboardInterrupt) else 2


if __name__ == '__main__':
    raise SystemExit(main())
