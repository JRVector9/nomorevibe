"""scripts/ops/oracle_activation_check.py 회귀. 임시 저장소 fixture 와 실제 runbook 을 읽기만 한다(문서 명령 실행 0)."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('oracle_activation_check', ROOT / 'scripts/ops/oracle_activation_check.py')
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

FILES = {
    'scripts/tool.py': "import helper\nsub.add_parser('plan')\nparser.add_argument('--sha')\n",
    'scripts/helper.py': "parser.add_argument('--database-url-stdin')\n",
    'scripts/unrelated.py': "parser.add_argument('--secret-flag')\n",
    'lib/cli.ts': "type C = { command: 'identity' };\nconst ALLOWED = { identity: ['operator', 'job'] };\nif (a.startsWith('--role=')) {}\n",
    'lib/jobs/batches.ts': "const SPLIT = { 'official-news': ['news-refresh'] };\n",
    'lib/env.ts': 'process.env.KNOWN_KEY;\n',
    'deploy/oracle/x.sql': '-- psql -v a_connections=N\nCREATE ROLE a CONNECTION LIMIT :a_connections;\nCREATE ROLE b CONNECTION LIMIT :b_connections;\n',
    'deploy/oracle/nomorevibe-core-role@.service': '[Unit]\n',
}


def fenced(language, body):
    return f'```{language}\n{body}\n```\n'


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for relative, content in FILES.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)

    def tearDown(self):
        self.temp.cleanup()

    def kinds(self, text):
        return [(problem['kind'], problem['detail']) for problem in check.check_document(text, self.root)['problems']]

    def test_blocks_keep_language_and_first_body_line(self):
        text = '# t\n\n' + fenced('bash', 'echo a') + 'x\n' + fenced('env', 'KNOWN_KEY=')
        self.assertEqual(check.extract_blocks(text), [('bash', 'echo a\n', 4), ('env', 'KNOWN_KEY=\n', 8)])

    def test_bash_syntax_error_is_reported_and_valid_block_passes(self):
        self.assertEqual(self.kinds(fenced('bash', 'echo "$X" | cat')), [])
        problems = self.kinds(fenced('bash', 'if true; then'))
        self.assertEqual([kind for kind, _ in problems], ['bash_syntax'])

    def test_subcommand_flag_and_file_must_exist_in_the_script(self):
        self.assertEqual(self.kinds(fenced('bash', 'python3 "$SRC/scripts/tool.py" plan --sha "$X"')), [])
        self.assertEqual(self.kinds(fenced('bash', 'python3 scripts/tool.py nope --sha x')), [('subcommand', 'scripts/tool.py nope')])
        self.assertEqual(self.kinds(fenced('bash', 'python3 scripts/tool.py plan --bogus')), [('flag', 'scripts/tool.py --bogus')])
        self.assertEqual(self.kinds(fenced('bash', 'python3 scripts/missing.py plan')), [('missing_file', 'scripts/missing.py')])

    def test_python_flags_come_only_from_imported_sibling_modules(self):
        self.assertEqual(self.kinds(fenced('bash', 'python3 scripts/tool.py plan --database-url-stdin')), [])
        self.assertEqual(self.kinds(fenced('bash', 'python3 scripts/tool.py plan --secret-flag')),
                         [('flag', 'scripts/tool.py --secret-flag')])

    def test_typescript_names_and_role_job_values(self):
        self.assertEqual(self.kinds(fenced('bash', 'node --import tsx lib/cli.ts identity --operator=x --role=official-news --job=news-refresh')), [])
        self.assertEqual(self.kinds(fenced('bash', 'node --import tsx lib/cli.ts identity --job=unknown-job')),
                         [('value', 'lib/cli.ts --job=unknown-job')])
        self.assertEqual(self.kinds(fenced('bash', 'node --import tsx lib/cli.ts identity --target=x')),
                         [('flag', 'lib/cli.ts --target')])
        self.assertEqual(self.kinds(fenced('bash', 'node --import tsx lib/cli.ts identity --role=nobody')),
                         [('value', 'lib/cli.ts --role=nobody')])
        self.assertEqual(self.kinds(fenced('bash', 'node --import tsx lib/cli.ts identity --role="$ROLE"')), [])

    def test_psql_variables_match_the_sql_file_in_both_directions(self):
        base = 'psql "$U" -v ON_ERROR_STOP=1 -v a_connections=1 {} -f "$SRC/deploy/oracle/x.sql"'
        self.assertEqual(self.kinds(fenced('bash', base.format('-v b_connections=1'))), [])
        self.assertEqual(self.kinds(fenced('bash', base.format(''))), [('psql_variable', 'deploy/oracle/x.sql: missing -v b_connections')])
        self.assertEqual(self.kinds(fenced('bash', base.format('-v b_connections=1 -v c_connections=1'))),
                         [('psql_variable', 'deploy/oracle/x.sql: unused -v c_connections')])

    def test_unit_names_need_a_template(self):
        self.assertEqual(self.kinds(fenced('bash', 'systemctl start nomorevibe-core-role@official-news.service')), [])
        self.assertEqual(self.kinds(fenced('bash', 'systemctl start nomorevibe-core-other@x.service')),
                         [('unit_template', 'nomorevibe-core-other@x.service -> deploy/oracle/nomorevibe-core-other@.service')])

    def test_env_keys_must_exist_in_code(self):
        self.assertEqual(self.kinds(fenced('env', '# comment\nKNOWN_KEY=\nUNKNOWN_KEY=1')), [('env_key', 'UNKNOWN_KEY')])

    def test_continuations_pipes_and_comments_are_followed(self):
        body = 'printf \'%s\\n\' "$U" | python3 scripts/tool.py plan \\\n  --sha x \\\n  --bogus  # --ignored'
        self.assertEqual(self.kinds(fenced('bash', body)), [('flag', 'scripts/tool.py --bogus')])

    def test_main_reports_unreadable_document(self):
        self.assertEqual(check.main(['--doc', str(self.root / 'none.md'), '--root', str(self.root)]), 2)


class RunbookTests(unittest.TestCase):
    def test_the_oracle_activation_runbook_passes(self):
        report = check.check_document(check.DEFAULT_DOC.read_text(encoding='utf-8'), ROOT)
        self.assertEqual(report['problems'], [])
        self.assertGreater(report['blocks'].get('bash', 0), 0)
        self.assertGreater(report['blocks'].get('env', 0), 0)
        self.assertGreater(report['commandsChecked'], 0)


if __name__ == '__main__':
    unittest.main()
