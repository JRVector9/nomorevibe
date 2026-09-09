import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRequest } from '@/lib/operations/agent-client';

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
});
