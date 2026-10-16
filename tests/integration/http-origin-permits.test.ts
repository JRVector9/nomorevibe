import { afterAll, afterEach, beforeAll, expect, it as vitestIt, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse, type RequestListener } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import postgres from 'postgres';
import { writeFile } from 'node:fs/promises';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const client = postgres(TEST_DATABASE_URL, { max: 1 });
const evidencePrefix = `/tmp/nomorevibe-http-rival-c-${process.pid}-20261016`;
const policy = { version: 1, instanceHosts: { 'http-c-one': 'oracle-osaka-smoke', 'http-c-two': 'oracle-osaka-smoke', 'http-c-three': 'm3', 'http-c-four': 'oracle-osaka-smoke' } };
const fixtureTracePhases = new Set([
  'worker.start_received', 'worker.fetch.begin', 'worker.fetch.end', 'worker.fetch.reject', 'worker.body.reject',
  'worker.pg_end.begin', 'worker.pg_end.end', 'worker.pg_end.reject', 'worker.disconnect.begin', 'worker.timeout_100.abort',
  'child.disconnected', 'child.close', 'child.pg_wait_sample', 'child.pg_wait_sample_unknown', 'cleanup.failed_drain.begin', 'cleanup.failed_drain.end',
  'cleanup.child_term', 'cleanup.child_kill', 'cleanup.settlement_deadline',
  'child.spawned', 'child.ready', 'child.headers', 'child.result', 'child.error',
  'child.process_error', 'child.exit', 'child.send_start', 'child.send_consume', 'child.send_cancel', 'child.send_abort',
  'cleanup.exercises_work_settle.begin', 'cleanup.exercises_work_settle.end', 'unread.rejected',
  'unread.policy_open.begin', 'unread.policy_open.end', 'unread.endpoint_open.begin', 'unread.endpoint_open.end',
  'unread.held_ready.begin', 'unread.held_ready.end', 'unread.held_headers.begin', 'unread.held_headers.end',
  'unread.original_hop.begin', 'unread.original_hop.end', 'unread.reservation_past.begin', 'unread.reservation_past.end',
  'unread.rival_ready.begin', 'unread.rival_ready.end', 'unread.rival_result_checked.begin', 'unread.rival_result_checked.end',
  'unread.unchanged_hop_checked.begin', 'unread.unchanged_hop_checked.end', 'unread.drain_update.begin', 'unread.drain_update.end',
  'unread.held_result_checked.begin', 'unread.held_result_checked.end', 'unread.release_row_checked.begin', 'unread.release_row_checked.end',
  'unread.endpoint_close.begin', 'unread.endpoint_close.end',
  'request.enter', 'request.import_done', 'reserve.enter', 'reserve.first_tx_done', 'reserve.tx_reject',
  'reserve.delay_enter', 'reserve.first_delay_done', 'reserve.delay_reject', 'reserve.aborted', 'reserve.done', 'native.enter',
  'worker.runtime', 'worker.gc.begin', 'worker.gc.end',
] as const);
type FixtureTracePhase = typeof fixtureTracePhases extends Set<infer Phase> ? Phase : never;
type PermitProbeFields = { aborted?: boolean; loopCount?: number; outcome?: 'no_grant' | 'control_busy' | 'grant'; gcCount?: number; node?: string; platform?: 'darwin' | 'linux'; arch?: 'arm64' | 'x64'; gcExposed?: boolean; observerEnabled?: boolean };
const permitProbePhases = new Set(['request.enter', 'request.import_done', 'reserve.enter', 'reserve.first_tx_done', 'reserve.tx_reject', 'reserve.delay_enter', 'reserve.first_delay_done', 'reserve.delay_reject', 'reserve.aborted', 'reserve.done', 'native.enter', 'worker.runtime', 'worker.gc.begin', 'worker.gc.end']);
function permitProbeFields(value: Record<string, unknown>): PermitProbeFields {
  const fields: PermitProbeFields = {};
  for (const key of ['aborted', 'gcExposed', 'observerEnabled'] as const) if (typeof value[key] === 'boolean') fields[key] = value[key];
  for (const key of ['loopCount', 'gcCount'] as const) if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 1_000_000) fields[key] = Number(value[key]);
  if (value.outcome === 'no_grant' || value.outcome === 'control_busy' || value.outcome === 'grant') fields.outcome = value.outcome;
  if (typeof value.node === 'string' && /^24\.[0-9]{1,3}\.[0-9]{1,3}$/.test(value.node)) fields.node = value.node;
  if (value.platform === 'darwin' || value.platform === 'linux') fields.platform = value.platform;
  if (value.arch === 'arm64' || value.arch === 'x64') fields.arch = value.arch;
  return fields;
}

