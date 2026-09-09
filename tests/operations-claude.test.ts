import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectAgent } from '@/lib/operations/agent';
import { seal, unseal } from '@/lib/operations/credential-vault';
import { DEFAULT_CONFIG, modelConfigSchema } from '@/lib/operations/contracts';
import { isolatedClaudeEnv, runClaude, validateClaudeCredential } from '@/lib/operations/claude';
import { captureClaudeToken, createClaudeCaptureState, handleClaudeOutput } from '@/lib/vendor/deppy-aibox/claude';
import type { CliRun } from '@/lib/crawl/classify';
const secret='test-secret-at-least-thirty-two-characters';
const token='sk-ant-oat01-'+ 'A'.repeat(64);
const auth=JSON.stringify({tokens:{access_token:'a'.repeat(30),refresh_token:'r'.repeat(30),id_token:'i'.repeat(30)}});
const input=[{repo:'o/r',url:'https://example.com',name:'Tasks',tagline:'Shared tasks',topics:[],language:null}];
const success={kind:'exit' as const,code:0,stdout:JSON.stringify({results:[{id:0,category:'Productivity',reason:'Tasks'}]}),stderr:''};
const dirs:string[]=[];let agent:ConnectAgent|undefined;
const original={home:process.env.CODEX_HOME,cli:process.env.CLAUDE_CLI,path:process.env.PATH};
afterEach(()=>{agent?.close();agent=undefined;for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});for(const [key,value] of [['CODEX_HOME',original.home],['CLAUDE_CLI',original.cli],['PATH',original.path]]){if(value)process.env[key!]=value;else delete process.env[key!];}});
const directory=()=>{const dir=mkdtempSync(join(tmpdir(),'claude-test-'));dirs.push(dir);return dir;};
function create(codex:CliRun,claude:CliRun,hasCodex=true){const dir=directory();writeFileSync(join(dir,'vault.enc'),seal(JSON.stringify({credential:hasCodex?auth:null,claudeCredential:token,appliedGeneration:0,state:{generation:2,configVersion:0,config:DEFAULT_CONFIG}}),secret));agent=new ConnectAgent(dir,secret,codex,claude);return {agent,dir};}
async function verify(a:ConnectAgent){a.test(DEFAULT_CONFIG);for(let i=0;i<100&&a.snapshot().busy;i++)await new Promise(r=>setTimeout(r,5));const v=a.snapshot().verification!;return ()=>a.apply({verificationId:v.id,expectedVersion:0,config:DEFAULT_CONFIG});}
describe('Claude fallback through the Deppy-aibox provider',()=>{
 it.each(['auth','timeout','missing','invalid'] as const)('falls back after Codex %s and retains both encrypted credentials',async reason=>{
  let claudeCalls=0;const {agent:a,dir}=create(async()=>reason==='auth'?{kind:'exit',code:1,stdout:'',stderr:'401 authentication'}:reason==='invalid'?{kind:'exit',code:0,stdout:'wrong',stderr:''}:{kind:reason},async()=>{claudeCalls++;return success;});
  const apply=await verify(a);expect(a.snapshot().verification?.state).toBe('verified');apply();
  expect((await a.classify(input)).categories).toEqual(['Productivity']);expect(claudeCalls).toBe(2);expect(a.snapshot().lastAttempt?.model).toBe('sonnet');
  const encrypted=readFileSync(join(dir,'vault.enc'),'utf8');expect(encrypted).not.toContain(token);expect(JSON.parse(unseal(encrypted,secret)).credential).toBe(auth);expect(JSON.stringify(a.snapshot())).not.toContain(token);
 });
 it('works with only a Claude account and preserves applied configuration after restart',async()=>{
  const {agent:a,dir}=create(async()=>{throw new Error('must not run');},async()=>success,false);(await verify(a))();a.close();agent=new ConnectAgent(dir,secret,undefined,async()=>success);
  expect((await agent.classify(input)).categories).toEqual(['Productivity']);expect(agent.snapshot().connected).toBe(false);expect(agent.snapshot().claudeConnected).toBe(true);
 });
 it('does not run fallback after primary success, and returns null if both fail later',async()=>{
  let fail=false,calls=0;const {agent:a}=create(async()=>fail?{kind:'timeout'}:success,async()=>{calls++;return fail?{kind:'timeout'}:success;});(await verify(a))();calls=0;
  expect((await a.classify(input)).categories).toEqual(['Productivity']);expect(calls).toBe(0);fail=true;expect((await a.classify(input)).categories).toEqual([null]);
 });
 it('cannot apply when both providers fail',async()=>{
  const {agent:a}=create(async()=>({kind:'timeout'}),async()=>({kind:'timeout'}));const apply=await verify(a);expect(a.snapshot().verification?.state).toBe('failed');expect(apply).toThrow();
 });
 it('rejects API keys, malformed tokens and unsupported Claude effort',()=>{
  expect(validateClaudeCredential(token)).toBe(token);expect(()=>validateClaudeCredential('sk-ant-api03-'+ 'A'.repeat(64))).toThrow();expect(()=>validateClaudeCredential(token+'\n')).toThrow();expect(modelConfigSchema.safeParse({...DEFAULT_CONFIG,fallback:{model:'sonnet',effort:'xhigh'}}).success).toBe(false);
  expect(isolatedClaudeEnv('/tmp/test')).not.toHaveProperty('ANTHROPIC_API_KEY');
 });
 it('uses aibox capture without exposing streamed tokens',()=>{
  const state=createClaudeCaptureState();handleClaudeOutput(Buffer.from('sk-ant-'),state);const update=handleClaudeOutput(Buffer.from('oat01-'+ 'A'.repeat(64)+'\nToken ready\n'),state);
  expect(update.credential?.value).toBe(token);expect(update.out??'').not.toContain(token);expect(captureClaudeToken(token,true)).toBe(token);
 });
 it('rejects input outside an active Claude login',()=>{const {agent:a}=create(async()=>success,async()=>success);expect(()=>a.input('stale','code')).toThrow();});
 it('runs the Claude adapter with isolated OAuth and consumes structured output',async()=>{
  const dir=directory(),cli=join(dir,'claude');writeFileSync(cli,'#!/usr/bin/env node\nlet input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{const args=process.argv;if(!args.includes("--safe-mode")||!args.includes("--json-schema")||!process.env.CLAUDE_CODE_OAUTH_TOKEN||process.env.ANTHROPIC_API_KEY)process.exit(2);console.log(JSON.stringify({structured_output:{results:[{id:0,category:"Productivity",reason:"Tasks"}]}}));});\n',{mode:0o700});process.env.CLAUDE_CLI=cli;
  const result=await runClaude(token)(['-m','sonnet'],'untrusted sample',3000);expect(result).toEqual(success);
 });
 it('captures Claude OAuth through aibox, persists it and drains the PTY process',async()=>{
  const dir=directory(),script=join(dir,'script');
  writeFileSync(script,'#!/usr/bin/env node\nconsole.log("https://claude.ai/oauth/authorize?client_id=test&state=test");process.stdin.on("data",data=>{if(!data.includes(13))return;console.log("sk-ant-oat01-"+"A".repeat(64)+"\\nToken ready");});setInterval(()=>{},1000);\n',{mode:0o700});
  process.env.PATH=dir+':'+original.path;
  const {agent:a,dir:vault}=create(async()=>success,async()=>success);
  a.connect('claude');
  for(let i=0;i<100&&!a.snapshot().connection?.inputRequired;i++)await new Promise(r=>setTimeout(r,10));
  const id=a.snapshot().connection!.id;expect(a.snapshot().connection?.inputRequired).toBe(true);
  expect(()=>a.input(id,'code\nsecond')).toThrow();a.input(id,'test-code#state');
  for(let i=0;i<100&&a.snapshot().busy;i++)await new Promise(r=>setTimeout(r,10));
  expect(a.snapshot().connection?.state).toBe('stored');expect(a.snapshot().busy).toBe(null);expect(a.snapshot().generation).toBe(3);
  expect(JSON.stringify(a.snapshot())).not.toContain('test-code');expect(JSON.stringify(a.snapshot())).not.toContain(token);
  const saved=JSON.parse(unseal(readFileSync(join(vault,'vault.enc'),'utf8'),secret));expect(saved.credential).toBe(auth);expect(saved.claudeCredential).toBe(token);
  await expect(a.classify(input)).rejects.toThrow('모델 검사');
 });
 it('cancels a Claude login and permits the next connection',async()=>{
  const dir=directory();writeFileSync(join(dir,'script'),'#!/usr/bin/env node\nsetInterval(()=>{},1000);\n',{mode:0o700});process.env.PATH=dir+':'+original.path;
  const {agent:a}=create(async()=>success,async()=>success);const id=a.connect('claude').connection!.id;a.cancel(id);
  for(let i=0;i<100&&a.snapshot().busy;i++)await new Promise(r=>setTimeout(r,10));
  expect(a.snapshot().busy).toBe(null);expect(a.snapshot().connection?.state).toBe('cancelled');expect(a.snapshot().generation).toBe(2);
  expect(()=>a.connect('claude')).not.toThrow();a.cancel(a.snapshot().connection!.id);
  for(let i=0;i<100&&a.snapshot().busy;i++)await new Promise(r=>setTimeout(r,10));
 });

 it('reports an account probe separately from model configuration application',async()=>{
  const {agent:a}=create(async()=>success,async()=>success);a.probe('codex');
  for(let i=0;i<100&&a.snapshot().busy;i++)await new Promise(r=>setTimeout(r,5));
  expect(a.snapshot().accounts?.codex?.result).toBe('success');expect(a.snapshot().accounts?.codex?.checkedAt).toBeTruthy();
  expect(a.snapshot().verification).toBe(null);expect(a.snapshot().configReady).toBe(false);
  (await verify(a))();expect(a.snapshot().configReady).toBe(true);
 });
 it('marks a rejected Claude code as failed without overwriting stored credentials',async()=>{
  const dir=directory();writeFileSync(join(dir,'script'),'#!/usr/bin/env node\nconsole.log("https://claude.ai/oauth/authorize?client_id=test&state=test");process.stdin.on("data",data=>{if(data.includes(13))console.log("OAuth error: Invalid code");});setInterval(()=>{},1000);\n',{mode:0o700});process.env.PATH=dir+':'+original.path;
  const {agent:a}=create(async()=>success,async()=>success);a.connect('claude');
  for(let i=0;i<100&&!a.snapshot().connection?.inputRequired;i++)await new Promise(r=>setTimeout(r,10));
  a.input(a.snapshot().connection!.id,'test-code#state');
  for(let i=0;i<100&&a.snapshot().busy;i++)await new Promise(r=>setTimeout(r,10));
  expect(a.snapshot().busy).toBe(null);expect(a.snapshot().connection?.error).toBe('oauth_rejected');expect(a.snapshot().connection?.state).toBe('failed');
  expect(a.snapshot().generation).toBe(2);expect(a.snapshot().connected).toBe(true);expect(a.snapshot().claudeConnected).toBe(true);
 });

});
