import { afterAll, afterEach, beforeAll, expect, it as vitestIt, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse, type RequestListener } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import postgres from 'postgres';
import { writeFile } from 'node:fs/promises';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const client = postgres(TEST_DATABASE_URL, { max: 1 });
const policy = { version: 1, instanceHosts: { 'http-c-one': 'oracle-osaka-smoke', 'http-c-two': 'oracle-osaka-smoke', 'http-c-three': 'm3', 'http-c-four': 'oracle-osaka-smoke' } };
const children = new Set<ChildProcess>();
const work = new Set<Promise<unknown>>();
const exercises = new Set<Promise<unknown>>();
const exercise = <T>(p:Promise<T>):Promise<T>=>{exercises.add(p);void p.catch(()=>{});return p;};
const track = <T>(p: Promise<T>): Promise<T> => { work.add(p); void p.catch(() => {}); return p; };
const it = Object.assign((name: string, body: () => Promise<void>) => vitestIt(name, () => exercise(Promise.resolve().then(body))), {
  each: <T>(cases: readonly T[]) => (name: string, body: (value: T) => Promise<void>) => vitestIt.each(cases)(name, value => exercise(Promise.resolve().then(() => body(value)))),
});
let original: unknown;
let foreign: unknown;
let baseline: unknown;
async function foreignHttp(tx: typeof client | postgres.TransactionSql) {
  const [row] = await tx`SELECT jsonb_build_object('control',(SELECT to_jsonb(c) FROM http_origin_control c WHERE id=1),
    'hops',coalesce((SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM http_origin_hops h),'[]'::jsonb),
    'events',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM http_origin_events e),'[]'::jsonb)) AS snapshot`;
  return row.snapshot;
}
async function whole() {
  const result: Record<string, unknown> = {};
  for(const row of await client`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    result[row.tablename]=(await client.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),'[]'::jsonb) AS rows FROM public."${row.tablename.replaceAll('"','""')}" t`))[0].rows;
  }
  return result;
}
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  if(cleaning)return cleaning;
  const pending=cleanOnce();cleaning=pending;
  void pending.finally(()=>{if(cleaning===pending)cleaning=undefined;}).catch(()=>{});
  return pending;
}
const ownIds = new Set<string>();
async function cleanOnce() {
  const pending = [...exercises,...work]; await Promise.allSettled(pending); pending.forEach(p => {work.delete(p);exercises.delete(p);});
  await client.begin(async tx => {
    await tx`SELECT id FROM http_origin_control WHERE id=1 FOR UPDATE`;
    for (const row of await tx`SELECT id FROM http_origin_hops WHERE instance_id IN ('http-c-one','http-c-two','http-c-three','http-c-four','http-c-unknown')`) ownIds.add(row.id);
    await tx`ALTER TABLE http_origin_events DISABLE TRIGGER http_origin_events_no_change`;
    for (const id of ownIds) { await tx`DELETE FROM http_origin_events WHERE hop_id=${id}::uuid`; await tx`DELETE FROM http_origin_hops WHERE id=${id}::uuid`; }
    await tx`ALTER TABLE http_origin_events ENABLE ALWAYS TRIGGER http_origin_events_no_change`;
    await tx`UPDATE http_origin_control c SET (mode,epoch,revision,policy,policy_hash,updated_at)=(x.mode,x.epoch,x.revision,x.policy,x.policy_hash,x.updated_at) FROM jsonb_populate_record(NULL::http_origin_control,${JSON.stringify(original)}::text::jsonb) x WHERE c.id=1`;
    expect(await foreignHttp(tx)).toEqual(foreign);
  });
  ownIds.clear();
}
beforeAll(() => exercise((async()=>{
  ensureSchema();
  [original] = await client`SELECT to_jsonb(c) AS row FROM http_origin_control c`;
  original=(original as {row:unknown}).row;
  expect(await client`SELECT id FROM http_origin_hops WHERE instance_id IN ('http-c-one','http-c-two','http-c-three','http-c-four','http-c-unknown')`).toHaveLength(0);
  foreign=await foreignHttp(client);baseline=await whole();
  await writeFile('/tmp/nomorevibe-pr07b-c-foreign-before-20261016.json',JSON.stringify({foreign,whole:baseline},null,2));
})()));
afterEach(cleanup);
afterAll(async()=>{
  const errors:unknown[]=[];
  for(const step of [()=>cleanup(),async()=>{const after=await whole();await writeFile('/tmp/nomorevibe-pr07b-c-foreign-after-20261016.json',JSON.stringify({foreign:await foreignHttp(client),whole:after},null,2));expect(after).toEqual(baseline);},()=>client.end()])try{await step();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors);
});