let fixtureTraceWrites = 0, fixtureTraceAwaitingError = false, fixtureTraceErrorGeneration = 0, fixtureTraceListening = false;
function fixtureTraceDetach(): void {
  try {
    if (fixtureTraceListening && fixtureTraceWrites === 0 && !fixtureTraceAwaitingError) {
      process.stderr.removeListener('error', fixtureTraceSinkError);
      fixtureTraceListening = false;
    }
  } catch { /* Diagnostic failures must not affect the exercise. */ }
}
function fixtureTraceSinkError(): void {
  try { fixtureTraceErrorGeneration++; fixtureTraceAwaitingError = false; fixtureTraceDetach(); }
  catch { /* Never replace the original fixture error. */ }
}
function fixtureTrace(phase: FixtureTracePhase | null, pid: number | null = process.pid, sample?: { closed: boolean; backends: { pgPid: number; state: string | null; waitType: string | null; waitEvent: string | null; blockers: number[] }[] }, probe?: PermitProbeFields): void {
  try {
    if (!(process.env.CI === 'true' || process.env.HTTP_FIXTURE_TRACE === '1') || phase === null || !fixtureTracePhases.has(phase)) return;
    const line = JSON.stringify({ phase, pid: typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null, monotonicMs: performance.now(), ...(phase === 'child.pg_wait_sample' ? sample : undefined), ...(permitProbePhases.has(phase) ? probe : undefined) }) + '\n';
    if (!fixtureTraceListening) {
      const max = process.stderr.getMaxListeners();
      if (max > 0 && process.stderr.listenerCount('error') >= max) return;
      process.stderr.on('error', fixtureTraceSinkError); fixtureTraceListening = true;
    }
    fixtureTraceWrites++;
    const generation = fixtureTraceErrorGeneration;
    let completed = false;
    const complete = (error?: Error | null): void => {
      try {
        if (completed) return;
        completed = true; fixtureTraceWrites--;
        // Writable reports callback errors before its error event. Retain the
        // single guard until that event; also tolerate an already-seen event.
        if (error && generation === fixtureTraceErrorGeneration) fixtureTraceAwaitingError = true;
        fixtureTraceDetach();
      } catch { /* The write callback must also be noexcept. */ }
    };
    try { process.stderr.write(line, complete); } catch { complete(); }
  } catch { /* Trace output is best effort, including a failed stderr sink. */ }
}

