#!/usr/bin/env python3
"""Oracle 활성화 runbook 의 명령 점검. 읽기 전용이며 문서의 명령은 하나도 실행하지 않는다.

bash·sh 블록은 `bash -n` 으로 구문만 읽는다. 블록이 가리키는 저장소 파일·하위 명령·옵션·--role/--job 값,
psql -v 변수와 SQL 의 :변수, systemd unit 템플릿, env 블록의 키가 코드에 실제로 있는지 grep 으로 대조한다.
이름과 구문만 보는 점검이라 명령이 운영에서 성공한다는 증거가 아니다.

끝 코드: 0 = 문제 없음, 1 = 문제 있음, 2 = 문서를 읽지 못함.
"""
import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DOC = ROOT / 'docs/operations/2026-10-17-oracle-activation-runbook.md'
FENCE = re.compile(r'^```([A-Za-z0-9_-]*)[^\n]*\n(.*?)^```[ \t]*$', re.M | re.S)
SHELL_LANGUAGES = ('bash', 'sh')
REPO_PATH = re.compile(r'(?:^|/)((?:deploy|scripts|lib)/[\w.@/-]+\.(?:py|ts|mjs|sql))$')
UNIT = re.compile(r'^(nomorevibe-core(?:-[a-z]+)?)(@[\w.*-]*)?\.(service|timer|slice)$')
ENV_LINE = re.compile(r'^([A-Z][A-Z0-9_]*)=')
SUBCOMMAND = re.compile(r'^[a-z][a-z0-9-]*$')
PY_IMPORT = re.compile(r'^\s*(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)', re.M)
SQL_VARIABLE = re.compile(r'(?<![:\w]):([a-z_][a-z0-9_]*)\b')
SEPARATORS = {'|', '||', '&&', ';', '&'}
REDIRECTS = {'>', '>>', '<', '<<', '>&', '<&'}
VALUE_OPTIONS = ('role', 'job')
VALUE_SOURCES = ('lib/jobs/batches.ts',)
CODE_DIRS = ('lib', 'scripts', 'deploy')
CODE_SUFFIXES = {'.ts', '.mjs', '.js', '.py', '.sh', '.sql', '.service', '.timer', '.slice', '.example'}


def extract_blocks(text):
    """(언어, 본문, 본문 첫 줄 번호) 목록."""
    blocks = []
    for match in FENCE.finditer(text):
        start = text.count('\n', 0, match.start(2)) + 1
        blocks.append((match.group(1).lower(), match.group(2), start))
    return blocks