async function child(url: string, enabled: boolean, instance: string, api: 'safe'|'capped', extra: Record<string,string>={}) {
  const p = fork('tests/integration/fixtures/http-origin-worker.ts', [], { execArgv: ['--import','tsx'], stdio: ['ignore','pipe','pipe','ipc'],
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, ALLOW_PRIVATE_URLS: '1', HTTP_ORIGIN_PERMITS: enabled ? '1':'0', SERVICE_INSTANCE_ID: instance, HTTP_TEST_URL: url, HTTP_TEST_API: api, ...extra } });
  children.add(p);
  track(once(p,'exit'));
  let stderr = ''; p.stderr?.on('data', value => { stderr += value; });
  const messages: unknown[] = [];
  p.on('message', m => { messages.push(m); });
  await new Promise<void>((resolve,reject) => { p.once('message', () => resolve()); p.once('error',reject); p.once('exit', code => { if(code) reject(new Error(stderr)); }); });
  const result = track(new Promise<Record<string, unknown>>((resolve,reject) => { p.on('message', m => { const v=m as Record<string,unknown>; if(v.kind==='result'||v.kind==='error') resolve(v); }); p.once('error',reject); p.once('exit', () => { children.delete(p); if(!messages.some(m => ['result','error'].includes((m as {kind:string}).kind))) reject(new Error(stderr)); }); }));
  return { start: () => p.send({kind:'start'}), send:(kind:string)=>p.connected && p.send({kind}), result, headers:()=>new Promise<Record<string,unknown>>(resolve=>{const found=messages.find(m=>(m as {kind:string}).kind==='headers');if(found)resolve(found as Record<string,unknown>);else p.on('message',m=>{if((m as {kind:string}).kind==='headers')resolve(m as Record<string,unknown>);});}) };
}
async function pair(enabled: boolean) {
  await client`UPDATE http_origin_control SET mode='open',policy=${client.json(policy)},policy_hash=${createHash('sha256').update(JSON.stringify({version:1,instanceHosts:Object.fromEntries(Object.entries(policy.instanceHosts).sort(([a],[b])=>a<b?-1:a>b?1:0))})).digest('hex')} WHERE id=1`;
  let active=0, peak=0;
  const open = new Set<ServerResponse>();
  const server=createServer((_req,res) => { active++; peak=Math.max(peak,active); open.add(res); res.writeHead(200);res.write('hi');res.once('close',()=>{active--;open.delete(res);}); setTimeout(()=>res.end('!'),200); });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  let errors: unknown[]=[];
  let answer=0;
  try {
    const a=await child(url,enabled,'http-c-one','safe'), b=await child(url,enabled,'http-c-two','capped');
    a.start();b.start(); const results=await Promise.all([a.result,b.result]);
    expect(results.map(r=>r.kind)).toEqual(['result','result']);expect(results.map(r=>r.value)).toEqual(['hi!','hi!']);
    answer=peak;
  } catch(error) { errors.push(error); }
  finally { for(const res of open)res.end(); await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); const p=[...work]; const settled=await Promise.allSettled(p);errors=errors.concat(settled.filter(s=>s.status==='rejected').map(s=>(s as PromiseRejectedResult).reason)); }
  if(errors.length)throw new AggregateError(errors);
  return answer;
}
it('disabled real default safe/capped transports remain concurrent without permit rows', async()=>{expect(await pair(false)).toBe(2);expect(await client`SELECT id FROM http_origin_hops WHERE instance_id IN ('http-c-one','http-c-two')`).toHaveLength(0);});
it('two real executors share global origin1 through both production default APIs', async()=>{expect(await pair(true)).toBe(1);const rows=await client`SELECT state FROM http_origin_hops WHERE instance_id IN ('http-c-one','http-c-two')`;expect(rows).toHaveLength(2);expect(rows.every(r=>r.state==='released')).toBe(true);});