const children = new Set<ChildProcess>();
const childState = new Map<ChildProcess, { closed: Promise<void>; closedFlag: boolean; started: boolean; applicationName: string }>();
let failingDrain = false;
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
function cleanup(failed = false): Promise<void> {
  if(cleaning)return cleaning;
  const pending=cleanOnce(failed);cleaning=pending;
  void pending.finally(()=>{if(cleaning===pending)cleaning=undefined;}).catch(()=>{});
  return pending;
}
const ownIds = new Set<string>();
// A failed body remains failed. These timers only make its own child drain observable;
// neither a kill nor a child close proves that an HTTP permit can be released.
async function drainChildren(): Promise<unknown[]> {
  const errors: unknown[] = [];
  fixtureTrace('cleanup.failed_drain.begin');
  await Promise.all([...children].map(async p => {
    const state = childState.get(p);
    if (!state) { errors.push(new Error('http_fixture_child_close_untracked')); return; }
    const signal = (name: 'SIGTERM' | 'SIGKILL') => {
      if (state.closedFlag) return;
      fixtureTrace(name === 'SIGTERM' ? 'cleanup.child_term' : 'cleanup.child_kill', p.pid ?? null);
      errors.push(new Error(`http_fixture_forced_termination_${name}`));
      try { if (!p.kill(name)) errors.push(new Error('http_fixture_child_signal_not_sent')); }
      catch (error) { errors.push(error); }
    };
    // Install both independently before any await, even if TERM is ignored.
    const term = setTimeout(() => signal('SIGTERM'), 1000);
    const kill = setTimeout(() => signal('SIGKILL'), 2000);
    const sends: Promise<void>[] = [];
    try {
      if (state.started && p.connected) for (const kind of ['abort', 'consume']) {
        const sent = new Promise<void>(resolve => {
          try { p.send({ kind }, error => { if (error) errors.push(error); resolve(); }); }
          catch (error) { errors.push(error); resolve(); }
        });
        sends.push(sent);
      }
      await state.closed;
      await Promise.allSettled(sends);
    } finally { clearTimeout(term); clearTimeout(kill); }
  }));
  fixtureTrace('cleanup.failed_drain.end');
  return errors;
}
async function settleFixtureWork(failed: boolean): Promise<unknown[]> {
  const errors: unknown[] = [];
  const pending = [...exercises, ...work];
  const settled = Promise.allSettled(pending);
  fixtureTrace('cleanup.exercises_work_settle.begin');
  if (failed) {
    failingDrain = true;
    errors.push(...await drainChildren());
  } else {
    // A terminal IPC result is not a closed process. A stalled close is a
    // separate fixture failure, never a successful business result.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const completed = await Promise.race([settled.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 4000); })]);
      if (!completed) {
        fixtureTrace('cleanup.settlement_deadline');
        errors.push(new Error('http_fixture_settlement_deadline'));
        failingDrain = true;
        errors.push(...await drainChildren());
      }
    } finally { if (timer) clearTimeout(timer); }
  }
  await settled;
  fixtureTrace('cleanup.exercises_work_settle.end');
  pending.forEach(p => { work.delete(p); exercises.delete(p); });
  return errors;
}
async function cleanOnce(failed = false) {
  const errors = await settleFixtureWork(failed);
  // No mutation is permitted before every observed child actually closes.
  if (children.size) throw new AggregateError([...errors, new Error('http_fixture_child_not_closed')]);
  try {
  const labels = [...childState.values()].map(state => state.applicationName);
  if (labels.length) expect(await client`SELECT pid FROM pg_stat_activity WHERE application_name=ANY(${labels}::text[]) AND pid<>pg_backend_pid()`).toHaveLength(0);
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
  childState.clear(); failingDrain = false;
  } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors);
}
beforeAll(() => exercise((async()=>{
  ensureSchema();
  [original] = await client`SELECT to_jsonb(c) AS row FROM http_origin_control c`;
  original=(original as {row:unknown}).row;
  expect(await client`SELECT id FROM http_origin_hops WHERE instance_id IN ('http-c-one','http-c-two','http-c-three','http-c-four','http-c-unknown')`).toHaveLength(0);
  foreign=await foreignHttp(client);baseline=await whole();
  await writeFile(`${evidencePrefix}-before.json`,JSON.stringify({foreign,whole:baseline},null,2));
})()));
// Installed Vitest classifies the body (including its timeout) before afterEach.
afterEach(ctx => cleanup(ctx.task.result?.state === 'fail'));
afterAll(async()=>{
  const errors:unknown[]=[];
  for(const step of [()=>cleanup(),async()=>{const after=await whole();await writeFile(`${evidencePrefix}-after.json`,JSON.stringify({foreign:await foreignHttp(client),whole:after},null,2));expect(after).toEqual(baseline);},()=>client.end()])try{await step();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors);
});

