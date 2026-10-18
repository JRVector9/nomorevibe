import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { consumerInstancePrefix } from '@/lib/runtime/consumer-registry';
import { ORACLE_CONSUMER_DB_PROFILES, ORACLE_DB_PRINCIPALS, oracleConsumerGrantStatements, oracleDbGrantStatements } from '@/lib/runtime/oracle-db-profile';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/*
 * 0106 행 범위(실제 PostgreSQL). Oracle consumer 계정(생성 SQL 그대로)은
 * - uptime_claims 를 Oracle host·probe 로만 쓴다(home 으로 적힌 제출 행 위조·home 행 고치기 → 42501, review-uptime F3),
 * - operations_observations 에 자기 consumer 의 관측 키만 쓴다(다른 키 덮기 → 42501, F11).
 * Oracle 역할 계정(product-health)과 소유자가 아닌 앱 계정(M3 앱 계정이 소유자가 아닐 때와 같은 모양), 소유 계정은 그대로다.
 * 넣은 행은 파일 끝에 지운다.
 */
const UPTIME = ORACLE_CONSUMER_DB_PROFILES.uptime!, AGENT = ORACLE_CONSUMER_DB_PROFILES['agent-scan']!;
const ROLE = ORACLE_DB_PRINCIPALS['product-health'];
const WEB = 'int2_m3_scope_probe';
const UPTIME_INSTANCE = `${consumerInstancePrefix('uptime')}oracle`, AGENT_INSTANCE = `${consumerInstancePrefix('agent-scan')}oracle`;
const password = randomUUID();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'int2-row-scope-admin' } });
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
const errorOf = async (query: Promise<unknown>) => query.then(() => 'allowed', (error: { code?: string; message?: string }) => `${error.code}:${error.message}`);
/** consumer 관측(observe)과 같은 모양: 없으면 넣고 있으면 고친다 */
const upsert = (session: postgres.Sql, key: string) => session`INSERT INTO operations_observations (key, value, observed_at)
  VALUES (${key}, ${session.json({ by: 'probe' })}, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, observed_at = excluded.observed_at`;
/** 감독 생존(observeService)과 같은 모양: 없으면 넣고, 줄을 잠근 뒤 고친다 */
async function observeService(session: postgres.Sql, key: string) {
  await session.begin(async tx => {
    await tx`INSERT INTO operations_observations (key, value, observed_at) VALUES (${key}, ${tx.json({ status: 'running' })}, now()) ON CONFLICT DO NOTHING`;
    await tx`SELECT key FROM operations_observations WHERE key = ${key} FOR UPDATE`;
    await tx`UPDATE operations_observations SET value = ${tx.json({ status: 'running', again: true })}, observed_at = now() WHERE key = ${key}`;
  });
}
const OTHER_KEYS = ['service:maintenance:m3-maintenance', 'service:crawler:m3-crawler', 'candidate:maintenance:m3-maintenance', 'job:uptime-ping'];
const PRODUCT_ID = 2_100_000_001;
const clear = async () => {
  await admin`DELETE FROM operations_observations WHERE key = ANY(${[...OTHER_KEYS, `uptime-consumer:${UPTIME_INSTANCE}`,
    `service:maintenance:${UPTIME_INSTANCE}`, `agent-scan:${AGENT_INSTANCE}`, `service:crawler:${AGENT_INSTANCE}`, 'defer:agent-scan',
    'host-slot:oracle-osaka-smoke', 'host-slot:oracle-osaka-smoke:p:probe', 'service:product-health:oracle-product-health', 'web:probe']})`;
  await admin`DELETE FROM products WHERE id = ${PRODUCT_ID}`;
};

