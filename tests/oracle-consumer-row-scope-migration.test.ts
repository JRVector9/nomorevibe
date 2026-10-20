import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobDeferralKey } from '@/lib/jobs/deferral-observation';
import { hostSlotPrefix } from '@/lib/operations/host-budget';
import { consumerInstancePrefix, CONSUMERS } from '@/lib/runtime/consumer-registry';
import { ORACLE_CONSUMER_DB_PROFILES } from '@/lib/runtime/oracle-db-profile';

// 0107 트리거는 SQL 에 계정 이름·키 모양을 적어 둔다. 등록부·DB 프로필·관측 키 규칙이 바뀌면 이 시험이 먼저 알린다(실제 동작은
// tests/integration/oracle-consumer-row-scope.test.ts 가 본다).
const migration = readFileSync('drizzle/0107_oracle_consumer_row_scope.sql', 'utf8').replace(/--(?!> statement-breakpoint).*$/gm, '');
// SERVICE_INSTANCE_ID 는 48자까지다(lib/operations/instance.ts)
const suffix = (consumer: string) => `[A-Za-z0-9._-]{1,${48 - consumerInstancePrefix(consumer).length}}`;

describe('0107 migration text', () => {
  it('names the consumer principals and their own observation keys from the registry and the profiles', () => {
    expect(migration).toContain(`current_user::text = '${ORACLE_CONSUMER_DB_PROFILES.uptime!.principal}'`);
    expect(migration).toContain(`'^(uptime-consumer|service:${CONSUMERS.uptime.role}):${consumerInstancePrefix('uptime')}${suffix('uptime')}$'`);
    expect(migration).toContain(`current_user::text = '${ORACLE_CONSUMER_DB_PROFILES['agent-scan']!.principal}'`);
    expect(migration).toContain(`'^(agent-scan|service:${CONSUMERS['agent-scan'].role}):${consumerInstancePrefix('agent-scan')}${suffix('agent-scan')}$'`);
    expect(migration).toContain(`NEW.key <> '${jobDeferralKey('agent-scan')}'`);
    expect(migration).toContain(`'^${hostSlotPrefix('oracle-osaka-smoke')}(:|$)'`);
  });
  it('adds two invoker triggers and no row security, no definer function, no grant', () => {
    expect([...migration.matchAll(/CREATE TRIGGER (\w+) BEFORE INSERT OR UPDATE ON (\w+)/g)].map(match => [match[1], match[2]]))
      .toEqual([['uptime_claims_oracle_scope', 'uptime_claims'], ['operations_observations_oracle_consumer_scope', 'operations_observations']]);
    expect(migration).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY|SECURITY DEFINER|GRANT |REVOKE |ALTER TABLE/);
    expect([...migration.matchAll(/ERRCODE = '(\w+)'/g)].map(match => match[1])).toEqual(['42501', '42501', '42501']);
  });
});
