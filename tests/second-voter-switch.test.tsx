import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), settings: vi.fn(), save: vi.fn(), engines: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/operations/dr/epoch', async original => ({ ...await original<typeof import('@/lib/operations/dr/epoch')>(), readWriterFence: async () => ({ state: 'active' }) })); // PR15e: 웹 쓰기 관문은 dr-web-fence 테스트가 본다(이 fixture 의 요청 흐름 불변)
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings, saveSettings: mocks.save, changeReviewMode: vi.fn() }));
vi.mock('@/lib/crawl/agent-review-gateway', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/crawl/agent-review-gateway')>(), listReviewEngineModels: mocks.engines,
}));

import { switchSecondVoter } from '@/app/(operator)/admin/review/actions';
import { SecondVoterSwitch } from '@/app/(operator)/admin/review/SecondVoterSwitch';
import { parseVoterValue, voterChoices } from '@/app/(operator)/admin/review/voters';

/** 심사 경로에 엔진 직접 연결 계약이 켜진 abcllm 모델(listReviewEngineModels) */
const ENGINES = ['[MLX] gpt-oss-120b', '[supa] Qwen3.8-27B-NVFP4', 'qwen3-coder:30b'];
const settings = { firstReview: { provider: 'abcllm', model: '[MLX] gpt-oss-120b' },
  secondReview: { enabled: true, voters: [{ provider: 'grok-cli', model: 'grok-4.7' }], fallbacks: [{ provider: 'claude-cli', model: 'sonnet' }], agreeAt: 0.7 } };
const form = (voter: string) => { const data = new FormData(); data.set('voter', voter); return data; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.settings.mockResolvedValue(settings);
  mocks.save.mockResolvedValue({ ok: true });
  mocks.engines.mockResolvedValue(ENGINES);
});

describe('2차 표 선택지', () => {
  it('현재 직접 모델의 provider를 게이트웨이로 바꾸지 않는다', () => {
    const current = { provider: 'local-direct', model: 'qwen3.8-flash-next' };
    expect(voterChoices(ENGINES, current, null)[0]).toMatchObject({ ...current, value: 'local-direct|qwen3.8-flash-next' });
    expect(parseVoterValue('local-direct|qwen3.8-flash-next')).toEqual(current);
  });
  it('Grok·게이트웨이·Claude 를 묶어 보이고, 1차와 같은 모델은 막는다', () => {
    const choices = voterChoices(ENGINES, settings.secondReview.voters[0], settings.firstReview.model);
    expect(choices.map((choice) => choice.group)).toEqual(expect.arrayContaining(['Grok CLI — 구독, 주간 한도', '사내 게이트웨이 — 한도 없음', 'Claude CLI — 구독 한도']));
    expect(choices.find((choice) => choice.model === '[MLX] gpt-oss-120b')?.disabled).toBe('1차와 같은 모델');
    expect(choices.find((choice) => choice.model === '[supa] Qwen3.8-27B-NVFP4')?.disabled).toBeNull();
  });

  it('지금 세운 표가 목록에 없어도 보이고, 게이트웨이를 못 읽으면 Grok·Claude 만', () => {
    const choices = voterChoices(null, { provider: 'abcllm', model: '[MLX] gone-model' }, null);
    expect(choices[0]).toMatchObject({ model: '[MLX] gone-model', group: '지금 세운 표' });
    expect(choices.filter((choice) => choice.provider === 'abcllm')).toHaveLength(1);
  });

  it('값은 "제공자|모델" — 모델 이름의 공백·대괄호를 그대로 받는다', () => {
    expect(parseVoterValue('abcllm|[supa] Qwen3.8-27B-NVFP4')).toEqual({ provider: 'abcllm', model: '[supa] Qwen3.8-27B-NVFP4' });
    for (const bad of ['', 'evil|x', 'abcllm|', '|grok-4.7', 42]) expect(parseVoterValue(bad)).toBeNull();
  });
});

