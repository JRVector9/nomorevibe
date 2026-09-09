import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectAgent } from '@/lib/operations/agent';
import { seal, unseal, validateCredential, devicePrompt } from '@/lib/operations/credential-vault';
import { modelConfigSchema, type ModelConfig } from '@/lib/operations/contracts';
const DEFAULT_CONFIG: ModelConfig={primary:{model:'gpt-5.3-codex-spark',effort:'xhigh'},fallback:{model:'gpt-5.6-terra',effort:'high'}};
const secret='test-operations-secret-with-32-characters';
const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'a'.repeat(30),refresh_token:'r'.repeat(30),id_token:'i'.repeat(30),account_id:'test'},last_refresh:'2026-09-09'});
let dir='',agent:ConnectAgent|undefined;
const originalHome=process.env.CODEX_HOME;
afterEach(()=>{agent?.close();agent=undefined;if(dir)rmSync(dir,{recursive:true,force:true});dir='';if(originalHome)process.env.CODEX_HOME=originalHome;else delete process.env.CODEX_HOME;});
async function settle(){for(let i=0;i<50&&agent?.snapshot().busy;i++)await new Promise(resolve=>setTimeout(resolve,5));}
function connected(run:Parameters<typeof create>[0]){return create(run);}
function create(run:ConstructorParameters<typeof ConnectAgent>[2]) {
 dir=mkdtempSync(join(tmpdir(),'operations-test-'));
 writeFileSync(join(dir,'vault.enc'),seal(JSON.stringify({credential:auth,appliedGeneration:0,state:{connected:true,generation:1,configVersion:0,config:DEFAULT_CONFIG}}),secret));
 agent=new ConnectAgent(dir,secret,run);return agent;
}
describe('operations credentials and model lifecycle',()=>{
 it('authenticates encrypted storage and retains refresh credentials',()=>{
  const encrypted=seal(auth,secret);expect(encrypted).not.toContain('access_token');expect(unseal(encrypted,secret)).toBe(auth);
  expect(()=>unseal(encrypted,'wrong-secret-with-at-least-32-characters')).toThrow();expect(validateCredential(auth)).toBe(auth);
  expect(()=>validateCredential(JSON.stringify({tokens:{access_token:'a'.repeat(30)}}))).toThrow();
 });
 it('only exposes the official device URL and bounded device code',()=>{
  expect(devicePrompt('https://evil.example/codex/device AAAA-BBBBB')).toEqual({code:'AAAA-BBBBB'});
  expect(devicePrompt('https://auth.openai.com/codex/device?secret=x AAAA-BBBBB')).toEqual({url:'https://auth.openai.com/codex/device',code:'AAAA-BBBBB'});
 });
 it('rejects unknown or duplicate models',()=>{
  expect(modelConfigSchema.safeParse({...DEFAULT_CONFIG,fallback:DEFAULT_CONFIG.primary}).success).toBe(false);
  expect(modelConfigSchema.safeParse({...DEFAULT_CONFIG,primary:{model:'shell-injection',effort:'high'}}).success).toBe(false);
 });
 it('cannot classify before verification/apply; rejects stale apply and uses validated config',async()=>{
  const calls:string[][]=[];const a=connected(async args=>{calls.push(args);return {kind:'exit',code:0,stdout:JSON.stringify({results:[{id:0,category:'Productivity',reason:'Shared tasks'}]}),stderr:''};});
  const input={inputs:[{repo:'o/r',url:'https://example.com',name:'Tasks',tagline:'Tasks',topics:[],language:null}]};
  await expect(a.classify(input)).rejects.toThrow('모델 검사');a.test(DEFAULT_CONFIG);await settle();
  const v=a.snapshot().verification!;expect(v.state).toBe('verified');expect(v.results).toHaveLength(2);
  expect(()=>a.apply({verificationId:v.id,expectedVersion:2,config:DEFAULT_CONFIG})).toThrow();
  expect(()=>a.apply({verificationId:v.id,expectedVersion:0,config:{...DEFAULT_CONFIG,fallback:null}})).toThrow();
  a.apply({verificationId:v.id,expectedVersion:0,config:DEFAULT_CONFIG});expect((await a.classify(input)).categories).toEqual(['Productivity']);
  expect(a.snapshot().lastUsedVersion).toBe(1);expect(calls[0]).toContain('gpt-5.3-codex-spark');
  expect(readFileSync(join(dir,'vault.enc'),'utf8')).not.toContain('tokens');
 });
 it('failure and concurrent probes cannot authorize a config',async()=>{
  let release:()=>void=()=>{};const gate=new Promise<void>(r=>{release=r;});
  const a=connected(async()=>{await gate;return {kind:'timeout'};});a.test(DEFAULT_CONFIG);
  expect(()=>a.test(DEFAULT_CONFIG)).toThrow('진행 중');release();await settle();expect(a.snapshot().verification?.state).toBe('failed');
  expect(()=>a.apply({verificationId:a.snapshot().verification!.id,expectedVersion:0,config:DEFAULT_CONFIG})).toThrow();
 });
});
