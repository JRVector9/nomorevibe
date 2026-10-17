"""PR14d 논리 복제 도구 공통부. 이 모듈의 어떤 값도 실행 권한이나 DR 준비 완료를 뜻하지 않는다."""
import json
import os
import re
import shutil
import subprocess
import sys

import preflight
import report_contract as contract
from preflight import Parser, PreflightError, utc_now

UNKNOWN = ['replication_continuity', 'rpo_rto', 'writer_fencing', 'external_call_drain', 'patroni_slot_management',
           'oracle_disk_and_arm_binaries', 'cross_host_clock', 'promotion']
NAME = re.compile(r'[a-z_][a-z0-9_]{0,62}')
LSN = re.compile(r'([0-9A-F]{1,8})/([0-9A-F]{1,8})')
# 세션 출력 형식을 양쪽에서 같게 고정한다. 행 hash가 서버 기본값에 따라 달라지지 않게 한다.
SESSION_SQL = """SET LOCAL statement_timeout = '{timeout}s';
SET LOCAL lock_timeout = '1s';
SET LOCAL search_path = pg_catalog;
SET LOCAL TimeZone = 'UTC';
SET LOCAL DateStyle = 'ISO, YMD';
SET LOCAL IntervalStyle = 'postgres';
SET LOCAL extra_float_digits = 1;
SET LOCAL bytea_output = 'hex';
SET LOCAL standard_conforming_strings = on;
SET LOCAL client_connection_check_interval = '1s';
"""
DB_CLOCK = "pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"
DATABASE_SQL = """pg_catalog.jsonb_build_object('name', pg_catalog.current_database(),
    'oid', (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()),
    'systemIdentifier', (SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
    'user', current_user, 'serverVersionNum', pg_catalog.current_setting('server_version_num')::integer,
    'inRecovery', pg_catalog.pg_is_in_recovery(), 'readOnly', pg_catalog.current_setting('transaction_read_only') = 'on')"""
DATABASE_KEYS = ('name', 'oid', 'systemIdentifier', 'user', 'serverVersionNum', 'inRecovery', 'readOnly')


def name(value):
    contract.require(type(value) is str and NAME.fullmatch(value))
    return value


def ident(value):
    contract.text(value)
    return '"' + value.replace('"', '""') + '"'


def qualified(schema, relation):
    return ident(schema) + '.' + ident(relation)


def literal(value):
    contract.require(type(value) is str and '\x00' not in value)
    return "'" + value.replace("'", "''") + "'"


def lsn(value):
    contract.require(type(value) is str)
    match = LSN.fullmatch(value)
    contract.require(match)
    return (int(match.group(1), 16) << 32) + int(match.group(2), 16)


def optional_lsn(value):
    return None if value is None else lsn(value)


def nonnegative(value, maximum=2 ** 63 - 1):
    contract.integer(value, 0, maximum)
    return value


def database(value, expected_database=None, expected_user=None):
    contract.exact(value, DATABASE_KEYS)
    contract.text(value['name'])
    contract.text(value['user'])
    contract.integer(value['oid'], 1)
    contract.require(type(value['systemIdentifier']) is str and re.fullmatch(r'[1-9][0-9]{0,19}', value['systemIdentifier']))
    contract.integer(value['serverVersionNum'], 170000, 179999)
    contract.boolean_fields(value, ('inRecovery', 'readOnly'))
    contract.require(expected_database is None or value['name'] == expected_database)
    contract.require(expected_user is None or value['user'] == expected_user)
    return value


def same_database(a, b):
    return all(a[key] == b[key] for key in ('name', 'oid', 'systemIdentifier'))


def run_psql(database_url, sql, *, expected_database, expected_user, psql, app, read_only, timeout):
    """고정 SQL을 명시한 psql 하나로 실행한다. URL은 child env에만 두고 stderr/DSN은 출력하지 않는다."""
    checked = preflight.checked_url(database_url, expected_database, expected_user)
    executable = shutil.which(psql)
    if not executable:
        raise PreflightError('psql_unavailable')
    env = {'PATH': os.environ.get('PATH', ''), 'LC_ALL': 'C', 'PGDATABASE': checked, 'PGCONNECT_TIMEOUT': '5',
           'PGAPPNAME': app}
    if read_only:
        env['PGOPTIONS'] = '-c default_transaction_read_only=on'
    command = [executable, '-X', '-q', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate']
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, env=env, shell=False)
    except OSError:
        raise PreflightError('psql_unavailable') from None
    try:
        try:
            stdout, _stderr = process.communicate(sql, timeout=timeout)
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
    return [contract.load_json(line) for line in stdout.splitlines() if line.strip()]


def frames_by_name(frames, names):
    """frame 이름은 한 번씩만, 지정한 순서대로 와야 한다(반복 frame은 목록으로 모은다)."""
    result = {}
    for frame in frames:
        contract.require(type(frame) is dict and type(frame.get('frame')) is str)
        key = frame['frame']
        contract.require(key in names)
        if names[key] == 'many':
            result.setdefault(key, []).append(frame)
        else:
            contract.require(key not in result)
            result[key] = frame
    contract.require(all(key in result for key, kind in names.items() if kind == 'one'))
    return result


def load_file(path):
    with open(path, encoding='utf-8') as stream:
        return contract.load_json(stream.read(64 * 1024 * 1024))


def connection_arguments(parser):
    parser.add_argument('--database-url-stdin', required=True, action='store_true')
    parser.add_argument('--expect-database', required=True)
    parser.add_argument('--expect-user', required=True)
    parser.add_argument('--psql', default='psql', help='Explicit psql executable; no connector auto-detection')
    parser.add_argument('--timeout-seconds', type=int, default=30, help='statement_timeout; process limit is this + 15s')


def setting_bytes(setting):
    """pg_settings의 setting/unit을 byte로 바꾼다. 음수(-1 등 무제한)는 그대로 둔다."""
    raw, unit = int(setting['setting']), setting['unit']
    if raw < 0:
        return raw
    return raw * {None: 1, 'B': 1, 'kB': 1024, '8kB': 8192, 'MB': 1024 ** 2, 'GB': 1024 ** 3}[unit]


def checked_timeout(value):
    contract.integer(value, 1, 3600)
    return value


def cli(run, argv=None):
    """모든 실패는 고정 code JSON과 exit2다. 예외 원문·stderr·DSN은 출력하지 않는다.
    run은 값 또는 (값, exit code)를 돌려준다. 막힌 결과(예: blocker 있는 plan)는 exit3이다."""
    try:
        result = run(argv)
        value, code = result if type(result) is tuple else (result, 0)
        print(json.dumps(value, sort_keys=True, allow_nan=False, ensure_ascii=False))
        return code
    except (PreflightError, ValueError, OSError, KeyError, TypeError) as error:
        value = {'kind': 'nomorevibe-oracle-dr-error', 'code': error.code if isinstance(error, PreflightError)
                 else 'invalid_input_or_observation', 'readiness': 'unknown', 'automaticDrAllowed': False}
        if isinstance(error, PreflightError) and error.process_exit is not None:
            value['processExit'] = error.process_exit
        print(json.dumps(value, sort_keys=True))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({'kind': 'nomorevibe-oracle-dr-error', 'code': 'interrupted', 'readiness': 'unknown',
                          'automaticDrAllowed': False}))
        return 130


def read_url():
    return sys.stdin.read(16385)


__all__ = ['Parser', 'PreflightError', 'utc_now']
