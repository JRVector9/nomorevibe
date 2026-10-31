import { expect, it } from 'vitest';
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { mergeWithDefaults, settingsUnreadable } from '@/lib/crawl/settings';
import { combineVerdicts } from '@/lib/crawl/second-review';

const primary = { provider: 'local-direct' as const, model: 'qwen3.8-flash-next' };
const fallback = { provider: 'abcllm' as const, model: '[supa] Qwen3.8-27B-NVFP4' };

it('reads a direct AI2 primary and gateway fallback without changing any other setting', () => {
  const saved = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), secondReview: {
    ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), voters: [primary], fallbacks: [fallback],
  } };
  expect(crawlSettingsSchema.parse(saved)).toEqual(saved);
  const read = mergeWithDefaults(saved);
  expect(settingsUnreadable(read)).toBe(false);
  expect(read).toEqual(saved);
});

// PR 3b-C (transport unify): the same direct engine may also be the first reviewer; it round-trips like any other first reviewer.
it('reads a direct first reviewer and keeps CLI model names narrow', () => {
  const saved = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), firstReview: primary, firstReviewAdditional: [fallback] };
  expect(crawlSettingsSchema.parse(saved)).toEqual(saved);
  const read = mergeWithDefaults(saved);
  expect(settingsUnreadable(read)).toBe(false);
  expect(read.firstReview).toEqual(primary);
  expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: 'local-direct', model: '[gpu3090] Qwen 3.8' } }).success).toBe(true);
  expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: 'claude-cli', model: '[gpu3090] Qwen 3.8' } }).success).toBe(false);
  expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: 'codex-cli', model: 'gpt' } }).success).toBe(false);
});

it('preserves the same Qwen consensus policy across the transport change', () => {
  const first = { provider: 'abcllm' as const, model: '[MLX] gpt-oss-120b', decision: 'approve', confidence: .9 };
  const vote = { model: primary.model, decision: 'approve', confidence: .1 };
  expect(combineVerdicts(first, { ...vote, provider: 'local-direct' }, .85, false))
    .toBe(combineVerdicts(first, { ...vote, provider: 'abcllm' }, .85, false));
});
