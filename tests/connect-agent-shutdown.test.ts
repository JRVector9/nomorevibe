import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  drain: vi.fn(), close: vi.fn(), listen: vi.fn(), serverClose: vi.fn(), probe: vi.fn(),
  signal: new Map<string, () => void>(), closed: undefined as (() => void) | undefined,
}));
vi.mock('@/lib/operations/agent', () => ({ ConnectAgent: class {
  drain = fixture.drain;
  close = fixture.close;
  snapshot = () => ({});
} }));
vi.mock('@/lib/operations/agent-client', () => ({ agentToken: () => 'local-test-only' }));
vi.mock('@/lib/operations/observations', () => ({ observeService: vi.fn() }));
vi.mock('@/lib/llm/cli-serving-contract', () => ({ probeCliServingContracts: fixture.probe }));
vi.mock('node:http', () => ({ createServer: () => ({
  close: fixture.serverClose, listen: fixture.listen,
}) }));

const originalOn = process.on.bind(process);
let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.stubEnv('OPERATIONS_AGENT_SECRET', 'local-only-secret-with-at-least-32-characters');
  fixture.signal.clear(); fixture.closed = undefined;
  for (const mock of [fixture.drain, fixture.close, fixture.listen, fixture.serverClose, fixture.probe]) mock.mockReset();
  fixture.probe.mockResolvedValue([]);
  fixture.serverClose.mockImplementation((done: () => void) => { fixture.closed = done; });
  vi.spyOn(process, 'on').mockImplementation(((name: string, callback: () => void) => {
    if (name === 'SIGTERM' || name === 'SIGINT') { fixture.signal.set(name, callback); return process; }
    return originalOn(name, callback);
  }) as typeof process.on);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function start() { await import('../scripts/connect-agent'); await Promise.resolve(); }
async function flush() { await vi.advanceTimersByTimeAsync(0); }

it('waits for the admitted classification and HTTP close before deleting credentials or exiting', async () => {
  let settled!: () => void;
  fixture.drain.mockImplementation(() => new Promise<void>(resolve => { settled = resolve; }));
  await start(); fixture.signal.get('SIGTERM')!();
  expect(exit).not.toHaveBeenCalled(); expect(fixture.close).not.toHaveBeenCalled();
  expect(fixture.drain).toHaveBeenCalledTimes(1);
  settled(); await flush(); expect(exit).not.toHaveBeenCalled();
  fixture.closed!(); await flush();
  expect(fixture.close).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(0);
});

it('bounds an unproven drain without closing credentials or manufacturing a successful exit', async () => {
  fixture.drain.mockReturnValue(new Promise(() => {}));
  await start(); fixture.signal.get('SIGTERM')!(); fixture.closed?.();
  await vi.advanceTimersByTimeAsync(44_999); expect(exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(exit).toHaveBeenCalledWith(1); expect(fixture.close).not.toHaveBeenCalled();
});

it('fails closed when the admitted native operation rejects instead of treating an error as settled success', async () => {
  fixture.drain.mockRejectedValue(new Error('terminal settlement failed'));
  await start(); fixture.signal.get('SIGINT')!(); fixture.closed?.(); await flush();
  expect(exit).toHaveBeenCalledWith(1); expect(fixture.close).not.toHaveBeenCalled();
});

it('does not reopen admission if shutdown arrives while CLI contracts are still probing', async () => {
  let probed!: () => void;
  fixture.probe.mockReturnValue(new Promise<void>(resolve => { probed = resolve; }));
  fixture.drain.mockResolvedValue(undefined);
  await start(); fixture.signal.get('SIGTERM')!(); fixture.closed?.(); probed(); await flush();
  expect(fixture.listen).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(0);
});

it('starts one drain when both termination signals arrive', async () => {
  fixture.drain.mockReturnValue(new Promise(() => {}));
  await start(); fixture.signal.get('SIGTERM')!(); fixture.signal.get('SIGINT')!();
  expect(fixture.drain).toHaveBeenCalledTimes(1); expect(fixture.serverClose).toHaveBeenCalledTimes(1);
});
