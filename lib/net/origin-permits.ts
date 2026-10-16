import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Dispatcher } from 'undici';
import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { httpOriginPolicyHash, httpOriginPolicySchema, HttpOriginPermitError } from './http-origin-policy';
import { httpDispatcher, nativeHttpFetch } from './http-transport';
import type { CappedRequest } from './fetch';
import { writerSiteActive } from '@/lib/operations/dr/epoch';

const bootId = randomUUID();
const RESERVATION_MS = 5000;
class ControlBusy extends Error {}
function lockBusy(error: unknown): boolean {
  return Boolean(error && typeof error==='object' && ('code' in error && error.code==='55P03'
    || 'cause' in error && lockBusy(error.cause)));
}
type Hop = { id: string; token: string; instance_id: string; boot_id: string; host_id: string; origin: string; epoch: number; revision: number; policy_hash: string };
async function transaction<T>(load: (tx: ProductTransaction) => Promise<T>): Promise<T> {
  if (currentReplayDb()) throw new HttpOriginPermitError('replay_unsupported');
  try { return await onPrimary(() => db.transaction(load)); } catch(error) {
    if(error instanceof HttpOriginPermitError) throw error;
    if(lockBusy(error)) throw new ControlBusy();
    throw new HttpOriginPermitError('unavailable');
  }
}
async function control(tx: ProductTransaction, nowait=false) {
  const [row] = await tx.execute<{ mode: string; epoch: number; revision: number; policy: unknown; policy_hash: string | null }>(sql`SELECT * FROM http_origin_control WHERE id=1 FOR UPDATE ${nowait ? sql`NOWAIT` : sql``}`);
  if (!row) throw new HttpOriginPermitError('configuration');
  const checked = httpOriginPolicySchema.safeParse(row.policy);
  if (!checked.success || httpOriginPolicyHash(checked.data) !== row.policy_hash) throw new HttpOriginPermitError('configuration');
  return { ...row, policy: checked.data };
}
async function event(tx: ProductTransaction, id: string, kind: string) {
  await tx.execute(sql`INSERT INTO http_origin_events(hop_id,kind) VALUES(${id}::uuid,${kind})`);
}
async function reserve(origin: string, signal: AbortSignal): Promise<Hop> {
  const instanceId = process.env.SERVICE_INSTANCE_ID;
  if (!instanceId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(instanceId)) throw new HttpOriginPermitError('configuration');
  for (;;) {
    if (signal.aborted) throw new HttpOriginPermitError('waiting_aborted');
    const hop = await transaction(async tx => {
      // DR fence가 첫 lock이다(seal/open-permits와 같은 fence→control 순서). fenced DB(옛 primary·승격 전 사본)는 새 외부 hop을 내주지 않는다.
      if (!await writerSiteActive(tx)) throw new HttpOriginPermitError('unavailable');
      const state = await control(tx,true);
      if (state.mode !== 'open') throw new HttpOriginPermitError('unavailable');
      const host = state.policy.instanceHosts[instanceId];
      if (!host) throw new HttpOriginPermitError('configuration');
      const expired = await tx.execute<{id:string}>(sql`UPDATE http_origin_hops SET state='cancelled',settled_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE state='reserved' AND reserved_until <= clock_timestamp() RETURNING id`);
      for (const row of expired) await event(tx,row.id,'cancelled');
      const [room] = await tx.execute<{ok:boolean}>(sql`SELECT
        NOT EXISTS(SELECT 1 FROM http_origin_hops WHERE origin=${origin} AND state IN ('reserved','dispatched','indeterminate'))
        AND (${host} <> 'oracle-osaka-smoke' OR (SELECT count(*) FROM http_origin_hops
          WHERE host_id='oracle-osaka-smoke' AND state IN ('reserved','dispatched','indeterminate')) < 2) AS ok`);
      if (!room.ok || signal.aborted) return null;
      const [row] = await tx.execute<Hop>(sql`INSERT INTO http_origin_hops(id,token,instance_id,boot_id,host_id,origin,epoch,revision,policy_hash,state,reserved_until)
        VALUES(${randomUUID()}::uuid,${randomUUID()}::uuid,${instanceId},${bootId}::uuid,${host},${origin},${state.epoch},${state.revision},${state.policy_hash},'reserved',clock_timestamp()+${RESERVATION_MS}*interval '1 millisecond') RETURNING *`);
      await event(tx,row.id,'reserved'); return row;
    }).catch(error=>{if(error instanceof ControlBusy)return null;throw error;});
    if (hop) return hop;
    try { await delay(50,undefined,{signal}); } catch { throw new HttpOriginPermitError('waiting_aborted'); }
  }
}
function exact(hop: Hop) { return sql`id=${hop.id}::uuid AND token=${hop.token}::uuid AND instance_id=${hop.instance_id}
  AND boot_id=${hop.boot_id}::uuid AND host_id=${hop.host_id} AND origin=${hop.origin} AND epoch=${hop.epoch} AND revision=${hop.revision} AND policy_hash=${hop.policy_hash}`; }