describe('2차 표 바꾸기', () => {
  it('직접 모델의 현재 선택은 보존하고 목록 밖 직접 모델 전환은 막는다', async () => {
    mocks.settings.mockResolvedValue({ ...settings, secondReview: { ...settings.secondReview,
      voters: [{ provider: 'local-direct', model: 'qwen3.8-flash-next' }] } });
    expect(await switchSecondVoter(null, form('local-direct|qwen3.8-flash-next'))).toMatchObject({ message: expect.stringContaining('이미') });
    expect(await switchSecondVoter(null, form('local-direct|other-engine'))).toHaveProperty('error');
    expect(mocks.engines).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('고른 표 하나로 바꾸고, 대체와 기준값은 그대로 저장한다', async () => {
    expect(await switchSecondVoter(null, form('abcllm|[supa] Qwen3.8-27B-NVFP4'))).toMatchObject({ message: expect.stringContaining('Qwen3.8') });
    expect(mocks.save).toHaveBeenCalledWith({ secondReview: { ...settings.secondReview,
      voters: [{ provider: 'abcllm', model: '[supa] Qwen3.8-27B-NVFP4' }] } }, 'jr');
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/review');
  });

  it('로그인하지 않았거나, 목록 밖이거나, 1차와 같거나, 이미 그 모델이면 저장하지 않는다', async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await switchSecondVoter(null, form('grok-cli|grok-4.7'))).toHaveProperty('error');
    expect(await switchSecondVoter(null, form('abcllm|[MLX] not-there'))).toMatchObject({ error: expect.stringContaining('직접 연결 계약') });
    expect(await switchSecondVoter(null, form('grok-cli|grok-9'))).toHaveProperty('error');
    expect(await switchSecondVoter(null, form('abcllm|[MLX] gpt-oss-120b'))).toMatchObject({ error: expect.stringContaining('1차와 같은') });
    expect(await switchSecondVoter(null, form('grok-cli|grok-4.7'))).toMatchObject({ message: expect.stringContaining('이미') });
    mocks.engines.mockResolvedValueOnce([]);
    expect(await switchSecondVoter(null, form('abcllm|[supa] Qwen3.8-27B-NVFP4'))).toHaveProperty('error');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('머리에 지금 2차 표를 보이고, 직접 연결된 심사 모델이 없으면 알린다', () => {
    const html = renderToStaticMarkup(<SecondVoterSwitch current={settings.secondReview.voters[0]}
      choices={voterChoices(null, settings.secondReview.voters[0], settings.firstReview.model)} gatewayReachable={false} />);
    expect(html).toContain('2차 표');
    expect(html).toContain('grok-4.7');
    expect(html).toContain('직접 연결 계약이 켜진 심사 모델이 없습니다');
  });
});

describe('심사 엔진 모델 목록', () => {
  afterEach(async () => {
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    (await import('@/lib/llm/serving-contract-store')).setServingContractSnapshotForTest(null);
  });
  it('심사 경로의 직접 연결 계약 중 부를 수 있는 모델만 정렬해 돌려주고, 네트워크·ABCLLM_API_KEY 는 읽지 않는다', async () => {
    const { listReviewEngineModels } = await vi.importActual<typeof import('@/lib/crawl/agent-review-gateway')>('@/lib/crawl/agent-review-gateway');
    const store = await import('@/lib/llm/serving-contract-store');
    vi.stubEnv('ABCLLM_API_KEY', 'test-key');
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network_not_allowed'));
    const row = (routeId: string, model: string, auth: 'none' | 'stored' | 'gateway' = 'none', transport: 'direct' | 'gateway' = 'direct',
      apiKey: string | null = null) => ({ routeId, model, contract: null, auth, apiKey, transport });
    store.setServingContractSnapshotForTest([
      row('second-review', 'qwen3-coder:30b'),
      row('crawl-agent-review', '[MLX] gpt-oss-120b'),
      row('second-review', '[MLX] gpt-oss-120b'),
      row('second-review', '[supa] Qwen3.8-27B-NVFP4', 'stored', 'direct', 'engine-key'),
      row('second-review', '[MLX] gateway-transport', 'none', 'gateway'),
      row('second-review', '[MLX] gateway-auth', 'gateway'),
      row('crawl-agent-review', '[MLX] key-unreadable', 'stored', 'direct', null),
      row('reason-translate', '[MLX] other-route'),
      row('product-search-profile', 'profile-model'),
      // PR 3b-C local-direct contract rows are engines, not abcllm choices
      { ...row('crawl-agent-review', 'qwen3.6-35b-engine', 'none', 'gateway'), contract: { provider: 'local-direct', protocol: 'direct-openai-chat-v1' } },
    ]);
    expect(await listReviewEngineModels()).toEqual(['[MLX] gpt-oss-120b', '[supa] Qwen3.8-27B-NVFP4', 'qwen3-coder:30b']);
    store.setServingContractSnapshotForTest([]);
    expect(await listReviewEngineModels()).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
});
