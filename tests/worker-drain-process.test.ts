import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';

it.each(['drain', 'cancel'] as const)('uses real child IPC to %s a held HTTP model response', async mode => {
  let response: ServerResponse | undefined, disconnected = false, requests = 0;
  const server = createServer((request, reply) => {
    request.resume(); requests++;
    response = reply;
    reply.on('close', () => { if (!reply.writableEnded) disconnected = true; });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address');
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/runtime-drain-worker.ts', `http://127.0.0.1:${address.port}`], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', value => { output += String(value); });
  child.stderr!.on('data', value => { output += String(value); });
  const messages: Array<{ type: string; state?: string; result?: unknown }> = [];
  child.on('message', message => messages.push(message as typeof messages[number]));
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    await vi.waitFor(() => expect(response, output).toBeDefined(), { timeout: 10_000 });
    if (mode === 'drain') child.send({ type: 'runtime.drain' });
    else child.kill('SIGTERM');
    await vi.waitFor(() => expect(messages.some(message => message.state === 'stopping')).toBe(true));
    const terminal = { choices: [{ finish_reason: 'stop' }], usage: { total_tokens: 15 } };
    if (mode === 'drain') {
      expect(disconnected).toBe(false);
      expect(messages.some(message => message.type === 'fixture.cancelled')).toBe(false);
      response!.end(JSON.stringify(terminal));
    } else {
      await vi.waitFor(() => expect(disconnected).toBe(true));
    }
    expect(await exited, output).toBe(0);
    expect(requests).toBe(1);
    expect(messages.filter(message => message.type.startsWith('fixture.'))).toEqual(mode === 'drain'
      ? [{ type: 'fixture.recorded', name: 'crawl-fetch', result: terminal }]
      : [{ type: 'fixture.cancelled', name: 'crawl-fetch' }]);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 20_000);
