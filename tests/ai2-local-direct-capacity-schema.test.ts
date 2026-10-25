import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const tag = '0132_ai2_local_direct_gateway';
const names = [
  'model_capacity_requests_logical_check',
  'model_capacity_requests_dispatch_check',
  'model_capacity_requests_terminal_check',
  'model_capacity_events_terminal_check',
];

/** Split only outer ORs, leaving JSON strings, CASEs and coalesce validators intact. */
function branches(value: string): string[] {
  const text = value.trim();
  const outside: number[] = [];
  let depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "'") {
      if (quoted && text[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (depth === 0) outside.push(i);
  }
  if (text.startsWith('(') && text.endsWith(')') && outside.every(i => i === text.length - 1))
    return branches(text.slice(1, -1));
  const splits = outside.filter(i => text.slice(i, i + 4) === ' OR ');
  if (!splits.length) return [text];
  const result: string[] = [];
  let start = 0;
  for (const split of splits) { result.push(...branches(text.slice(start, split))); start = split + 4; }
  return [...result, ...branches(text.slice(start))];
}

function previousAi2(name: string) {
  const migration = readFileSync('drizzle/0085_model_capacity_ai2_terminal.sql', 'utf8');
  const statement = migration.split('--> statement-breakpoint').find(sql => sql.includes(`ADD CONSTRAINT ${name} CHECK`))!;
  const expression = /CHECK \(([\s\S]*)\);\s*$/.exec(statement)![1];
  const selected = branches(expression).filter(sql => name.endsWith('logical_check')
    ? sql.includes("logical_work_key ~ '^ai2:") : sql.includes("'ai2_item_gateway'"));
  expect(selected, `${name}: one original fixed AI2 branch`).toHaveLength(1);
  return selected[0];
}

function migrationBranches() {
  const migration = readFileSync(`drizzle/${tag}.sql`, 'utf8');
  return migration.split('--> statement-breakpoint').filter(sql => sql.includes('DO $$')).map(sql => ({
    name: /conname='([^']+)'/.exec(sql)![1],
    branch: /\$ai2_local\$([\s\S]*?)\$ai2_local\$/.exec(sql)![1], sql,
  }));
}

it('registers one additive AI2 migration after the historical provider boundary migration', () => {
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
  const index = journal.entries.findIndex((entry: { idx: number }) => entry.idx === 132);
  expect(index).toBeGreaterThan(0);
  expect(journal.entries[index - 1]).toMatchObject({ idx: 131, tag: '0131_historical_direct_provider_boot_boundary' });
  expect(journal.entries[index]).toMatchObject({ idx: 132, tag, breakpoints: true });
  expect(journal.entries.filter((entry: { idx: number; tag: string }) => entry.idx === 132 || entry.tag === tag)).toHaveLength(1);
});

it.each(names)('%s adds only the original fixed AI2 branch with its provider changed', name => {
  const added = migrationBranches().filter(entry => entry.name === name);
  expect(added).toHaveLength(1);
  const original = previousAi2(name);
  expect(original).toContain("'abcllm'");
  expect(added[0].branch).toBe(original.replaceAll("'abcllm'", "'local-direct'"));
  expect(added[0].branch).not.toMatch(/ai1_|ai2_item_cli|local_model_|publication_classify/);
  expect(added[0].sql).toContain('substring(pg_get_constraintdef(oid) FROM 7) INTO STRICT old_predicate');
  expect(added[0].sql).toContain('CHECK ((%s) OR (%s))');
});

it('changes exactly four CHECKs without replacing SQL functions, triggers, indexes or ledger rows', () => {
  const entries = migrationBranches(), migration = readFileSync(`drizzle/${tag}.sql`, 'utf8');
  expect(entries.map(entry => entry.name)).toEqual(names);
  expect(migration).not.toMatch(/\b(?:CREATE|REPLACE)\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
  expect(migration).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+(?:TRIGGER|INDEX|COLUMN)\b/i);
  expect(migration).not.toMatch(/^\s*(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/im);
  // 0102 already admits this unchanged kind and its exact persisted dispatch,
  // including the transport-zero path; it requires no provider widening.
  const notStarted = readFileSync('drizzle/0102_model_capacity_gateway_not_started.sql', 'utf8');
  expect(notStarted).toContain('gateway_not_started');
  expect(notStarted).toContain("'ai2_item_gateway'");
  expect(migration).not.toContain('gateway_not_started');
});
