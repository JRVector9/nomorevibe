import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRequest } from '@/lib/operations/agent-client';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('operations agent client authentication', () => {
  it('does not reuse the administrator session secret when the agent secret is absent', async () => {
    vi.stubEnv('CONNECT_AGENT_URL', 'http://connect-agent:3020');
    vi.stubEnv('AUTH_SECRET', 'a'.repeat(32));
    vi.stubEnv('OPERATIONS_AGENT_SECRET', undefined);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(agentRequest('status')).rejects.toThrow('AI 연결 서비스를 설정해주세요.');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves a bounded admission deferral across the authenticated RPC', async () => {
    vi.stubEnv('CONNECT_AGENT_URL', 'http://connect-agent:3020');
    vi.stubEnv('OPERATIONS_AGENT_SECRET', 'a'.repeat(32));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      error: 'model_capacity_deferred', code: 'model_capacity_deferred', reason: 'dispatched',
    }), { status: 409 })));
    await expect(agentRequest('classify', {})).rejects.toMatchObject({
      name: 'ModelCapacityDeferredError', reason: 'dispatched',
    });
    await expect(agentRequest('classify', {})).rejects.toBeInstanceOf(ModelCapacityDeferredError);
  });
  it('does not turn an arbitrary remote message into an admission capability', async () => {
    vi.stubEnv('CONNECT_AGENT_URL', 'http://connect-agent:3020');
    vi.stubEnv('OPERATIONS_AGENT_SECRET', 'a'.repeat(32));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      error: 'model_capacity_deferred', code: 'model_capacity_deferred', reason: 'settled',
    }), { status: 409 })));
    await expect(agentRequest('classify', {})).rejects.not.toBeInstanceOf(ModelCapacityDeferredError);
  });
});
