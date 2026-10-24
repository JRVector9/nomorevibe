import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('publication classification migration preserves existing authority', () => {
  it('keeps the entire predecessor predicate as the left branch of each extended CHECK', () => {
    const old = new Map<string, string>();
    for (const file of readdirSync('drizzle').filter(file => /^\d{4}.*\.sql$/.test(file) && file < '0125_').sort()) {
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint')) {
        // drizzle-kit quotes identifiers; older handwritten migrations do not. Both replace the same CHECK.
        const match = /ALTER TABLE "?\w+"? ADD CONSTRAINT "?(model_capacity_(?:requests_(?:members|logical|dispatch|terminal)|events_terminal)_check)"? CHECK \(/.exec(statement);
        if (match) old.set(match[1], statement.slice(match.index + match[0].length, statement.lastIndexOf(');')));
      }
    }
    expect(old.size).toBe(5);
    const migration = readFileSync('drizzle/0125_publication_classify_cli.sql', 'utf8');
    for (const [name, predicate] of old)
      expect(migration.includes(`ADD CONSTRAINT ${name} CHECK ((${predicate}) OR coalesce((`), name).toBe(true);
  });
});