beforeAll(async () => {
  ensureSchema();
  for (const name of [UPTIME.principal, AGENT.principal, ROLE, WEB]) await dropRole(name);
  await clear();
  for (const statement of oracleConsumerGrantStatements(UPTIME, { connectionLimit: 4 })) await admin.unsafe(statement);
  for (const statement of oracleConsumerGrantStatements(AGENT, { connectionLimit: 4 })) await admin.unsafe(statement);
  for (const statement of oracleDbGrantStatements('product-health', { connectionLimit: 4 })) await admin.unsafe(statement);
  for (const name of [UPTIME.principal, AGENT.principal, ROLE]) await admin.unsafe(`ALTER ROLE ${name} PASSWORD '${password}'`);
  await admin.unsafe(`CREATE ROLE ${WEB} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  await admin.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.operations_observations, public.uptime_claims TO ${WEB}`);
  for (const key of OTHER_KEYS) await admin`INSERT INTO operations_observations (key, value, observed_at) VALUES (${key}, ${admin.json({ by: 'owner' })}, now())`;
  await admin`INSERT INTO products (id, slug, url, name, tagline, description, category, status, access_mode, verify_token, edit_token_hash)
    VALUES (${PRODUCT_ID}, 'int2-scope', 'https://int2-scope.example/', 'int2', '소개', '설명', 'Other', 'seeded', 'website', 'verify', ${'x'.repeat(64)})`;
  // home(m3)이 쥔 claim 과 Oracle 이 쥔 claim 의 모양
  await admin`INSERT INTO uptime_claims (product_id, state, epoch, control_epoch, token, owner_instance_id, owner_boot_id, host, host_class,
      lease_until, claimed_at, claim_slug, claim_url, origin, claim_slot)
    VALUES (${PRODUCT_ID}, 'claimed', 1, 1, gen_random_uuid(), 'm3-maintenance', gen_random_uuid(), 'm3', 'home',
      clock_timestamp() + interval '3 minutes', clock_timestamp(), 'int2-scope', 'https://int2-scope.example/', 'https://int2-scope.example',
      to_timestamp(floor(extract(epoch from clock_timestamp()) / 21600) * 21600))`;
}, 120_000);

afterAll(async () => {
  try {
    await Promise.all(sessions.map(session => session.end({ timeout: 5 })));
    await clear();
    for (const name of [UPTIME.principal, AGENT.principal, ROLE, WEB]) await dropRole(name);
  } finally { await admin.end({ timeout: 5 }); }
}, 60_000);

it('the Oracle uptime principal writes uptime_claims only as the Oracle probe (no forged home rows, no edits of home rows)', async () => {
  const oracle = connect(UPTIME.principal);
  // 리뷰 F3 재현 문장의 핵심: home host·class 로 적기(고치기 전: 됐고 적용기가 거른 것만 남았다)
  expect(await errorOf(oracle`UPDATE uptime_claims SET host = 'm3', host_class = 'home', updated_at = clock_timestamp() WHERE product_id = ${PRODUCT_ID}`))
    .toBe('42501:oracle_uptime_claim_host');
  // home 이 쥔 행을 host 를 건드리지 않고 고치기(예: 결과 칸)도 같다
  expect(await errorOf(oracle`UPDATE uptime_claims SET updated_at = clock_timestamp() WHERE product_id = ${PRODUCT_ID}`)).toBe('42501:oracle_uptime_claim_host');
  expect(await errorOf(oracle`UPDATE uptime_claims SET host = 'oracle-osaka-smoke', host_class = 'home' WHERE product_id = ${PRODUCT_ID}`))
    .toBe('42501:oracle_uptime_claim_host');
  const [row] = await admin`SELECT host, host_class, state FROM uptime_claims WHERE product_id = ${PRODUCT_ID}`;
  expect(row).toEqual({ host: 'm3', host_class: 'home', state: 'claimed' });
  // claim(uptime-claims.ts)처럼 Oracle host·probe 로 쓰는 것은 그대로 된다
  expect((await oracle`UPDATE uptime_claims SET host = 'oracle-osaka-smoke', host_class = 'probe', owner_instance_id = ${UPTIME_INSTANCE},
    updated_at = clock_timestamp() WHERE product_id = ${PRODUCT_ID} RETURNING product_id`)).toHaveLength(1);
  expect((await oracle`UPDATE uptime_claims SET state = 'idle', token = null, lease_until = null WHERE product_id = ${PRODUCT_ID} RETURNING host`))
    .toEqual([{ host: 'oracle-osaka-smoke' }]);
});