async function child(url: string, enabled: boolean, instance: string, api: 'safe'|'capped', extra: Record<string,string>={}) {
  if (failingDrain) throw new Error('http_fixture_child_after_failed_drain');
  const p = fork('tests/integration/fixtures/http-origin-worker.ts', [], { execArgv: ['--import','tsx', ...(process.env.HTTP_TEST_GC === '1' ? ['--expose-gc'] : [])], stdio: ['ignore','pipe','pipe','ipc'],
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, ALLOW_PRIVATE_URLS: '1', HTTP_ORIGIN_PERMITS: enabled ? '1':'0', SERVICE_INSTANCE_ID: instance, HTTP_TEST_URL: url, HTTP_TEST_API: api, HTTP_TEST_PARENT_PID: String(process.pid), ...extra } });
  children.add(p);
  const exited = track(once(p,'exit'));
  const applicationName = `nvm-http-fixture-${process.pid}-${p.pid}`;
  let resolveClosed!: () => void;
  const closed = track(new Promise<void>(resolve => { resolveClosed = resolve; }));
  const state = { closed, closedFlag: false, started: false, applicationName };
  childState.set(p, state);
  p.stdout?.resume();
  p.once('disconnect', () => fixtureTrace('child.disconnected', p.pid ?? null));
  p.once('close', () => { state.closedFlag = true; children.delete(p); fixtureTrace('child.close', p.pid ?? null); resolveClosed(); });
  // This separate read-only connection observes only this exact child's label.
  // It does not wrap a query, alter the original pool, or observe row/query data.
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let sampleStarted = false;
  let scheduleSample!: (delay: number) => void;
  const sampled = track(new Promise<void>(resolve => {
    scheduleSample = delay => { sampleTimer = setTimeout(() => {
      sampleStarted = true;
      const observer = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 1,
        connection: { application_name: `nvm-http-observer-${process.pid}`, statement_timeout: 1000, lock_timeout: 100 } });
      void (async () => {
        try {
          const rows = await observer`SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE application_name=${applicationName} ORDER BY pid`;
          fixtureTrace('child.pg_wait_sample', p.pid ?? null, { closed: state.closedFlag,
            backends: rows.map(row => ({ pgPid: row.pid, state: row.state, waitType: row.wait_event_type, waitEvent: row.wait_event, blockers: row.blockers })) });
        } catch { fixtureTrace('child.pg_wait_sample_unknown', p.pid ?? null); }
        finally { try { await observer.end(); } catch { fixtureTrace('child.pg_wait_sample_unknown', p.pid ?? null); } resolve(); }
      })();
    }, delay); };
    void closed.then(() => { if (sampleTimer) clearTimeout(sampleTimer); if (!sampleStarted) resolve(); });
  }));
  // If sampling already started, retain its actual query/end work through close.
  void sampled;
  const trace=(phase:FixtureTracePhase|null)=>fixtureTrace(phase,p.pid??null);
  trace('child.spawned');
  let stderr = ''; p.stderr?.on('data', value => { stderr += value; });
  let readyReceived=false,terminalReceived=false;
  let resolveReady!:()=>void,rejectReady!:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  let resolveResult!:(value:Record<string,unknown>)=>void,rejectResult!:(error:Error)=>void;
  const result=track(new Promise<Record<string,unknown>>((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;}));
  let resolveHeaders!:(value:Record<string,unknown>)=>void,rejectHeaders!:(error:Error)=>void;
  const headers=new Promise<Record<string,unknown>>((resolve,reject)=>{resolveHeaders=resolve;rejectHeaders=reject;});
  // Capped/negative workers need not request headers; keep their terminal rejection observed.
  void headers.catch(()=>{});
  p.on('message',message=>{
    const value=message as Record<string,unknown>;
    if(value.kind === 'permit_probe' && typeof value.phase === 'string' && permitProbePhases.has(value.phase)) fixtureTrace(value.phase as FixtureTracePhase, p.pid ?? null, undefined, permitProbeFields(value));
    if (value.kind === 'phase' && typeof value.phase === 'string' && fixtureTracePhases.has(value.phase as FixtureTracePhase)) trace(value.phase as FixtureTracePhase);
    trace(value.kind==='ready'?'child.ready':value.kind==='headers'?'child.headers':value.kind==='result'?'child.result':value.kind==='error'?'child.error':null);
    if(value.kind==='ready'){readyReceived=true;resolveReady();}
    else if(value.kind==='headers'){if(api==='safe' && extra.HTTP_TEST_HOLD==='1')scheduleSample(0);resolveHeaders(value);}
    else if(value.kind==='result'||value.kind==='error'){
      terminalReceived=true;resolveResult(value);
      const error=value.kind==='error'
        ? Object.assign(new Error(String(value.message)),{name:String(value.name)})
        : new Error('HTTP fixture completed without response headers');
      rejectReady(error);rejectHeaders(error);
    }
  });
  p.once('error',error=>{trace('child.process_error');rejectReady(error);rejectResult(error);rejectHeaders(error);});
  p.once('exit',(code,signal)=>{
    trace('child.exit');
    const error=new Error(stderr || `HTTP fixture exited ${readyReceived?'before response headers':'before ready'} (code=${code}, signal=${signal})`);
    rejectReady(error);rejectHeaders(error);if(!terminalReceived)rejectResult(error);
  });
  await ready;
  return {start:()=>{state.started = true;if(!(api==='safe' && extra.HTTP_TEST_HOLD==='1'))scheduleSample(500);trace('child.send_start');p.send({kind:'start'});},send:(kind:string)=>{trace(kind==='consume'?'child.send_consume':kind==='cancel'?'child.send_cancel':kind==='abort'?'child.send_abort':null);return p.connected && p.send({kind});},result,exited,headers:()=>headers};
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
  fixtureTrace('unread.policy_open.begin');await openPolicy();fixtureTrace('unread.policy_open.end');fixtureTrace('unread.endpoint_open.begin');const e=await opened((_q,res)=>res.end('retained'));fixtureTrace('unread.endpoint_open.end');const errors:unknown[]=[];let held:Awaited<ReturnType<typeof child>>|undefined;
  try{
    fixtureTrace('unread.held_ready.begin');held=await child(e.url,true,'http-c-one','safe',{HTTP_TEST_HOLD:'1'});fixtureTrace('unread.held_ready.end');held.start();fixtureTrace('unread.held_headers.begin');await held.headers();fixtureTrace('unread.held_headers.end');
    fixtureTrace('unread.original_hop.begin');const [first]=await client`SELECT to_jsonb(h) AS row FROM http_origin_hops h WHERE instance_id='http-c-one'`;expect(first.row.state).toBe('dispatched');fixtureTrace('unread.original_hop.end');
    fixtureTrace('unread.reservation_past.begin');await until(async()=>{const [v]=await client`SELECT clock_timestamp()>reserved_until AS past FROM http_origin_hops WHERE id=${first.row.id}::uuid`;return v.past;},'original reservation deadline');fixtureTrace('unread.reservation_past.end');
    fixtureTrace('unread.rival_ready.begin');const rival=await child(e.url,true,'http-c-two','capped',{HTTP_TEST_TIMEOUT:'100'});fixtureTrace('unread.rival_ready.end');rival.start();fixtureTrace('unread.rival_result_checked.begin');expect(await rival.result).toMatchObject({kind:'error',name:'HttpOriginPermitError'});fixtureTrace('unread.rival_result_checked.end');
    fixtureTrace('unread.unchanged_hop_checked.begin');const [before]=await client`SELECT to_jsonb(h) AS row FROM http_origin_hops h WHERE id=${first.row.id}::uuid`;expect(before.row).toEqual(first.row);fixtureTrace('unread.unchanged_hop_checked.end');
    fixtureTrace('unread.drain_update.begin');await client`UPDATE http_origin_control SET mode='draining',epoch=epoch+1 WHERE id=1`;fixtureTrace('unread.drain_update.end');
    held.send('consume');fixtureTrace('unread.held_result_checked.begin');expect(await held.result).toMatchObject({kind:'result',value:'retained'});fixtureTrace('unread.held_result_checked.end');
    fixtureTrace('unread.release_row_checked.begin');expect((await client`SELECT state,token,boot_id FROM http_origin_hops WHERE id=${first.row.id}::uuid`)[0]).toMatchObject({state:'released',token:first.row.token,boot_id:first.row.boot_id});fixtureTrace('unread.release_row_checked.end');
  }catch(error){fixtureTrace('unread.rejected');errors.push(error);}finally{held?.send('consume');try{fixtureTrace('unread.endpoint_close.begin');await e.close();fixtureTrace('unread.endpoint_close.end');}catch(error){errors.push(error);}}
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