async function begin(hop: Hop, signal: AbortSignal): Promise<void> {
  await transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new HttpOriginPermitError('authority_lost');
    const state=await control(tx);
    if (signal.aborted || state.mode!=='open' || Number(state.epoch)!==Number(hop.epoch) || Number(state.revision)!==Number(hop.revision)
      || state.policy_hash!==hop.policy_hash || state.policy.instanceHosts[hop.instance_id]!==hop.host_id) throw new HttpOriginPermitError('authority_lost');
    const changed=await tx.execute(sql`UPDATE http_origin_hops SET state='dispatched',dispatched_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE ${exact(hop)} AND state='reserved' AND reserved_until>clock_timestamp() RETURNING id`);
    if(changed.length!==1) throw new HttpOriginPermitError('authority_lost');
    await event(tx,hop.id,'dispatched');
  });
}
/** Private: only the fixed native/reader coordinator below can call this. */
async function finish(hop: Hop, settled: boolean): Promise<void> {
  await transaction(async tx => {
    // Original owners can settle under draining/reconfiguration. This mutex does
    // not require today's policy to equal a historical, already charged hop.
    await tx.execute(sql`SELECT id FROM http_origin_control WHERE id=1 FOR UPDATE`);
    const state=settled?'released':'indeterminate';
    const changed=await tx.execute(sql`UPDATE http_origin_hops SET state=${state},
      settled_at=CASE WHEN ${settled} THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
      WHERE ${exact(hop)} AND state IN ('dispatched','indeterminate') AND state<>${state} RETURNING id`);
    if(changed.length) await event(tx,hop.id,state);
  });
}

/** No caller-supplied transport/proof: owns the real undici dispatch and reader. */
export async function requestOriginHop(url: string, init: Parameters<CappedRequest>[1]): Promise<Response> {
  const hop=await reserve(new URL(url).origin,init.signal);
  await begin(hop,init.signal);
  const pending=new Set<object>();
  let fetchSettled=false,bodySettled=false,cancelFailed=false,closed=false;
  let nativeDispatches=0,nativeTerminals=0,nativeUnknown=false;
  let closing: Promise<void>|undefined;
  const settle = (): Promise<void> => {
    if(closed || !fetchSettled || !bodySettled || pending.size || cancelFailed || nativeUnknown) return Promise.resolve();
    if(!closing) closing=finish(hop,true).then(()=>{closed=true;}).catch(()=>{});
    return closing;
  };
  class HopDispatcher extends Dispatcher {
    dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
      const identity={}; nativeDispatches++; pending.add(identity);
      let ended=false;
      const end=()=>{if(ended)return;ended=true;nativeTerminals++;pending.delete(identity);void settle();};
      const observed=new Proxy(handler,{
        get(target,key) {
          const value=Reflect.get(target,key,target);
          if(key==='onResponseEnd'||key==='onResponseError') return (...args:unknown[])=>{try {return typeof value==='function'?Reflect.apply(value,target,args):undefined;}finally{end();}};
          return typeof value==='function'?value.bind(target):value;
        },
      });
      try { return httpDispatcher().dispatch(options,observed); }
      catch(error) {nativeUnknown=true;pending.delete(identity);throw error;}
    }
  }
  let response: Response;
  try { response=await nativeHttpFetch(url,{...init,dispatcher:new HopDispatcher()}) as unknown as Response; }
  catch(error) {
    fetchSettled=true;bodySettled=true;
    // A synchronous/pre-dispatch rejection has no native terminal witness.
    // Conservatively retain its charge instead of inferring remote termination.
    await finish(hop,nativeDispatches>0 && nativeTerminals===nativeDispatches && pending.size===0 && !nativeUnknown).catch(()=>{});throw error;
  }
  fetchSettled=true;
  if(!response.body) {bodySettled=true;await settle();return response;}
  const reader=response.body.getReader();
  let reading: Promise<ReadableStreamReadResult<Uint8Array>>|undefined;
  let cancellation: Promise<void>|undefined;
  let cancelling=false,aborted=false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const detach=()=>init.signal.removeEventListener('abort',onAbort);
  const cancel=(reason: unknown):Promise<void>=>{
    if(cancellation)return cancellation;
    cancelling=true;
    const current=reading;
    cancellation=Promise.resolve().then(()=>reader.cancel(reason)).then(async()=>{
      await current?.catch(()=>{});bodySettled=true;detach();await settle();
    },async error=>{cancelFailed=true;detach();await current?.catch(()=>{});await finish(hop,false).catch(()=>{});throw error;});
    void cancellation.catch(()=>{});return cancellation;
  };
  const onAbort=()=>{aborted=true;void cancel(init.signal.reason);controller.error(init.signal.reason);};
  const body=new ReadableStream<Uint8Array>({
    start(value){controller=value;},
    async pull(value){
      if(cancelling)return;
      const current=reader.read();reading=current;
      try {
        const result=await current;
        if(aborted)value.error(init.signal.reason);
        else if(result.done){if(!cancelling){bodySettled=true;detach();await settle();}value.close();}
        else if(!cancelling)value.enqueue(result.value);
      }catch(error){if(!cancelling){bodySettled=true;detach();await settle();}value.error(aborted?init.signal.reason:error);}
      finally{if(reading===current)reading=undefined;}
    },cancel,
  });
  init.signal.addEventListener('abort',onAbort,{once:true});
  if(init.signal.aborted)onAbort();
  if(response.status<200 || response.status>599) {
    // WHATWG Response constructor rejects these real upstream status codes.
    // Settle the privately owned body first, then preserve the original result.
    await body.cancel().catch(()=>{});
    try { reader.releaseLock(); } catch { /* Failed cleanup retains its charge; keep the original status. */ }
    return response;
  }
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