it('the Oracle uptime principal writes only its own consumer observation keys', async () => {
  const oracle = connect(UPTIME.principal);
  await upsert(oracle, `uptime-consumer:${UPTIME_INSTANCE}`);
  await upsert(oracle, `uptime-consumer:${UPTIME_INSTANCE}`);
  await observeService(oracle, `service:maintenance:${UPTIME_INSTANCE}`);
  for (const key of [...OTHER_KEYS, `agent-scan:${AGENT_INSTANCE}`, `service:crawler:${AGENT_INSTANCE}`, 'uptime-consumer:m3-maintenance',
    `uptime-consumer:${consumerInstancePrefix('uptime')}`, 'defer:agent-scan']) {
    expect(await errorOf(upsert(oracle, key)), key).toBe('42501:oracle_consumer_observation_key');
  }
  // 있는 남의 줄을 고치기(생존 위장)도 막힌다 — 값은 소유 계정이 쓴 그대로다
  expect(await errorOf(oracle`UPDATE operations_observations SET value = ${oracle.json({ status: 'running' })}, observed_at = now()
    WHERE key = 'service:maintenance:m3-maintenance'`)).toBe('42501:oracle_consumer_observation_key');
  const rows = await admin<{ key: string; by: string }[]>`SELECT key, value->>'by' AS by FROM operations_observations WHERE key = ANY(${OTHER_KEYS}) ORDER BY key`;
  expect(rows.map(row => row.by)).toEqual(OTHER_KEYS.map(() => 'owner'));
});

it('the Oracle agent-scan principal writes only its own consumer keys, the shared deferral key and this host ledger', async () => {
  const oracle = connect(AGENT.principal);
  for (const key of [`agent-scan:${AGENT_INSTANCE}`, 'defer:agent-scan', 'host-slot:oracle-osaka-smoke', 'host-slot:oracle-osaka-smoke:p:probe']) await upsert(oracle, key);
  await observeService(oracle, `service:crawler:${AGENT_INSTANCE}`);
  for (const key of [...OTHER_KEYS, `uptime-consumer:${UPTIME_INSTANCE}`, `service:maintenance:${UPTIME_INSTANCE}`, 'host-slot:m3:p:probe',
    'host-slot:oracle-osaka-smokey', 'defer:crawl-seed', 'agent-scan:m3-crawler']) {
    expect(await errorOf(upsert(oracle, key)), key).toBe('42501:oracle_consumer_observation_key');
  }
});

it('Oracle role principals, a non-owner application role and the owner keep their writes', async () => {
  // 역할 계정(product-health): 역할 생존·잡 관측 키를 그대로 쓴다(이번 조건은 consumer 계정 둘에만 걸린다)
  const role = connect(ROLE);
  await upsert(role, 'service:product-health:oracle-product-health');
  await upsert(role, 'job:uptime-ping');
  // 소유자가 아닌 앱 계정: 아무 키나, home claim 행도 그대로
  const web = connect(WEB);
  await upsert(web, 'web:probe');
  await observeService(web, 'service:maintenance:m3-maintenance');
  expect((await web`UPDATE uptime_claims SET host = 'm3', host_class = 'home' WHERE product_id = ${PRODUCT_ID} RETURNING host`)).toEqual([{ host: 'm3' }]);
  // 소유 계정(웹·워커·migration)
  await upsert(admin, 'service:crawler:m3-crawler');
  expect((await admin`UPDATE uptime_claims SET host = 'mini' WHERE product_id = ${PRODUCT_ID} RETURNING host`)).toEqual([{ host: 'mini' }]);
});

it('adds only invoker origin triggers — no new row security (logical DR plan) and nothing the replay handler profile rejects', async () => {
  const triggers = await admin<{ table: string; name: string; enabled: string; definer: boolean }[]>`SELECT c.relname AS table, t.tgname AS name,
      t.tgenabled AS enabled, p.prosecdef AS definer
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgname IN ('uptime_claims_oracle_scope', 'operations_observations_oracle_consumer_scope') ORDER BY 1`;
  expect(triggers).toEqual([
    { table: 'operations_observations', name: 'operations_observations_oracle_consumer_scope', enabled: 'O', definer: false },
    { table: 'uptime_claims', name: 'uptime_claims_oracle_scope', enabled: 'O', definer: false },
  ]);
  // RLS 를 켠 표는 0105 의 두 표뿐이다(논리 DR 계획의 row_security_requires_review 대상이 늘지 않는다)
  const rls = await admin<{ name: string }[]>`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity ORDER BY 1`;
  expect(rls.map(row => row.name)).toEqual(['github_collector_apps', 'rate_limits']);
});