async function opened(handler: RequestListener) {
  const server=createServer(handler); server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
  return {server,url,close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
async function openPolicy() {
  const sorted={version:1,instanceHosts:Object.fromEntries(Object.entries(policy.instanceHosts).sort(([a],[b])=>a<b?-1:a>b?1:0))};
  await client`UPDATE http_origin_control SET mode='open',policy=${client.json(policy)},policy_hash=${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')} WHERE id=1`;
}
it('native header connection error ends its dispatch before another same-origin request enters',async()=>{
  await openPolicy();let calls=0;const endpoint=await opened((_req,res)=>{if(++calls===1)res.destroy();else res.end('recovered');});
  const errors:unknown[]=[];
  try {
    const first=await child(endpoint.url,true,'http-c-one','safe');first.start();expect((await first.result).value).toBeNull();
    expect((await client`SELECT state FROM http_origin_hops WHERE instance_id='http-c-one'`)[0].state).toBe('released');
    const next=await child(endpoint.url,true,'http-c-two','capped');next.start();expect((await next.result).value).toBe('recovered');expect(calls).toBe(2);
  }catch(e){errors.push(e);}finally{try{await endpoint.close();}catch(e){errors.push(e);}}
  if(errors.length)throw new AggregateError(errors);
});
it.each(['safe','capped'] as const)('enabled %s preserves an actual nonstandard HTTP999 and settles its body',async api=>{
  await openPolicy();const endpoint=await opened((_req,res)=>{res.writeHead(999);res.end('nonstandard');});const errors:unknown[]=[];
  try {const run=await child(endpoint.url,true,'http-c-one',api);run.start();expect(await run.result).toMatchObject({kind:'result',status:999});expect((await client`SELECT state FROM http_origin_hops WHERE instance_id='http-c-one'`)[0].state).toBe('released');}
  catch(e){errors.push(e);}finally{try{await endpoint.close();}catch(e){errors.push(e);}}
  if(errors.length)throw new AggregateError(errors);
});

async function until(load:()=>Promise<boolean>, label:string) {
  const deadline=Date.now()+6000;
  while(!await load()){if(Date.now()>deadline)throw new Error(label);await new Promise(r=>setTimeout(r,10));}
}
async function concurrentOrigins(instances: string[], singleOrigin=false) {
  await openPolicy();let active=0,peak=0;
  const open=new Set<ServerResponse>();
  const endpoints=[];
  for(let i=0;i<(singleOrigin?1:instances.length);i++)endpoints.push(await opened((_q,res)=>{
    active++;peak=Math.max(peak,active);open.add(res);res.write('held');res.once('close',()=>{active--;open.delete(res);});setTimeout(()=>res.end('!'),250);
  }));
  const errors:unknown[]=[];
  try {
    const workers=[];for(let i=0;i<instances.length;i++)workers.push(await child(endpoints[singleOrigin?0:i].url,true,instances[i],i%2?'capped':'safe'));
    workers.forEach(w=>w.start());const results=await Promise.all(workers.map(w=>w.result));expect(results.every(r=>r.kind==='result'&&r.value==='held!')).toBe(true);
    return peak;
  }catch(e){errors.push(e);}finally{for(const res of open)res.end();for(const e of endpoints)try{await e.close();}catch(error){errors.push(error);}}
  throw new AggregateError(errors);
}
it('global origin1 spans two configured physical hosts, not just two processes on one host',async()=>{expect(await concurrentOrigins(['http-c-one','http-c-three'],true)).toBe(1);});
it('Oracle physical host total2 spans three different origins and three isolated executors',async()=>{expect(await concurrentOrigins(['http-c-one','http-c-two','http-c-four'])).toBe(2);});
it('explicit M3 plus two Oracle requests may use three different origins concurrently',async()=>{expect(await concurrentOrigins(['http-c-one','http-c-two','http-c-three'])).toBe(3);});
it.each(['safe','capped'] as const)('unknown instance fails closed before %s native HTTP dispatch',async api=>{
  await openPolicy();let calls=0;const e=await opened((_q,res)=>{calls++;res.end('bad');});const errors:unknown[]=[];
  try{const w=await child(e.url,true,'http-c-unknown',api);w.start();expect(await w.result).toMatchObject({kind:'error',name:'HttpOriginPermitError',message:'HttpOriginPermitError: http_origin_permit_configuration'});expect(calls).toBe(0);expect(await client`SELECT * FROM http_origin_hops`).toHaveLength(0);}
  catch(error){errors.push(error);}finally{try{await e.close();}catch(error){errors.push(error);}}
  if(errors.length)throw new AggregateError(errors);
});
it.each(['safe','capped'] as const)('redirect hops of enabled %s use separate native permits and preserve headers/status',async api=>{
  await openPolicy();const seen:string[]=[];const e=await opened((req,res)=>{seen.push(req.url!);if(req.url==='/'){res.writeHead(302,{location:'/next'});res.end('discard');}else{res.setHeader('x-control','kept');res.end('redirected');}});const errors:unknown[]=[];
  try{const w=await child(e.url,true,'http-c-one',api);w.start();expect(await w.result).toMatchObject({kind:'result',status:200,value:'redirected'});expect(seen).toEqual(['/','/next']);expect(await client`SELECT state FROM http_origin_hops WHERE instance_id='http-c-one' AND state='released'`).toHaveLength(2);}
  catch(error){errors.push(error);}finally{try{await e.close();}catch(error){errors.push(error);}}
  if(errors.length)throw new AggregateError(errors);
});
it('a native-ended but unread response retains its charge past the reservation deadline and across drain/epoch changes',async()=>{
  await openPolicy();const e=await opened((_q,res)=>res.end('retained'));const errors:unknown[]=[];let held:Awaited<ReturnType<typeof child>>|undefined;
  try{
    held=await child(e.url,true,'http-c-one','safe',{HTTP_TEST_HOLD:'1'});held.start();await held.headers();
    const [first]=await client`SELECT to_jsonb(h) AS row FROM http_origin_hops h WHERE instance_id='http-c-one'`;expect(first.row.state).toBe('dispatched');
    await until(async()=>{const [v]=await client`SELECT clock_timestamp()>reserved_until AS past FROM http_origin_hops WHERE id=${first.row.id}::uuid`;return v.past;},'original reservation deadline');
    const rival=await child(e.url,true,'http-c-two','capped',{HTTP_TEST_TIMEOUT:'100'});rival.start();expect(await rival.result).toMatchObject({kind:'error',name:'HttpOriginPermitError'});
    const [before]=await client`SELECT to_jsonb(h) AS row FROM http_origin_hops h WHERE id=${first.row.id}::uuid`;expect(before.row).toEqual(first.row);
    await client`UPDATE http_origin_control SET mode='draining',epoch=epoch+1 WHERE id=1`;
    held.send('consume');expect(await held.result).toMatchObject({kind:'result',value:'retained'});
    expect((await client`SELECT state,token,boot_id FROM http_origin_hops WHERE id=${first.row.id}::uuid`)[0]).toMatchObject({state:'released',token:first.row.token,boot_id:first.row.boot_id});
  }catch(error){errors.push(error);}finally{held?.send('consume');try{await e.close();}catch(error){errors.push(error);}}
  if(errors.length)throw new AggregateError(errors);
});
it('reader cancellation waits for native socket termination, releases once, and allows a same-origin follower',async()=>{
  await openPolicy();let calls=0;const open=new Set<ServerResponse>();const e=await opened((_q,res)=>{calls++;res.write('held');open.add(res);res.once('close',()=>open.delete(res));if(calls>1)res.end('!');});const errors:unknown[]=[];let held:Awaited<ReturnType<typeof child>>|undefined;
  try{held=await child(e.url,true,'http-c-one','safe',{HTTP_TEST_HOLD:'1',HTTP_TEST_CANCEL:'1'});held.start();await held.headers();expect((await client`SELECT state FROM http_origin_hops WHERE instance_id='http-c-one'`)[0].state).toBe('dispatched');held.send('cancel');expect(await held.result).toMatchObject({kind:'result',value:'cancelled'});
    await until(async()=>Boolean((await client`SELECT state='released' AS ok FROM http_origin_hops WHERE instance_id='http-c-one'`)[0]?.ok),'native cancellation settlement');
    const next=await child(e.url,true,'http-c-two','capped');next.start();expect(await next.result).toMatchObject({kind:'result',value:'held!'});expect(await client`SELECT * FROM http_origin_events WHERE kind='released'`).toHaveLength(2);
  }catch(error){errors.push(error);}finally{held?.send('cancel');for(const res of open)res.end();try{await e.close();}catch(error){errors.push(error);}}
  if(errors.length)throw new AggregateError(errors);
});
it('append-only statement guards reject zero-row UPDATE/DELETE and TRUNCATE',async()=>{
  for(const q of ['UPDATE http_origin_events SET kind=kind WHERE false','DELETE FROM http_origin_events WHERE false','TRUNCATE http_origin_events']) await expect(client.unsafe(q)).rejects.toMatchObject({code:'55000',message:'http_origin_events_append_only'});
  expect((await client`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='http_origin_events'::regclass AND tgenabled='A' AND NOT tgisinternal`)[0].n).toBe(2);
});

it('caller deadline ends a reserve waiting behind the control mutex without abandoning a live transaction',async()=>{
  await openPolicy();let calls=0;const e=await opened((_q,res)=>{calls++;res.end('unexpected');});
  const blocker=postgres(TEST_DATABASE_URL,{max:1});let unlock!:()=>void;const gate=new Promise<void>(r=>{unlock=r;});let locked!:()=>void;const ready=new Promise<void>(r=>{locked=r;});
  const holding=track(blocker.begin(async tx=>{await tx`SELECT id FROM http_origin_control WHERE id=1 FOR UPDATE`;locked();await gate;}));
  const errors:unknown[]=[];let w:Awaited<ReturnType<typeof child>>|undefined;
  try{await Promise.race([ready,holding]);w=await child(e.url,true,'http-c-one','capped',{HTTP_TEST_TIMEOUT:'100',HTTP_TEST_WARM:'1'});w.start();
    const observed=await Promise.race([w.result.then(result=>({completed:true,result})),new Promise<{completed:false}>(r=>setTimeout(()=>r({completed:false}),350))]);
    expect(observed.completed).toBe(true);
    if(observed.completed)expect(observed.result).toMatchObject({kind:'error',message:'HttpOriginPermitError: http_origin_permit_waiting_aborted'});
    expect(calls).toBe(0);
  }catch(error){errors.push(error);}finally{unlock();for(const step of [()=>holding,()=>w?.result,()=>blocker.end(),()=>e.close()])try{await step();}catch(error){errors.push(error);}}
  if(errors.length)throw new AggregateError(errors);
});

it('same-process background safeFetch and fetchCapped classify a shared wait as deferred instead of a site failure',async()=>{
  await openPolicy();await import('@/lib/net/origin-permits');
  const {safeFetch,fetchCapped}=await import('@/lib/net/fetch');
  const previous={flag:process.env.HTTP_ORIGIN_PERMITS,instance:process.env.SERVICE_INSTANCE_ID};
  process.env.HTTP_ORIGIN_PERMITS='1';process.env.SERVICE_INSTANCE_ID='http-c-one';
  const globals=globalThis as unknown as {pgClient?:ReturnType<typeof postgres>;db?:unknown};
  const previousClient=globals.pgClient,previousDb=globals.db;
  const firstSignal=new AbortController(),realTimeout=AbortSignal.timeout.bind(AbortSignal);
  let timeouts=0;const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(()=>++timeouts===1?firstSignal.signal:realTimeout(100));
  let calls=0;const open=new Set<ServerResponse>();const e=await opened((_q,res)=>{calls++;res.write('held');open.add(res);res.once('close',()=>open.delete(res));});
  const errors:unknown[]=[];let first:Awaited<ReturnType<typeof safeFetch>>=null;
  try{
    first=await track(safeFetch(e.url,'background'));
    expect(first?.response.status).toBe(200);
    const waiting=await Promise.allSettled([track(safeFetch(e.url,'background',{retryTransientErrors:true})),track(fetchCapped(e.url,{maxBytes:20,timeoutMs:100}))]);
    expect(waiting).toHaveLength(2);
    for(const result of waiting){expect(result.status).toBe('rejected');if(result.status==='rejected')expect(result.reason).toMatchObject({name:'HttpOriginPermitError',code:'waiting_aborted'});}
    expect(calls).toBe(1);
  }catch(error){errors.push(error);}finally{
    timeout.mockRestore();
    for(const step of [()=>first?.response.body?.cancel(),async()=>{for(const res of open)res.end();await e.close();},async()=>{if(globals.pgClient!==previousClient){await globals.pgClient?.end();globals.pgClient=previousClient;globals.db=previousDb;}}])try{await step();}catch(error){errors.push(error);}
    if(previous.flag===undefined)delete process.env.HTTP_ORIGIN_PERMITS;else process.env.HTTP_ORIGIN_PERMITS=previous.flag;
    if(previous.instance===undefined)delete process.env.SERVICE_INSTANCE_ID;else process.env.SERVICE_INSTANCE_ID=previous.instance;
  }
  if(errors.length)throw new AggregateError(errors);
});

it('a rejected real reader cancellation remains indeterminate even after native response-end',async()=>{
  await openPolicy();const {channel}=await import('node:diagnostics_channel');
  const {safeFetch}=await import('@/lib/net/fetch');
  const old={flag:process.env.HTTP_ORIGIN_PERMITS,instance:process.env.SERVICE_INSTANCE_ID};process.env.HTTP_ORIGIN_PERMITS='1';process.env.SERVICE_INSTANCE_ID='http-c-one';
  const globals=globalThis as unknown as {pgClient?:ReturnType<typeof postgres>;db?:unknown};const previousClient=globals.pgClient,previousDb=globals.db;
  const e=await opened((_q,res)=>res.end('native-ended'));
  const native=channel('undici:request:trailers');let ended!:()=>void;const nativeEnded=new Promise<void>(r=>{ended=r;});
  const witness=(message:unknown)=>{if(String((message as {request:{origin:unknown}}).request.origin)===new URL(e.url).origin)ended();};native.subscribe(witness);
  const failure=new Error('actual-reader-cancel-failure');const errors:unknown[]=[];let cancel:ReturnType<typeof vi.spyOn>|undefined;
  try{
    const response=await track(safeFetch(e.url));expect(response?.response.status).toBe(200);await nativeEnded;await new Promise<void>(r=>setImmediate(r));
    expect((await client`SELECT state FROM http_origin_hops WHERE instance_id='http-c-one'`)[0].state).toBe('dispatched');
    // Fault at the actual owned native reader method, not at admission/DB/HTTP.
    cancel=vi.spyOn(ReadableStreamDefaultReader.prototype,'cancel').mockRejectedValueOnce(failure);
    await expect(track(response!.response.body!.cancel())).rejects.toBe(failure);
    expect((await client`SELECT state FROM http_origin_hops WHERE instance_id='http-c-one'`)[0].state).toBe('indeterminate');
    expect(await client`SELECT * FROM http_origin_events WHERE kind='released'`).toHaveLength(0);
    const {db}=await import('@/lib/db');const {sql}=await import('drizzle-orm');
    const settings=await db.execute(sql`SELECT current_setting('lock_timeout') AS lock_timeout,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout')::interval>interval '0' AS bounded`);
    expect(settings[0].bounded).toBe(true);await writeFile('/tmp/nomorevibe-pr07b-c-actual-runtime-pool-settings-20261016.json',JSON.stringify(settings,null,2));
  }catch(error){errors.push(error);}finally{
    cancel?.mockRestore();native.unsubscribe(witness);
    for(const step of [()=>e.close(),async()=>{if(globals.pgClient!==previousClient){await globals.pgClient?.end();globals.pgClient=previousClient;globals.db=previousDb;}}])try{await step();}catch(error){errors.push(error);}
    if(old.flag===undefined)delete process.env.HTTP_ORIGIN_PERMITS;else process.env.HTTP_ORIGIN_PERMITS=old.flag;
    if(old.instance===undefined)delete process.env.SERVICE_INSTANCE_ID;else process.env.SERVICE_INSTANCE_ID=old.instance;
  }
  if(errors.length)throw new AggregateError(errors);
});
