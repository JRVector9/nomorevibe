import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('publication classification migration preserves existing authority', () => {
  it('keeps the entire predecessor predicate as the left branch of each extended CHECK', () => {
    const old = new Map<string, string>();
    for (const file of readdirSync('drizzle').filter(file => /^\d{4}.*\.sql$/.test(file) && file < '0125_').sort()) {
      for (const match of readFileSync(`drizzle/${file}`, 'utf8').matchAll(/ALTER TABLE \w+ ADD CONSTRAINT (model_capacity_(?:requests_(?:members|logical|dispatch|terminal)|events_terminal)_check) CHECK \(([^\n]+)\);/g))
        old.set(match[1], match[2]);
    }
    expect(old.size).toBe(5);
    const migration = readFileSync('drizzle/0125_publication_classify_cli.sql', 'utf8');
    for (const [name, predicate] of old) expect(migration).toContain(`ADD CONSTRAINT ${name} CHECK ((${predicate}) OR coalesce((`);
  });
});
