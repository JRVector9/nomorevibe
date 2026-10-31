import { afterEach, expect, it } from 'vitest';
import { hostBudgetHoldMs, jobRunOptions, runWorker } from '@/scripts/worker';
import { DEFAULT_RUNTIME_SETTINGS, effectiveJobBudgetMs, resolveRuntimeSettings, storedSettingsVersion } from '@/lib/operations/runtime-settings-schema';
import { defaultRuntimeSettingsSnapshot, lastRuntimeSettingsRead, runtimeSettings, runtimeSettingsSnapshot, setRuntimeSettingsForTest,
  withRuntimeSettings } from '@/lib/operations/runtime-settings-store';
import type { RuntimeLane } from '@/lib/operations/worker-progress';

/**
 * PR 1a D3 — 틱마다 고정한 스냅샷: 줄이 heartbeat 에 알린 예산(RuntimeLane.budgetMs) === runner 가 받은 budgetMs === 잡 안에서 읽는 예산.
 * 틱 중간에 프로세스 스냅샷이 바뀌어도(30초 배경 reload 와 같은 일) 그 틱은 처음 판을 그대로 본다.
 */
afterEach(() => setRuntimeSettingsForTest(null));

const SAVED = { version: 1, budgets: { 'crawl-fetch': 90_000, 'reason-translate': 70_000 } };
const SWAPPED = { version: 1, budgets: { 'crawl-fetch': 40_000, 'reason-translate': 30_000 } };
type Seen = { optionsBudget?: number; before?: number; after?: number; version?: string };
const declaredBudget = (lanes: RuntimeLane[] | undefined, job: string | null) => lanes?.find(lane => lane.currentJob === job)?.budgetMs;

it('declares the lane budget from the same snapshot the job runs in, even when the store swaps mid-tick', async () => {
  setRuntimeSettingsForTest(SAVED);
  const declared: Array<number | null | undefined> = [], seen: Seen = {};
  await runWorker({ role: 'crawler', once: true }, {
    names: ['crawl-fetch'], lanes: [['crawl-fetch']], seen: async () => {}, pending: async () => ['crawl-fetch'],
    report: (state, job, _startedAt, lanes) => { if (state === 'running') declared.push(declaredBudget(lanes, job ?? null)); },
    run: async (name, options) => {
      seen.optionsBudget = options.budgetMs;
      seen.before = effectiveJobBudgetMs(name, runtimeSettings());
      seen.version = runtimeSettingsSnapshot().version;
      // 틱 중간에 프로세스 스냅샷이 바뀐다 — 고정된 틱은 보지 않는다
      setRuntimeSettingsForTest(SWAPPED);
      await new Promise(resolve => setTimeout(resolve, 5));
      seen.after = effectiveJobBudgetMs(name, runtimeSettings());
      return { status: 'completed' };
    },
  });
  expect(declared).toEqual([90_000]);
  expect(seen).toEqual({ optionsBudget: 90_000, before: 90_000, after: 90_000, version: storedSettingsVersion(SAVED) });
  // 틱 밖에서는 바뀐 판이 보이고, heartbeat 가 싣는 '읽은 판'은 그 틱이 고정한 판이다
  expect(runtimeSettings().budgets['crawl-fetch']).toBe(40_000);
  expect(lastRuntimeSettingsRead()).toEqual({ version: storedSettingsVersion(SAVED), at: expect.any(Number), registryEnv: false });
});

it('pins the background consumer lane the same way', async () => {
  setRuntimeSettingsForTest(SAVED);
  const declared: Array<number | null | undefined> = [], seen: Seen = {};
  await runWorker({ role: 'text', once: true }, {
    names: ['reason-translate', 'product-translate'], lanes: [['product-translate']], seen: async () => {}, pending: async () => ['reason-translate'],
    report: (state, job, _startedAt, lanes) => { if (state === 'running') declared.push(declaredBudget(lanes, job ?? null)); },
    run: async () => { throw new Error('main lane must not run the consumer job'); },
    consumer: { names: ['reason-translate'], open: async () => true, request: async () => {},
      run: async (name, options) => {
        seen.optionsBudget = options.budgetMs;
        seen.before = effectiveJobBudgetMs(name, runtimeSettings());
        setRuntimeSettingsForTest(SWAPPED);
        await new Promise(resolve => setTimeout(resolve, 5));
        seen.after = effectiveJobBudgetMs(name, runtimeSettings());
        seen.version = runtimeSettingsSnapshot().version;
        return { status: 'completed', done: true };
      } },
  });
  expect(declared).toEqual([70_000]);
  expect(seen).toEqual({ optionsBudget: 70_000, before: 70_000, after: 70_000, version: storedSettingsVersion(SAVED) });
});

