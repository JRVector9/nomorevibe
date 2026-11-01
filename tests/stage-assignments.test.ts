import { describe, expect, it } from 'vitest';
import { selectFirstReviewer } from '@/lib/crawl/first-reviewers';
import { chooseModelForItem, orderStageAssignments, votersForItem, type StageAssignmentCandidate } from '@/lib/llm/stage-assignments';

/** PR 3b-A 배정 표 고르기 — DB 없이. */
const row = (assignmentId: string, model: string, changes: Partial<StageAssignmentCandidate> = {}): StageAssignmentCandidate =>
  ({ assignmentId, model, rank: 1, role: 'primary', mode: 'live', vote: false, ...changes });

describe('stage assignment order', () => {
  it('sorts by rank, then assignment id, without touching the input', () => {
    const input = [row('c', 'C', { rank: 2 }), row('b', 'B'), row('a', 'A', { rank: 3 }), row('a2', 'A2')];
    expect(orderStageAssignments(input).map(value => value.assignmentId)).toEqual(['a2', 'b', 'c', 'a']);
    expect(input.map(value => value.assignmentId)).toEqual(['c', 'b', 'a', 'a2']);
  });
});

describe('chooseModelForItem', () => {
  const pool = [row('ai1:1', 'primary-model'), row('ai1:2', 'second-model'), row('ai1:3', 'third-model')];

  it('picks the same slot as the 1st reviewer pool for every candidate id (the flag flip keeps AI1 identical)', () => {
    const reviewers = pool.map(value => ({ provider: 'abcllm' as const, model: value.model }));
    for (let candidateId = 1; candidateId <= 12; candidateId++)
      expect(chooseModelForItem(pool, candidateId)?.model).toBe(selectFirstReviewer(reviewers, candidateId)?.model);
    // the untouched-candidate rotation past a blocked model matches too
    const blocked = new Set([JSON.stringify(['abcllm', 'second-model'])]);
    for (let candidateId = 1; candidateId <= 12; candidateId++)
      expect(chooseModelForItem(pool, candidateId, { excludeModels: ['second-model'] })?.model)
        .toBe(selectFirstReviewer(reviewers, candidateId, [], [], { blocked })?.model);
  });

  it('is deterministic, ignores off/shadow/helper rows and falls back to the next rank only when the whole rank is excluded', () => {
    const rows = [...pool, row('ai1:9', 'fallback', { rank: 2 }), row('ai1:0', 'off-model', { mode: 'off' }),
      row('ai1:h', 'helper-model', { role: 'helper' }), row('ai1:s', 'shadow-model', { mode: 'shadow' })];
    expect(chooseModelForItem(rows, 4)?.assignmentId).toBe('ai1:1');
    expect(chooseModelForItem(rows, 4)).toBe(chooseModelForItem([...rows].reverse(), 4));
    expect(chooseModelForItem(rows, 5, { excludeModels: ['second-model'] })?.model).toBe('third-model');
    expect(chooseModelForItem(rows, 5, { excludeModels: new Set(['primary-model', 'second-model', 'third-model']) })?.model).toBe('fallback');
    expect(chooseModelForItem(rows, 5, { excludeModels: ['primary-model', 'second-model', 'third-model', 'fallback'] })).toBeNull();
    expect(chooseModelForItem(rows.filter(value => value.rank === 2), 7)?.model).toBe('fallback');      // a lone rank-2 row still serves
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(chooseModelForItem(rows, bad)).toBeNull();
    expect(chooseModelForItem([], 1)).toBeNull();
  });
});

describe('votersForItem', () => {
  const rows = [row('ai2:b', 'qwen3.8-flash-next', { vote: true }), row('ai2:a', 'gpt-oss-120b', { vote: true }), row('ai2:c', 'grok-4.7', { vote: true }),
    row('ai2:fallback', 'sonnet', { rank: 2 }), row('ai2:silent', 'opus'), row('ai2:off', 'deepseek', { vote: true, mode: 'off' }),
    row('ai2:helper', 'helper', { vote: true, role: 'helper' })];

  it('returns the rank-1 live voters minus the 1st reviewer’s own weights, rotated by the item', () => {
    expect(votersForItem(rows, 1, null).map(value => value.assignmentId)).toEqual(['ai2:a', 'ai2:b', 'ai2:c']);
    expect(votersForItem(rows, 2, null).map(value => value.assignmentId)).toEqual(['ai2:b', 'ai2:c', 'ai2:a']);
    // the same weights under a gateway label or publisher prefix are one model (sameUnderlyingModel) — that vote would echo AI1
    expect(votersForItem(rows, 1, '[gpu3090] qwen3.8-flash-next').map(value => value.model)).toEqual(['gpt-oss-120b', 'grok-4.7']);
    expect(new Set(votersForItem(rows, 5, '[gpu3090] qwen3.8-flash-next').map(value => value.model))).toEqual(new Set(['gpt-oss-120b', 'grok-4.7']));
  });

  it('takes an injected comparator, and returns nothing for a bad item or no voters', () => {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    expect(votersForItem(rows, 1, 'GROK-4.7', same).map(value => value.model)).toEqual(['gpt-oss-120b', 'qwen3.8-flash-next']);
    expect(votersForItem(rows, 0, null)).toEqual([]);
    expect(votersForItem(rows.filter(value => !value.vote), 1, null)).toEqual([]);
    expect(votersForItem(rows, 1, 'gpt-oss-120b', () => true)).toEqual([]);
  });
});
