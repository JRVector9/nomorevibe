#!/usr/bin/env python3
"""Explicit read-only PG17 observations and offline comparison; never activates DR."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

import report_contract as contract


PROCESS_TIMEOUT_SECONDS = 15
SQL_PATH = Path(__file__).with_name('inventory.sql')


class PreflightError(Exception):
    def __init__(self, code, process_exit=None):
        self.code = code
        self.process_exit = process_exit
        super().__init__(code)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's normal error echoes user arguments, which could contain a DSN.
        raise PreflightError('invalid_arguments')


def utc_now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def checked_url(value, expected_database, expected_user):
    contract.require(type(value) is str and len(value) <= 16384)
    value = value.removesuffix('\n')
    contract.require(value and not any(ord(c) < 33 for c in value))
    parsed = urlsplit(value)
    contract.require(parsed.scheme in ('postgres', 'postgresql') and parsed.hostname
                     and ',' not in parsed.hostname and parsed.port and not parsed.fragment)
    contract.require(parsed.username and parsed.path.startswith('/') and parsed.path != '/')
    contract.require(unquote(parsed.username) == expected_user
                     and unquote(parsed.path[1:]) == expected_database)
    query = parse_qsl(parsed.query, strict_parsing=True, keep_blank_values=True)
    contract.require(not query or len(query) == 1 and query[0][0] == 'sslmode'
                     and query[0][1] in ('disable', 'require', 'verify-ca', 'verify-full'))
    return value


def collect(database_url, *, side, label, expected_database, expected_user, psql='psql'):
    checked = checked_url(database_url, expected_database, expected_user)
    contract.text(label)
    contract.require(side in ('source', 'target'))
    executable = shutil.which(psql)
    if not executable:
        raise PreflightError('psql_unavailable')
    child_env = {'PATH': os.environ.get('PATH', ''), 'LC_ALL': 'C', 'PGDATABASE': checked,
                 'PGCONNECT_TIMEOUT': '5', 'PGAPPNAME': 'nomorevibe-oracle-dr-preflight',
                 'PGOPTIONS': '-c default_transaction_read_only=on'}
    command = [executable, '-X', '-q', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1',
               '-v', 'VERBOSITY=sqlstate']
    started_at = utc_now()
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, env=child_env, shell=False)
    except OSError:
        raise PreflightError('psql_unavailable') from None
    try:
        try:
            stdout, _stderr = process.communicate(SQL_PATH.read_text(), timeout=PROCESS_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise PreflightError('psql_timeout', process.returncode) from None
        except BaseException:
            if process.poll() is None:
                process.kill()
            process.communicate()
            raise
    finally:
        process.wait()
    if process.returncode:
        raise PreflightError('psql_failed', process.returncode)
    frames = [contract.load_json(line) for line in stdout.splitlines() if line.strip()]
    contract.require(len(frames) == 3)
    first, middle, last = frames
    contract.exact(first, ('frame', 'at', 'database'))
    contract.exact(middle, ('frame', 'catalog'))
    contract.exact(last, ('frame', 'at'))
    contract.require(first['frame'] == 'start' and middle['frame'] == 'inventory' and last['frame'] == 'end')
    contract.require(first['database']['name'] == expected_database and first['database']['user'] == expected_user)
    contract.exact(middle['catalog'], contract.CATALOG_KEYS)
    return contract.build_report({'database': first['database'], 'startedAt': first['at'],
                                  'finishedAt': last['at'], **middle['catalog']},
                                 side=side, label=label, client_started_at=started_at,
                                 client_finished_at=utc_now())


def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        commands = parser.add_subparsers(dest='command', required=True, parser_class=Parser)
        capture = commands.add_parser('capture')
        capture.add_argument('--side', required=True, choices=('source', 'target'))
        capture.add_argument('--label', required=True)
        capture.add_argument('--expect-database', required=True)
        capture.add_argument('--expect-user', required=True)
        capture.add_argument('--database-url-stdin', required=True, action='store_true')
        capture.add_argument('--psql', default='psql', help='Explicit psql executable; no connector auto-detection')
        compare = commands.add_parser('compare')
        compare.add_argument('--source', required=True, type=Path)
        compare.add_argument('--target', required=True, type=Path)
        args = parser.parse_args(argv)
        if args.command == 'capture':
            value = collect(sys.stdin.read(16385), side=args.side, label=args.label,
                            expected_database=args.expect_database, expected_user=args.expect_user, psql=args.psql)
        else:
            value = contract.compare_reports(contract.load_json(args.source.read_text()),
                                             contract.load_json(args.target.read_text()))
        print(json.dumps(value, sort_keys=True, allow_nan=False))
        return 0
    except (PreflightError, ValueError, OSError, KeyError, TypeError) as error:
        value = {'kind': 'nomorevibe-oracle-dr-error', 'code': error.code if isinstance(error, PreflightError)
                 else 'invalid_input_or_inventory', 'readiness': 'unknown', 'automaticDrAllowed': False}
        if isinstance(error, PreflightError) and error.process_exit is not None:
            value['processExit'] = error.process_exit
        print(json.dumps(value, sort_keys=True))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({'kind': 'nomorevibe-oracle-dr-error', 'code': 'interrupted',
                          'readiness': 'unknown', 'automaticDrAllowed': False}))
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