it('headers waiting rejects the actual worker terminal error after unknown-instance failure and exit',async()=>{
  await openPolicy();let calls=0;
  const endpoint=await opened((_req,res)=>{calls++;res.end('unexpected');});
  const errors:unknown[]=[];
  let run:Awaited<ReturnType<typeof child>>|undefined;
  let observed:Promise<void>|undefined;
  const headers:{state:string;error?:unknown}={state:'pending'};
  try{
    run=await child(endpoint.url,true,'http-c-unknown','safe',{HTTP_TEST_HOLD:'1'});
    observed=run.headers().then(()=>{headers.state='resolved';},error=>{headers.state='rejected';headers.error=error;});
    run.start();
    const result=await run.result;
    expect(result).toMatchObject({kind:'error',name:'HttpOriginPermitError',message:'HttpOriginPermitError: http_origin_permit_configuration'});
    expect(await run.exited).toEqual([0,null]);
    expect(calls).toBe(0);
    expect(await client`SELECT id FROM http_origin_hops WHERE instance_id='http-c-unknown'`).toHaveLength(0);
    console.log(JSON.stringify({proof:'actual-worker-error-and-exit',result,exitCode:0,headersState:headers.state,dispatches:calls}));
    expect(headers.state).toBe('rejected');
    expect(headers.error).toMatchObject({name:result.name,message:result.message});
  }catch(error){errors.push(error);}
  finally{
    run?.send('consume');
    for(const step of [async()=>{if(run)await Promise.allSettled([run.result,run.exited]);},async()=>{if(headers.state!=='pending')await observed;},()=>endpoint.close()])try{await step();}catch(error){errors.push(error);}
  }
  if(errors.length)throw new AggregateError(errors);
});

it('startup rejects an actual clean worker exit before ready',async()=>{
  const startup:{state:string;error?:unknown}={state:'pending'};
  const before=new Set(children);
  const observed=child('http://127.0.0.1:1/',true,'http-c-one','safe',{HTTP_TEST_EXIT_BEFORE_READY:'1'}).then(()=>{startup.state='resolved';},error=>{startup.state='rejected';startup.error=error;});
  const spawned=[...children].filter(p=>!before.has(p));
  expect(spawned).toHaveLength(1);
  try{
    expect(await once(spawned[0],'exit')).toEqual([0,null]);
    console.log(JSON.stringify({proof:'actual-worker-exit-before-ready',exitCode:0,startupState:startup.state}));
    expect(startup.state).toBe('rejected');
    expect(startup.error).toBeInstanceOf(Error);
    expect(String(startup.error)).toContain('before ready');
  }finally{if(startup.state!=='pending')await observed;}
});