it('reads the snapshot once per poll — every job of that poll sees one version, the next poll sees the new one', async () => {
  setRuntimeSettingsForTest(SAVED);
  const versions: Array<[string, string, number | undefined]> = [];
  const stop = new AbortController();
  let polls = 0;
  await runWorker({ role: 'crawler', intervalMs: 1_000, signal: stop.signal }, {
    names: ['crawl-fetch', 'crawl-seed'], lanes: [['crawl-fetch', 'crawl-seed']], seen: async () => {},
    // 세 번째 poll 에서 멈춘다 — 두 poll 사이의 sleep 에서 프로세스 스냅샷이 바뀐다(30초 배경 reload 와 같다)
    pending: async () => { if (++polls === 3) { stop.abort(); return []; } return ['crawl-fetch', 'crawl-seed']; },
    sleep: async () => { setRuntimeSettingsForTest(SWAPPED); },
    run: async (name, options) => { versions.push([name, runtimeSettingsSnapshot().version, options.budgetMs]); return { status: 'completed' }; },
  });
  expect(versions).toEqual([
    ['crawl-fetch', storedSettingsVersion(SAVED), 90_000], ['crawl-seed', storedSettingsVersion(SAVED), 30_000],
    ['crawl-fetch', storedSettingsVersion(SWAPPED), 40_000], ['crawl-seed', storedSettingsVersion(SWAPPED), 30_000],
  ]);
});

it('lets replay and tests inject a fixed snapshot so the declared budget ignores the process store', async () => {
  setRuntimeSettingsForTest(SAVED);
  const declared: Array<number | null | undefined> = [];
  let inside: string | undefined;
  await runWorker({ role: 'crawler', once: true }, {
    names: ['crawl-fetch'], lanes: [['crawl-fetch']], seen: async () => {}, pending: async () => ['crawl-fetch'],
    settings: async () => defaultRuntimeSettingsSnapshot(),
    report: (state, job, _startedAt, lanes) => { if (state === 'running') declared.push(declaredBudget(lanes, job ?? null)); },
    run: async (_name, options) => { inside = runtimeSettingsSnapshot().version; expect(options.budgetMs).toBe(120_000); return { status: 'completed' }; },
  });
  expect(declared).toEqual([120_000]);
  expect(inside).toBe('default');
});

it('jobRunOptions keeps the document sparse: unlisted jobs return the options unchanged, "auto" follows the route ceiling + margin', () => {
  const base = { requestedOnly: true as const };
  expect(jobRunOptions('crawl-tagline', base)).toEqual(base);
  expect(jobRunOptions('heartbeat', base)).toEqual(base);
  expect(jobRunOptions('product-translate', base)).toEqual({ ...base, budgetMs: 315_000 });
  const { settings, issues } = resolveRuntimeSettings({ version: 1, budgets: { 'crawl-tagline': 60_000, 'crawl-fetch': 90_000 }, translation: { product: { jobMarginMs: 30_000 } } });
  expect(issues).toEqual([]);
  expect(jobRunOptions('crawl-tagline', base, settings)).toEqual({ ...base, budgetMs: 60_000 });
  expect(jobRunOptions('crawl-fetch', base, settings)).toEqual({ ...base, budgetMs: 90_000 });
  expect(jobRunOptions('product-translate', base, settings)).toEqual({ ...base, budgetMs: 330_000 });
  expect(jobRunOptions('crawl-publish', base, settings)).toEqual({ ...base, budgetMs: 120_000 });
  // 인자를 생략하면 지금 판 — 고정된 틱 안에서는 그 틱의 판
  setRuntimeSettingsForTest({ version: 1, budgets: { 'crawl-seed': 45_000 } });
  expect(jobRunOptions('crawl-seed', base)).toEqual({ ...base, budgetMs: 45_000 });
  expect(withRuntimeSettings(defaultRuntimeSettingsSnapshot(), () => jobRunOptions('crawl-seed', base))).toEqual({ ...base, budgetMs: 30_000 });
});

it('holds the host-budget slot at boot for the longest declared budget + margin + drain, never below env job + drain', () => {
  const limits = { jobMs: 180_000, drainMs: 45_000 };
  expect(hostBudgetHoldMs(limits, ['product-translate', 'reason-translate'], DEFAULT_RUNTIME_SETTINGS)).toBe(315_000 + 45_000 + 45_000);
  expect(hostBudgetHoldMs(limits, ['crawl-fetch', 'crawl-seed', 'crawl-tagline'], DEFAULT_RUNTIME_SETTINGS)).toBe(180_000 + 45_000);
  const raised = resolveRuntimeSettings({ version: 1, budgets: { 'crawl-fetch': 600_000 } }).settings;
  expect(hostBudgetHoldMs(limits, ['crawl-fetch'], raised)).toBe(600_000 + 45_000 + 45_000);
  expect(hostBudgetHoldMs(limits, [], DEFAULT_RUNTIME_SETTINGS)).toBe(180_000 + 45_000);
});
