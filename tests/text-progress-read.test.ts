import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readTextProgress, textProgressStalled } from '@/lib/operations/text-progress';

const fixture = vi.hoisted(() => ({
  settings: vi.fn(), settingsUnreadable: vi.fn(), control: vi.fn(), translation: vi.fn(), taglines: vi.fn(), rows: vi.fn(),
}));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: fixture.settings, settingsUnreadable: fixture.settingsUnreadable }));
vi.mock('@/lib/llm/capacity-repository', () => ({ readModelCapacityCallerControl: fixture.control }));
vi.mock('@/lib/crawl/translations', () => ({ oldestPendingTranslationMinutes: fixture.translation }));
vi.mock('@/lib/crawl/taglines', () => ({ pendingTaglines: fixture.taglines }));
vi.mock('@/lib/db', () => ({ db: { execute: fixture.rows } }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.settings.mockResolvedValue({ enabled: true });
  fixture.settingsUnreadable.mockReturnValue(false);
  fixture.control.mockResolvedValue({ mode: 'open' });
  fixture.translation.mockResolvedValue(null);
  fixture.taglines.mockResolvedValue([]);
  fixture.rows.mockResolvedValue([{ profile_age: null, verify_age: null, persisted: false, in_backoff: false, provider_error: false }]);
  vi.stubEnv('ABCLLM_API_KEY', 'fixture-key');
});
afterEach(() => vi.unstubAllEnvs());

it.each(['open', 'disabled'])('retains genuine text stall detection with %s admission', async mode => {
  fixture.control.mockResolvedValue({ mode });
  fixture.translation.mockResolvedValue(120);
  const state = await readTextProgress();
  expect(state).toMatchObject({ oldestReadyMinutes: 120, admissionHeld: false });
  expect(textProgressStalled({ ...state, schedulerScheduled: true })).toBe(true);
});

it('holds intentional global drain without erasing demand or provider failures', async () => {
  fixture.control.mockResolvedValue({ mode: 'draining' });
  fixture.translation.mockResolvedValue(120);
  fixture.rows.mockResolvedValue([{ profile_age: 30, verify_age: null, persisted: false, in_backoff: false, provider_error: true }]);
  const state = await readTextProgress();
  expect(state).toMatchObject({ oldestReadyMinutes: 120, admissionHeld: true, providerError: true });
  expect(textProgressStalled({ ...state, schedulerScheduled: true, providerError: false })).toBe(false);
});

it('excludes collection-paused taglines while retaining the same demand when collection is enabled', async () => {
  fixture.taglines.mockResolvedValue([{ readyAgeMinutes: 120 }]);
  expect(textProgressStalled({ ...await readTextProgress(), schedulerScheduled: true })).toBe(true);
  fixture.settings.mockResolvedValue({ enabled: false });
  const state = await readTextProgress();
  expect(state).toMatchObject({ oldestReadyMinutes: null, admissionHeld: false });
  expect(textProgressStalled({ ...state, schedulerScheduled: true })).toBe(false);
});

it.each(['translation', 'profile', 'verify'])('does not let collection pause hide stalled %s work', async queue => {
  fixture.settings.mockResolvedValue({ enabled: false });
  fixture.taglines.mockResolvedValue([{ readyAgeMinutes: 120 }]);
  if (queue === 'translation') fixture.translation.mockResolvedValue(20);
  else fixture.rows.mockResolvedValue([{ profile_age: queue === 'profile' ? 20 : null,
    verify_age: queue === 'verify' ? 20 : null, persisted: false, in_backoff: false, provider_error: false }]);
  const state = await readTextProgress();
  expect(state).toMatchObject({ oldestReadyMinutes: 20, admissionHeld: false });
  expect(textProgressStalled({ ...state, schedulerScheduled: true })).toBe(true);
});

it('does not treat unreadable settings fallback as an intentional collection pause', async () => {
  fixture.control.mockResolvedValue({ mode: 'draining' });
  fixture.settings.mockResolvedValue({ enabled: false });
  fixture.settingsUnreadable.mockReturnValue(true);
  await expect(readTextProgress()).rejects.toThrow('crawl_settings_unreadable');
});

it.each(['settings', 'control', 'translation', 'taglines', 'rows'] as const)(
  'propagates failed or unknown %s observations even during deliberate drain', async source => {
    fixture.control.mockResolvedValue({ mode: 'draining' });
    const failure = new Error(source === 'control' ? 'model_capacity_control_invalid' : `${source}_unavailable`);
    fixture[source].mockRejectedValue(failure);
    await expect(readTextProgress()).rejects.toBe(failure);
  },
);