def bash_syntax(body):
    """bash -n 결과. 문제가 없으면 None."""
    try:
        result = subprocess.run(['bash', '-n'], input=body, text=True, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f'bash_unavailable:{type(error).__name__}'
    if result.returncode == 0:
        return None
    return (result.stderr.strip().splitlines() or ['bash -n failed'])[-1]


def logical_lines(body, start):
    """줄 끝 백슬래시로 이어진 줄을 한 명령으로 합친다."""
    lines, buffer, first = [], '', None
    for offset, line in enumerate(body.split('\n')):
        if first is None:
            first = start + offset
        if line.endswith('\\'):
            buffer += line[:-1] + ' '
            continue
        buffer += line
        if buffer.strip():
            lines.append((first, buffer))
        buffer, first = '', None
    if buffer.strip():
        lines.append((first, buffer))
    return lines


def segments(line):
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    lexer.commenters = '#'
    current, result = [], []
    for token in lexer:
        if token in SEPARATORS:
            if current:
                result.append(current)
            current = []
        else:
            current.append(token)
    if current:
        result.append(current)
    return result


class Repository:
    def __init__(self, root):
        self.root = Path(root)
        self._texts = {}
        self._corpus = None

    def text(self, relative):
        if relative not in self._texts:
            path = self.root / relative
            self._texts[relative] = path.read_text(encoding='utf-8') if path.is_file() else None
        return self._texts[relative]

    def script_text(self, relative):
        """대상 파일과, python 이면 그 파일이 import 하는 같은 폴더 모듈의 본문."""
        own = self.text(relative)
        if own is None or not relative.endswith('.py'):
            return own
        folder = Path(relative).parent
        siblings = [self.text(str(folder / f'{name}.py')) for name in PY_IMPORT.findall(own)]
        return '\n'.join([own, *[value for value in siblings if value]])

    def corpus(self):
        if self._corpus is None:
            parts = []
            for directory in CODE_DIRS:
                base = self.root / directory
                if base.is_dir():
                    parts.extend(path.read_text(encoding='utf-8', errors='replace') for path in sorted(base.rglob('*'))
                                 if path.is_file() and path.suffix in CODE_SUFFIXES)
            self._corpus = '\n'.join(parts)
        return self._corpus


def _quoted(name, text):
    return re.search(r'[\'"]' + re.escape(name) + r'[\'"]', text) is not None


def _flag_known(name, text, typescript):
    if re.search(r'--' + re.escape(name) + r'(?![A-Za-z0-9-])', text):
        return True
    # TS CLI 는 --role= 을 value('role') 이나 ALLOWED 의 'role' 처럼 이름만으로 받는다
    return typescript and _quoted(name, text)


def _check_psql(tokens, repo, sql_path):
    problems = []
    sql = repo.text(sql_path) or ''
    body = '\n'.join(line for line in sql.splitlines() if not line.lstrip().startswith('--'))
    wanted = set(SQL_VARIABLE.findall(body))
    given = set()
    for index, token in enumerate(tokens[:-1]):
        if token == '-v' and '=' in tokens[index + 1]:
            name = tokens[index + 1].split('=', 1)[0]
            if not name.isupper():
                given.add(name)
    for name in sorted(wanted - given):
        problems.append(('psql_variable', f'{sql_path}: missing -v {name}'))
    for name in sorted(given - wanted):
        problems.append(('psql_variable', f'{sql_path}: unused -v {name}'))
    return problems


def check_segment(tokens, repo):
    problems = []
    for token in tokens:
        unit = UNIT.match(token)
        if unit:
            template = unit.group(1) + ('@' if unit.group(2) else '') + '.' + unit.group(3)
            if repo.text(f'deploy/oracle/{template}') is None:
                problems.append(('unit_template', f'{token} -> deploy/oracle/{template}'))
    for index, token in enumerate(tokens):
        match = REPO_PATH.search(token)
        if not match:
            continue
        relative = match.group(1)
        if repo.text(relative) is None:
            problems.append(('missing_file', relative))
            break
        if relative.endswith('.sql'):
            if tokens and tokens[0] == 'psql' and index > 0 and tokens[index - 1] == '-f':
                problems.extend(_check_psql(tokens, repo, relative))
            break
        text = repo.script_text(relative)
        typescript = relative.endswith('.ts')
        rest = []
        for item in tokens[index + 1:]:
            if item in REDIRECTS:
                break
            rest.append(item)
        if rest and SUBCOMMAND.match(rest[0]) and not _quoted(rest[0], text):
            problems.append(('subcommand', f'{relative} {rest[0]}'))
        for item in rest:
            if not item.startswith('--'):
                continue
            name, _, value = item[2:].partition('=')
            if not _flag_known(name, text, typescript):
                problems.append(('flag', f'{relative} --{name}'))
            elif name in VALUE_OPTIONS and value and '$' not in value:
                sources = [text, *[repo.text(path) or '' for path in VALUE_SOURCES]]
                if not any(_quoted(value, source) for source in sources):
                    problems.append(('value', f'{relative} --{name}={value}'))
        break
    return problems


def check_document(text, root=ROOT):
    repo = Repository(root)
    problems, counts, commands = [], {}, 0
    for language, body, start in extract_blocks(text):
        counts[language or 'plain'] = counts.get(language or 'plain', 0) + 1
        if language in SHELL_LANGUAGES:
            error = bash_syntax(body)
            if error:
                problems.append({'line': start, 'kind': 'bash_syntax', 'detail': error})
                continue
            for line, command in logical_lines(body, start):
                try:
                    parts = segments(command)
                except ValueError as error:
                    problems.append({'line': line, 'kind': 'shlex', 'detail': str(error)})
                    continue
                for tokens in parts:
                    commands += 1
                    problems.extend({'line': line, 'kind': kind, 'detail': detail} for kind, detail in check_segment(tokens, repo))
        elif language == 'env':
            for offset, raw in enumerate(body.split('\n')):
                key = ENV_LINE.match(raw.strip())
                if key and not re.search(r'\b' + re.escape(key.group(1)) + r'\b', repo.corpus()):
                    problems.append({'line': start + offset, 'kind': 'env_key', 'detail': key.group(1)})
    return {'blocks': counts, 'commandsChecked': commands, 'problems': problems, 'ok': not problems}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--doc', type=Path, default=DEFAULT_DOC)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args(argv)
    try:
        text = args.doc.read_text(encoding='utf-8')
    except OSError:
        print(json.dumps({'ok': False, 'code': 'doc_unreadable'}))
        return 2
    report = check_document(text, args.root)
    print(json.dumps({'doc': str(args.doc), **report}, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
