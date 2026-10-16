// Real isolated process: no request/DB/dispatcher mocks.
import { fetchCapped, safeFetch, readBodyCapped } from '../../../lib/net/fetch';
import type postgres from 'postgres';
void (async()=>{
if(process.env.HTTP_TEST_WARM==='1') await import('../../../lib/net/origin-permits');
process.send?.({ kind: 'ready' });
process.once('message', async () => {
  const abort=new AbortController();
  process.on('message', m=>{if((m as {kind:string}).kind==='abort')abort.abort(new Error('fixture abort'));});
  try {
    const url = process.env.HTTP_TEST_URL!;
    if (process.env.HTTP_TEST_API === 'capped') {
      const result = await fetchCapped(url, { maxBytes: 4096, timeoutMs: Number(process.env.HTTP_TEST_TIMEOUT ?? 4000), signal: abort.signal });
      process.send?.({ kind: 'result', status: result.ok ? result.status : 'status' in result ? result.status : null, value: result.ok ? result.body.toString() : result });
    } else {
      const result = await safeFetch(url);
      process.send?.({ kind: 'headers', status: result?.response.status });
      if(process.env.HTTP_TEST_HOLD==='1') await new Promise<void>(resolve=>process.once('message',()=>resolve()));
      const value=result ? process.env.HTTP_TEST_CANCEL==='1' ? await result.response.body?.cancel().then(()=> 'cancelled') : (await readBodyCapped(result.response,4096)).toString() : null;
      process.send?.({ kind: 'result', status: result?.response.status, value });
    }
  } catch (error) {
    process.send?.({ kind: 'error', name: error instanceof Error ? error.name : '', message: String(error) });
  } finally {
    await (globalThis as unknown as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end();
    process.disconnect?.();
  }
});

})();
