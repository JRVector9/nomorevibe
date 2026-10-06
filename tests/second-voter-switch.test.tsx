import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), settings: vi.fn(), save: vi.fn(), gateway: vi.fn(), revalidate: vi.fn() }));
vi.mock('@/lib/auth/admin', () => ({ currentAdmin: mocks.admin }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings, saveSettings: mocks.save, changeReviewMode: vi.fn() }));
vi.mock('@/lib/crawl/agent-review-gateway', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/crawl/agent-review-gateway')>(), listGatewayModels: mocks.gateway,
}));

import { switchSecondVoter } from '@/app/admin/review/actions';
import { SecondVoterSwitch } from '@/app/admin/review/SecondVoterSwitch';
import { parseVoterValue, voterChoices } from '@/app/admin/review/voters';

const GATEWAY = ['[MLX] gpt-oss-120b', '[supa] Qwen3.8-27B-NVFP4', 'qwen3-coder:30b'];
const settings = { firstReview: { provider: 'abcllm', model: '[MLX] gpt-oss-120b' },
  secondReview: { enabled: true, voters: [{ provider: 'grok-cli', model: 'grok-4.7' }], fallbacks: [{ provider: 'claude-cli', model: 'sonnet' }], agreeAt: 0.7 } };
const form = (voter: string) => { const data = new FormData(); data.set('voter', voter); return data; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: 'jr' });
  mocks.settings.mockResolvedValue(settings);
  mocks.save.mockResolvedValue({ ok: true });
  mocks.gateway.mockResolvedValue(GATEWAY);
});

describe('2차 표 선택지', () => {
  it('Grok·게이트웨이·Claude 를 묶어 보이고, 1차와 같은 모델은 막는다', () => {
    const choices = voterChoices(GATEWAY, settings.secondReview.voters[0], settings.firstReview.model);
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
  it('고른 표 하나로 바꾸고, 대체와 기준값은 그대로 저장한다', async () => {
    expect(await switchSecondVoter(null, form('abcllm|[supa] Qwen3.8-27B-NVFP4'))).toMatchObject({ message: expect.stringContaining('Qwen3.8') });
    expect(mocks.save).toHaveBeenCalledWith({ secondReview: { ...settings.secondReview,
      voters: [{ provider: 'abcllm', model: '[supa] Qwen3.8-27B-NVFP4' }] } }, 'jr');
    expect(mocks.revalidate).toHaveBeenCalledWith('/admin/review');
  });

  it('로그인하지 않았거나, 목록 밖이거나, 1차와 같거나, 이미 그 모델이면 저장하지 않는다', async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await switchSecondVoter(null, form('grok-cli|grok-4.7'))).toHaveProperty('error');
    expect(await switchSecondVoter(null, form('abcllm|[MLX] not-there'))).toMatchObject({ error: expect.stringContaining('게이트웨이') });
    expect(await switchSecondVoter(null, form('grok-cli|grok-9'))).toHaveProperty('error');
    expect(await switchSecondVoter(null, form('abcllm|[MLX] gpt-oss-120b'))).toMatchObject({ error: expect.stringContaining('1차와 같은') });
    expect(await switchSecondVoter(null, form('grok-cli|grok-4.7'))).toMatchObject({ message: expect.stringContaining('이미') });
    mocks.gateway.mockResolvedValueOnce(null);
    expect(await switchSecondVoter(null, form('abcllm|[supa] Qwen3.8-27B-NVFP4'))).toHaveProperty('error');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('머리에 지금 2차 표를 보이고, 게이트웨이를 못 읽으면 알린다', () => {
    const html = renderToStaticMarkup(<SecondVoterSwitch current={settings.secondReview.voters[0]}
      choices={voterChoices(null, settings.secondReview.voters[0], settings.firstReview.model)} gatewayReachable={false} />);
    expect(html).toContain('2차 표');
    expect(html).toContain('grok-4.7');
    expect(html).toContain('게이트웨이 모델 목록을 읽지 못했습니다');
  });
});

describe('게이트웨이 모델 목록', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('대화 모델만 돌려주고, 키가 없거나 닿지 않으면 null', async () => {
    const { listGatewayModels } = await vi.importActual<typeof import('@/lib/crawl/agent-review-gateway')>('@/lib/crawl/agent-review-gateway');
    vi.stubEnv('ABCLLM_API_KEY', 'test-key');
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'bge-m3:latest' }, { id: '[MLX] whisper-large-v3-turbo' },
      { id: '[MLX] qwen3-vl-30b' }, { id: '[supa] Qwen3.8-27B-NVFP4' }, { id: 'qwen3-coder:30b' }] })));
    expect(await listGatewayModels({ request: request as never })).toEqual(['[supa] Qwen3.8-27B-NVFP4', 'qwen3-coder:30b']);
    expect(await listGatewayModels({ request: (async () => new Response('', { status: 502 })) as never })).toBeNull();
    vi.stubEnv('ABCLLM_API_KEY', '');
    expect(await listGatewayModels({ request: request as never })).toBeNull();
  });
});
