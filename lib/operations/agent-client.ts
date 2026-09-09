import { createHmac } from 'node:crypto';
export function agentToken(secret: string) { return createHmac('sha256', secret).update('nomorevibe-connect-agent-rpc-v1').digest('hex'); }
export async function agentRequest<T>(action: string, data: unknown = {}): Promise<T> {
  const url = process.env.CONNECT_AGENT_URL;
  const secret = process.env.OPERATIONS_AGENT_SECRET ?? process.env.AUTH_SECRET;
  if (!url || !secret || secret.length < 32) throw new Error('AI 연결 서비스를 설정해주세요.');
  const response = await fetch(`${url}/rpc`, { method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken(secret)}` },
    body: JSON.stringify({ action, data }), signal: AbortSignal.timeout(action === 'classify' ? 85_000 : 10_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'AI 연결 서비스 요청 실패');
  return result as T;
}
