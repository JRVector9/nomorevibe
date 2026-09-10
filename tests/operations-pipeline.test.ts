import { expect, it } from 'vitest';
import { findBottleneck, type PipelineStage } from '@/lib/operations/pipeline';

const stage = (over: Partial<PipelineStage> & { key: string }): PipelineStage =>
  ({ label: over.key, waiting: 0, entered: null, left: null, job: null, ...over });

it('빠진 것이 없는데 쌓여 있는 단계를 짚는다', () => {
  expect(findBottleneck([
    stage({ key: 'fetch', waiting: 21, left: 0 }),
    stage({ key: 'judge', waiting: 4, left: 12 }),
  ])).toBe('fetch');
});

it('빠지는 것을 재지 않는 단계는 병목이 아니다 — 누적값이 가장 크다고 잡히면 안 된다', () => {
  expect(findBottleneck([
    stage({ key: 'discover', waiting: 4070, left: null }),
    stage({ key: 'public', waiting: 34, left: null }),
    stage({ key: 'fetch', waiting: 21, left: 0 }),
  ])).toBe('fetch');
});

it('쌓인 것이 없으면 병목이 아니다', () => {
  expect(findBottleneck([stage({ key: 'judge', waiting: 0, left: 0 })])).toBeNull();
});

it('막힌 단계가 여럿이면 가장 많이 쌓인 곳을 짚는다', () => {
  expect(findBottleneck([
    stage({ key: 'publish', waiting: 3, left: 0 }),
    stage({ key: 'review', waiting: 378, left: 0 }),
  ])).toBe('review');
});

it('모든 단계가 흐르면 병목이 없다', () => {
  expect(findBottleneck([
    stage({ key: 'fetch', waiting: 21, left: 130 }),
    stage({ key: 'judge', waiting: 4, left: 128 }),
  ])).toBeNull();
});
