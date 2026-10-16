// Real isolated process: no request/DB/dispatcher mocks.
import { fetchCapped, safeFetch, readBodyCapped } from '../../../lib/net/fetch';
import type postgres from 'postgres';
function phase(value: string): void { try { if (process.connected) process.send?.({ kind: 'phase', phase: value }, () => {}); } catch { /* Diagnostics do not replace the original result. */ } }
// Temporary observation: only the timeout100 capped rival receives bounded GC.
function probe(phase: string, fields: Record<string, string | number | boolean>): void {
  try { if (process.connected) process.send?.({ kind: 'permit_probe', phase, ...fields }, () => {}); }
  catch { /* Diagnostics do not replace the result. */ }
}
function startProbeGc(): () => void {
  if (process.env.HTTP_TEST_GC !== '1' || process.env.HTTP_TEST_API !== 'capped' || process.env.HTTP_TEST_TIMEOUT !== '100') return () => {};
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) throw new Error('http_fixture_gc_unavailable');
  let gcCount = 0;
  const timer = setInterval(() => {
    gcCount++;
    probe('worker.gc.begin', { gcCount });
    gc();
    probe('worker.gc.end', { gcCount });
    if (gcCount === 8) clearInterval(timer);
  }, 10);
  return () => clearInterval(timer);
}
void (async()=>{
const parent = process.env.HTTP_TEST_PARENT_PID;
if (!parent || !/^[1-9][0-9]*$/.test(parent)) throw new Error('http_fixture_parent_identity');
const database = new URL(process.env.DATABASE_URL!);
database.searchParams.set('application_name', `nvm-http-fixture-${parent}-${process.pid}`);
process.env.DATABASE_URL = database.toString();
// Opt-in only: retaining/listening to a timeout signal can change its lifetime.
// The first observation run leaves this OFF and keeps the original signal path.
if (process.env.HTTP_TEST_OBSERVE_TIMEOUT === '1') {
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = function (delay: number): AbortSignal {
    const signal = Reflect.apply(timeout, this, [delay]);
    if (delay === 100) signal.addEventListener('abort', () => phase('worker.timeout_100.abort'), { once: true });
    return signal;
  };
}
if(process.env.HTTP_TEST_EXIT_BEFORE_READY==='1'){process.disconnect?.();return;}
if(process.env.HTTP_TEST_WARM==='1') await import('../../../lib/net/origin-permits');
probe('worker.runtime', { node: process.versions.node, platform: process.platform, arch: process.arch, gcExposed: typeof (globalThis as { gc?: () => void }).gc === 'function', observerEnabled: process.env.HTTP_TEST_OBSERVE_TIMEOUT === '1' });
process.send?.({ kind: 'ready' });
process.once('message', async () => {
  phase('worker.start_received');
  let fetched = false;
  const abort=new AbortController();
  process.on('message', m=>{if((m as {kind:string}).kind==='abort')abort.abort(new Error('fixture abort'));});
  let stopProbeGc: (() => void) | undefined;
  try {
    stopProbeGc = startProbeGc();
    const url = process.env.HTTP_TEST_URL!;
    phase('worker.fetch.begin');
    if (process.env.HTTP_TEST_API === 'capped') {
      const result = await fetchCapped(url, { maxBytes: 4096, timeoutMs: Number(process.env.HTTP_TEST_TIMEOUT ?? 4000), signal: abort.signal });
      fetched = true; phase('worker.fetch.end');
      process.send?.({ kind: 'result', status: result.ok ? result.status : 'status' in result ? result.status : null, value: result.ok ? result.body.toString() : result });
    } else {
      const result = await safeFetch(url);
      fetched = true; phase('worker.fetch.end');
      process.send?.({ kind: 'headers', status: result?.response.status });
      if(process.env.HTTP_TEST_HOLD==='1') await new Promise<void>(resolve=>process.once('message',()=>resolve()));
      const value=result ? process.env.HTTP_TEST_CANCEL==='1' ? await result.response.body?.cancel().then(()=> 'cancelled') : (await readBodyCapped(result.response,4096)).toString() : null;
      process.send?.({ kind: 'result', status: result?.response.status, value });
    }
  } catch (error) {
    phase(fetched ? 'worker.body.reject' : 'worker.fetch.reject');
    process.send?.({ kind: 'error', name: error instanceof Error ? error.name : '', message: String(error) });
  } finally {
    stopProbeGc?.();
    phase('worker.pg_end.begin');
    try { await (globalThis as unknown as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end(); phase('worker.pg_end.end'); }
    catch (error) { phase('worker.pg_end.reject'); throw error; }
    phase('worker.disconnect.begin'); process.disconnect?.();
  }
});

})();
