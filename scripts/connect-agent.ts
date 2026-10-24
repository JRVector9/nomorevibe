import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ConnectAgent } from '../lib/operations/agent';
import { agentToken } from '../lib/operations/agent-client';
import { observeService } from '../lib/operations/observations';
import { ModelCapacityDeferredError } from '../lib/llm/capacity-deferred';
import { probeCliServingContracts } from '../lib/llm/cli-serving-contract';
const secret=process.env.OPERATIONS_AGENT_SECRET ?? '';
if(secret.length<32)throw new Error('OPERATIONS_AGENT_SECRET is required');
const agent=new ConnectAgent(process.env.CODEX_VAULT_DIR ?? '/var/lib/nomorevibe-codex',secret);
const expected=Buffer.from(`Bearer ${agentToken(secret)}`);
const startedAt=Date.now();
const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  const auth=Buffer.from(req.headers.authorization ?? '');
  if(auth.length!==expected.length || !timingSafeEqual(auth,expected)){res.writeHead(401);res.end('{"error":"Unauthorized"}');return;}
  if(req.method!=='POST'||req.url!=='/rpc'){res.writeHead(404);res.end('{}');return;}
  try {
    let size=0;const chunks:Buffer[]=[];
    // Original data remains capped at 64 KiB; the fixed authority adds at most 8 KiB.
    for await(const chunk of req){size+=chunk.length;if(size>65536+8192){res.writeHead(413);res.end('{}');return;}chunks.push(chunk);}
    const {action,data}=JSON.parse(Buffer.concat(chunks).toString());let result:unknown;
    if (Buffer.byteLength(JSON.stringify({ action, data: action === 'classify' && data?.authority
      ? { ...data, authority: undefined } : data })) > 65536) { res.writeHead(413); res.end('{}'); return; }
    switch(action){
      case 'status':result=agent.snapshot();break;
      case 'connect':result=agent.connect(data?.provider ?? 'codex');break;
      case 'input':result=agent.input(String(data.id),data.code);break;
      case 'cancel':result=agent.cancel(String(data.id));break;
      case 'probe':result=await agent.probe(data.provider);break;
      case 'test':result=await agent.test(data.config);break;
      case 'apply':result=agent.apply(data);break;
      case 'classify':result=await agent.classify(data);break;
      default:throw new Error('알 수 없는 작업입니다.');
    }
    res.end(JSON.stringify(result));
  } catch(error){res.writeHead(409);res.end(JSON.stringify(error instanceof ModelCapacityDeferredError
    ? { error: 'model_capacity_deferred', code: 'model_capacity_deferred', reason: error.reason }
    : {error:error instanceof Error && !error.message.startsWith('[')?error.message:'요청 형식이 올바르지 않습니다.'}));}
});
server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxConnections=24;
let observing=false;
const timer=setInterval(()=>{
  if(observing)return;observing=true;const state=agent.snapshot();
  // Device codes are available only through the privileged live RPC, never general DB snapshots.
  void observeService('connect-agent',{...state,status:'running',bootedAt:startedAt,release:process.env.RELEASE_TAG??'unknown',connection:state.connection?{id:state.connection.id,provider:state.connection.provider,error:state.connection.error,state:state.connection.state,expiresAt:state.connection.expiresAt}:null,rssBytes:process.memoryUsage().rss})
    .catch(()=>{}).finally(()=>{observing=false;});
},5000);
void probeCliServingContracts().then(() => server.listen(Number(process.env.PORT ?? 3020),'0.0.0.0'));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(timer);server.close();agent.close();process.exit(0);});
