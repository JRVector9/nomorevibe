import type { Server } from 'node:http';
import type { ConnectAgent } from './agent';

/** ConnectAgent requires a container stop grace longer than this drain. No dispatch is refunded here. */
export const CONNECT_AGENT_DRAIN_MS = 180_000;

export async function shutdownConnectAgent(agent: Pick<ConnectAgent, 'drain' | 'close'>,
  server: Pick<Server, 'close'>): Promise<0 | 1> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('connect_agent_drain_timeout')), CONNECT_AGENT_DRAIN_MS);
    });
    const draining = agent.drain();
    const closed = new Promise<void>((resolve, reject) => server.close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    }));
    await Promise.race([Promise.all([draining, closed]), deadline]);
    agent.close();
    return 0;
  } catch {
    // Unknown physical end or failed reconciliation stays charged. Do not delete its local artifacts.
    return 1;
  } finally { clearTimeout(timer); }
}
