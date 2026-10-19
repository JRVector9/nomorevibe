import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ORACLE_CONSUMER_DB_PROFILES, oracleConsumerGrantStatements } from '@/lib/runtime/oracle-db-profile';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/*
 * 0105 행 범위(실제 PostgreSQL). Oracle agent-scan 계정(생성 SQL 그대로)은 rate_limits 의 GitHub 수집 키(github:quota:·github:auth:)만,
 * github_collector_apps 는 oracle_principals 에 그 계정 이름이 든 설치만 읽고 쓴다(리뷰 P2-4·P2-5).
 * 소유 역할이 아닌 일반 계정(M3 앱 계정이 소유자가 아닐 때와 같은 모양)은 두 표의 모든 행을 그대로 다룬다.
 * 두 표에 넣은 행은 파일 끝에 지운다.
 */
const PROFILE = ORACLE_CONSUMER_DB_PROFILES['agent-scan']!;
const WEB = 'fxe_m3_rls_probe';
const password = randomUUID();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'fxe-row-scope-admin' } });
const sessions: postgres.Sql[] = [];
function connect(user: string) {
  const url = new URL(TEST_DATABASE_URL); url.username = user; url.password = password;
  const session = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  sessions.push(session);
  return session;
}
async function dropRole(name: string) {
  if ((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${name}`).length) {
    await admin.unsafe(`DROP OWNED BY ${name}`); await admin.unsafe(`DROP ROLE ${name}`);
  }
}
const KEYS = ['admin-password:login', 'register:203.0.113.9', 'github-star:7', 'github:quota:abc:primary:core', 'github:quota:secondary:global',
  'github:auth:abc'];
const GITHUB_KEYS = ['github:auth:abc', 'github:quota:abc:primary:core', 'github:quota:secondary:global'];
const errorCode = async (query: Promise<unknown>) => query.then(() => 'allowed', (error: { code?: string }) => error.code ?? 'unknown');
const clear = async () => {
  await admin`DELETE FROM rate_limits WHERE key = ANY(${[...KEYS, 'github:quota:new:primary:core', 'register:198.51.100.1']})`;
  await admin`DELETE FROM github_collector_apps WHERE installation_id IN (111, 222)`;
};

beforeAll(async () => {
  ensureSchema();
  await dropRole(PROFILE.principal); await dropRole(WEB); await clear();
  for (const statement of oracleConsumerGrantStatements(PROFILE, { connectionLimit: 4 })) await admin.unsafe(statement);
  await admin.unsafe(`ALTER ROLE ${PROFILE.principal} PASSWORD '${password}'`);
  // 소유자가 아닌 앱 계정과 같은 모양(표 권한만 있고 RLS 우회 없음)
  await admin.unsafe(`CREATE ROLE ${WEB} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await admin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rate_limits, public.github_collector_apps TO ${WEB}`);
  for (const key of KEYS) await admin`INSERT INTO rate_limits (key, count, reset_at) VALUES (${key}, 1, now() + interval '10 minutes')`;
  for (const installationId of [111, 222]) await admin`INSERT INTO github_collector_apps (installation_id, app_id, app_slug, account_login, encrypted_private_key)
    VALUES (${installationId}, ${installationId}, ${'app-' + installationId}, 'org', ${'sealed-' + installationId})`;
  // 운영자가 Oracle 계정을 만들 때 그 설치에 계정 이름을 넣는다(runbook). 222 는 M3 몫이라 비워 둔다
  await admin`UPDATE github_collector_apps SET oracle_principals = ${[PROFILE.principal]} WHERE installation_id = 111`;
}, 120_000);

afterAll(async () => {
  try {
    await Promise.all(sessions.map(session => session.end({ timeout: 5 })));
    await clear(); await dropRole(PROFILE.principal); await dropRole(WEB);
  } finally { await admin.end({ timeout: 5 }); }
}, 60_000);

it('the Oracle agent-scan principal reads and writes only GitHub collector keys in rate_limits', async () => {
  const oracle = connect(PROFILE.principal);
  expect((await oracle<{ key: string }[]>`SELECT key FROM rate_limits WHERE key = ANY(${KEYS})`).map(row => row.key).sort()).toEqual(GITHUB_KEYS);
  // 관리자 로그인 제한·IP 키는 만들 수도, 기한을 미룰 수도 없다(고치기 전: 둘 다 됐다)
  expect(await errorCode(oracle`INSERT INTO rate_limits (key, count, reset_at) VALUES ('register:198.51.100.1', 999, '2100-01-01')`)).toBe('42501');
  expect(await errorCode(oracle`INSERT INTO rate_limits (key, count, reset_at) VALUES ('admin-password:login', 999, '2100-01-01')
    ON CONFLICT (key) DO UPDATE SET reset_at = greatest(rate_limits.reset_at, excluded.reset_at)`)).toBe('42501');
  expect((await oracle`UPDATE rate_limits SET reset_at = '2100-01-01' WHERE key = 'admin-password:login'`).count).toBe(0);
  const [login] = await admin<{ far: boolean }[]>`SELECT reset_at > now() + interval '1 day' AS far FROM rate_limits WHERE key = 'admin-password:login'`;
  expect(login.far).toBe(false);
  // GitHub 쿨다운 쓰기(github-quota.ts 와 같은 모양)는 그대로 된다
  await oracle`INSERT INTO rate_limits (key, count, reset_at) VALUES ('github:quota:new:primary:core', 0, now() + interval '5 minutes')
    ON CONFLICT (key) DO UPDATE SET reset_at = greatest(rate_limits.reset_at, excluded.reset_at)`;
  expect((await oracle`UPDATE rate_limits SET reset_at = reset_at + interval '1 minute' WHERE key = 'github:quota:secondary:global'`).count).toBe(1);
});

it('the Oracle agent-scan principal sees and updates only the App installations granted to it', async () => {
  const oracle = connect(PROFILE.principal);
  // 개인 키 암호문은 허용한 설치의 것만 읽힌다(고치기 전: 모든 App 행)
  expect(await oracle`SELECT installation_id::int AS id, encrypted_private_key AS key FROM github_collector_apps ORDER BY 1`)
    .toEqual([{ id: 111, key: 'sealed-111' }]);
  expect((await oracle`UPDATE github_collector_apps SET core_quota = '{}'::jsonb WHERE installation_id = 222`).count).toBe(0);
  expect((await oracle`UPDATE github_collector_apps SET core_quota = '{}'::jsonb WHERE installation_id = 111`).count).toBe(1);
  // 허용은 운영자만 준다 — Oracle 계정은 이 열을 바꿀 권한이 없다
  expect(await errorCode(oracle`UPDATE github_collector_apps SET oracle_principals = ${[PROFILE.principal]} WHERE installation_id = 111`)).toBe('42501');
  // 관리자 등록(upsert, github-apps.ts)은 허용을 지우지 않는다
  await admin`INSERT INTO github_collector_apps (installation_id, app_id, app_slug, account_login, encrypted_private_key) VALUES (111, 111, 'app-111', 'org', 'sealed-111b')
    ON CONFLICT (installation_id) DO UPDATE SET encrypted_private_key = excluded.encrypted_private_key`;
  expect(await oracle`SELECT installation_id::int AS id FROM github_collector_apps`).toEqual([{ id: 111 }]);
});

it('a non-owner application role keeps every row of both tables (only nomorevibe_oracle_* principals are narrowed)', async () => {
  const web = connect(WEB);
  expect((await web<{ key: string }[]>`SELECT key FROM rate_limits WHERE key = ANY(${KEYS})`).map(row => row.key).sort()).toEqual([...KEYS].sort());
  await web`INSERT INTO rate_limits (key, count, reset_at) VALUES ('register:198.51.100.1', 1, now() + interval '1 hour')`;
  expect((await web`UPDATE rate_limits SET count = count + 1 WHERE key = 'admin-password:login'`).count).toBe(1);
  expect((await web`DELETE FROM rate_limits WHERE key = 'register:198.51.100.1'`).count).toBe(1);
  expect((await web`SELECT installation_id FROM github_collector_apps WHERE installation_id IN (111, 222)`)).toHaveLength(2);
  expect((await web`UPDATE github_collector_apps SET enabled = enabled WHERE installation_id = 222`).count).toBe(1);
});
