import { createServer } from 'node:net';
import { Agent, fetch, setGlobalDispatcher } from 'undici';

// A malicious public response must remain a caught transport failure, not crash a worker.
const server = createServer(socket => {
  socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\n'
    + 'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\n'
    + 'Content-Length: 100\r\nConnection: close\r\n\r\nx'));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const dispatcher = new Agent();
// Own the monitor's default pool too, so fixture shutdown does not wait for its
// idle keep-alive timeout after the malicious response has already been caught.
setGlobalDispatcher(dispatcher);
try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (process.argv[2] === 'monitor') {
    const { pushKumaStatus } = await import('../../scripts/watch-failover-readiness.ts');
    await pushKumaStatus(url, 'up', 'worker failover ok');
  } else {
    await fetch(url, { dispatcher });
  }
  throw new Error('excessive_encodings_were_accepted');
} catch (error) {
  if (error.message === 'excessive_encodings_were_accepted') throw error;
  process.stdout.write('transport_failure_caught\n');
} finally {
  await dispatcher.close();
  await new Promise(resolve => server.close(resolve));
}
