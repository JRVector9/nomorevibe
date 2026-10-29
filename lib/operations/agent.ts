import { classificationModelOptions, classificationModelProvider, knownClassificationProvider } from "./classification-models";
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { classifyCategories, defaultRun, failureReason, OUTPUT_SCHEMA, type CliRun, type CliResult } from '@/lib/crawl/classify';
import { classifyPayloadSchema, DEFAULT_CONFIG, modelConfigSchema, storedModelConfigSchema, type AgentStatus, type ClassificationAuthority } from './contracts';
import { stripAnsi } from '@/lib/vendor/deppy-aibox/core';
import { claudeProvider } from '@/lib/vendor/deppy-aibox/claude';
import { claudeClassificationArgs, isolatedClaudeEnv, killProcessGroup, parseClaudeClassificationResult, runClaude, validateClaudeCredential } from './claude';
import { devicePrompt, seal, unseal, validateCredential } from './credential-vault';
import { publicationClassificationPath, PUBLICATION_CLASSIFY_ROUTE, runPublicationClassificationCall } from '@/lib/crawl/publication-classify-capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { CliPhysicalEndUnknownError } from '@/lib/llm/cli-model-capacity';
import type { CategoryDefinitions } from '@/lib/crawl/settings-schema';
import type { ClassifyInput } from '@/lib/crawl/classify';
import { resolveCliServingContract } from '@/lib/llm/cli-serving-contract';

const SAMPLE = [{ repo: 'verification/sample', url: 'https://example.com', name: 'Task planner', tagline: 'Plan team tasks and deadlines in a shared calendar.', topics: ['productivity'], language: null }];
/** Single process owns login, classification and CLI refresh. No shared writable auth.json. */
export class ConnectAgent {
  private credential: string | null = null;
  private claudeCredential: string | null = null;
  private appliedGeneration = 0;
  private home: string;
  private loginChild: ChildProcess | null = null;
  private pendingEnter: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private activeClassification: Promise<unknown> | null = null;
  private state: AgentStatus = { connected: false, generation: 0, configVersion: 0, config: DEFAULT_CONFIG,
    busy: null, activity: null, connection: null, verification: null, lastAttempt: null, appliedAt: null, lastUsedVersion: null };
  constructor(private directory: string, private secret: string, private run: CliRun = defaultRun, private claudeRun?: CliRun) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    this.home = mkdtempSync(join(tmpdir(), 'nomorevibe-codex-'));
    const file = join(directory, 'vault.enc');
    if (existsSync(file)) {
      const saved = JSON.parse(unseal(readFileSync(file, 'utf8'), secret));
      this.credential = saved.credential ? validateCredential(saved.credential) : null;
      this.claudeCredential = saved.claudeCredential ? validateClaudeCredential(saved.claudeCredential) : null;
      this.appliedGeneration = saved.appliedGeneration;
      this.state = { ...this.state, ...saved.state, config: storedModelConfigSchema.parse(saved.state.config), busy: null, activity: null, connection: null, verification: null };
      this.state.connected = !!this.credential; this.state.claudeConnected = !!this.claudeCredential;
      if (this.credential) this.writeAuth(this.home, this.credential);
    }
    process.env.CODEX_HOME = this.home;
    delete process.env.CODEX_ACCESS_TOKEN; delete process.env.OPENAI_API_KEY;
  }
  snapshot(): AgentStatus {
    const classificationContracts = [this.state.config.primary, this.state.config.fallback].flatMap(model => {
      if (!model) return [];
      const provider = knownClassificationProvider(model.model);
      if (!provider) return [];
      const contract = resolveCliServingContract(PUBLICATION_CLASSIFY_ROUTE, provider, model.model);
      return contract ? [contract] : [];
    });
    return structuredClone({...this.state, modelOptions: classificationModelOptions(), defaultModelConfig: DEFAULT_CONFIG, classificationCapacityVersion: 1, classificationContracts, serverNow: Date.now(),
      configReady: this.state.configVersion > 0 && this.appliedGeneration === this.state.generation && modelConfigSchema.safeParse(this.state.config).success, classifyReady: this.canClassify()});
  }
  /**
   * 분류는 한 번이라도 적용한 설정이 있고 계정이 하나라도 있으면 한다. 다시 로그인해 generation 이 올라도 막지 않는다 —
   * 2026-10-08 Codex 재로그인 뒤 적용 전 한 시간 동안 잘 돌던 Claude 예비까지 거부해 발행이 2건에 그쳤다.
   * 새 계정에서 안 되는 모델은 호출이 실패하고 다음 모델로 넘어간다. configReady 는 "새 계정으로 다시 검사·적용"이 남았는지만 뜻한다.
   */
  private canClassify() { return !this.shuttingDown && this.state.configVersion > 0 && modelConfigSchema.safeParse(this.state.config).success && (!!this.credential || !!this.claudeCredential); }
  private writeAuth(home: string, value: string) {
    const file = join(home, 'auth.json'); writeFileSync(file+'.tmp', value, { mode: 0o600 }); renameSync(file+'.tmp',file); chmodSync(file,0o600);
  }
  private persist() {
    const file = join(this.directory,'vault.enc');
    const saved = { credential: this.credential, claudeCredential: this.claudeCredential, appliedGeneration: this.appliedGeneration, state: { ...this.state, busy: null, activity: null, connection: null, verification: null } };
    writeFileSync(file+'.tmp',seal(JSON.stringify(saved),this.secret),{mode:0o600});renameSync(file+'.tmp',file);
  }
  private captureRefresh() {
    // Called only after CLI close; refresh tokens cannot race another CLI owner.
    if (this.credential && existsSync(join(this.home,'auth.json'))) this.credential = validateCredential(readFileSync(join(this.home,'auth.json'),'utf8'));
    this.persist();
  }
  private startActivity(kind: 'login' | 'oauth_exchange' | 'model', durationMs: number, model?: string) {
    const startedAt=Date.now();this.state.activity={id:randomUUID(),kind,startedAt,deadlineAt:startedAt+durationMs,...(model?{model}:{})};
  }
  private available() {
    if (this.shuttingDown) throw new ModelCapacityDeferredError('draining');
    if (this.state.busy) throw new Error('다른 AI 작업이 진행 중입니다. 잠시 후 다시 시도해주세요.');
  }
  connect(provider: 'codex' | 'claude' = 'codex') {
    this.available();
    if(provider === 'claude') return this.connectClaude();
    if(provider !== 'codex') throw new Error('지원하지 않는 AI 제공자입니다.');
    const id = randomUUID(), loginHome = mkdtempSync(join(tmpdir(),'nomorevibe-login-'));
    this.state.busy = 'login';this.startActivity('login',10*60_000);
    this.state.connection = { id, provider: 'codex', state: 'starting', expiresAt: Date.now()+10*60_000 };
    const child = spawn(process.env.CODEX_CLI ?? 'codex',['login','--device-auth'], { cwd: tmpdir(), env: { ...process.env, CODEX_HOME: loginHome }, detached: true, stdio: ['ignore','pipe','pipe'] });
    this.loginChild = child; let output = '', cancelled = false;
    const timer = setTimeout(() => { cancelled = true; if(this.state.connection?.id===id)this.state.connection.state='expired'; killProcessGroup(child.pid); },10*60_000);
    const capture = (chunk: Buffer) => { output = (output+chunk.toString()).slice(-8192); if(this.state.connection?.id===id && !cancelled) Object.assign(this.state.connection,devicePrompt(output),{state:'awaiting_approval'}); };
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.on('error',()=>{ if(this.state.connection?.id===id)this.state.connection.state='failed'; });
    child.on('close',code=>{
      clearTimeout(timer);killProcessGroup(child.pid);
      try {
        if(code===0 && !cancelled && this.state.connection?.state!=='cancelled') {
          const credential=validateCredential(readFileSync(join(loginHome,'auth.json'),'utf8'));
          const previous=structuredClone(this.state),oldCredential=this.credential,oldApplied=this.appliedGeneration;
          this.writeAuth(this.home,credential);this.credential=credential;
          this.state.connected=true;this.storedAccount('codex');this.state.generation++;this.appliedGeneration=0;this.state.verification=null;
          try{this.persist();}catch{this.state=previous;this.credential=oldCredential;this.appliedGeneration=oldApplied;if(oldCredential)this.writeAuth(this.home,oldCredential);else rmSync(join(this.home,'auth.json'),{force:true});throw new Error('credential_store_failed');}
          if(this.state.connection)this.state.connection.state='stored';
        } else if(this.state.connection && !['cancelled','expired'].includes(this.state.connection.state)) this.state.connection.state='failed';
      } catch { if(this.state.connection)this.state.connection.state='failed'; }
      finally { this.state.busy=null;this.state.activity=null;this.loginChild=null;output='';rmSync(loginHome,{recursive:true,force:true}); }
    });
    return this.snapshot();
  }
  private routeRun: CliRun = (args, stdin, timeout) => {
    if (this.shuttingDown) throw new ModelCapacityDeferredError('draining');
    const claude = classificationModelProvider(args[args.indexOf('-m') + 1]) === 'claude-cli';
    if (claude ? !this.claudeCredential : !this.credential) return Promise.resolve({kind:'exit',code:1,stdout:'',stderr:'authentication required'});
    this.startActivity('model',timeout,args[args.indexOf('-m')+1]);
    return (claude ? this.claudeRun ?? runClaude(this.claudeCredential!) : this.run)(args,stdin,timeout);
  };
  private nativeClassificationRun(payload: { inputs: ClassifyInput[]; definitions?: CategoryDefinitions }, authority: ClassificationAuthority): CliRun {
    return async (codexArgs, stdin, timeoutMs) => {
      if (this.shuttingDown) throw new ModelCapacityDeferredError('draining');
      const model = codexArgs[codexArgs.indexOf('-m') + 1], claude = classificationModelProvider(model) === 'claude-cli';
      if (claude ? !this.claudeCredential : !this.credential) return { kind: 'exit', code: 1, stdout: '', stderr: 'authentication required' };
      this.startActivity('model', timeoutMs, model);
      const cwd = mkdtempSync(join(tmpdir(), claude ? 'nomorevibe-claude-run-' : 'nomorevibe-classify-run-'));
      let unknown = false;
      try {
        const args = claude ? claudeClassificationArgs(model) : [...codexArgs];
        // Bind the exact schema bytes in the runner input; do not trust a shared mutable schema pathname.
        if (!claude) args[args.indexOf('--output-schema') + 1] = 'output-schema.json';
        const result = await runPublicationClassificationCall({ routeId: PUBLICATION_CLASSIFY_ROUTE,
          provider: claude ? 'claude-cli' : 'codex-cli', model, command: claude ? process.env.CLAUDE_CLI ?? 'claude' : process.env.CODEX_CLI ?? 'codex',
          args, stdin, cwd, env: claude ? { ...isolatedClaudeEnv(cwd), CLAUDE_CODE_OAUTH_TOKEN: this.claudeCredential! } : { ...process.env },
          boundEnvKeys: claude ? ['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] : [], timeoutMs,
          files: claude ? [] : [{ path: 'output-schema.json', content: JSON.stringify(OUTPUT_SCHEMA) }],
          maxStdoutBytes: 64 * 1024, maxStderrBytes: 32 * 1024 }, payload, authority, () => this.snapshot());
        const parsed: CliResult = result.kind === 'exit' ? result : { kind: result.kind === 'missing_cli' ? 'missing'
          : result.kind === 'cancelled' ? 'cli_error' : result.kind };
        return claude ? parseClaudeClassificationResult(parsed) : parsed;
      } catch (error) { unknown = error instanceof CliPhysicalEndUnknownError; throw error; }
      finally { if (!unknown) rmSync(cwd, { recursive: true, force: true }); }
    };
  }
  private stopLogin() {
    if(this.pendingEnter)clearTimeout(this.pendingEnter);this.pendingEnter=null;
    killProcessGroup(this.loginChild?.pid);
  }
  private connectClaude() {
    const id = randomUUID(), loginHome = mkdtempSync(join(tmpdir(),'nomorevibe-claude-login-'));
    const provider = claudeProvider(), captureState = provider.createState!();
    const ctx = {tmpDir: loginHome, env: isolatedClaudeEnv(loginHome)};
    const spec = provider.spawn(ctx);
    this.state.busy='login';this.startActivity('login',10*60_000);
    this.state.connection={id,provider:'claude',state:'starting',inputRequired:false,expiresAt:Date.now()+10*60_000};
    const child = spawn(spec.command,spec.args ?? [],{cwd:loginHome,env:{...spec.env,NODE_ENV:process.env.NODE_ENV},detached:true,stdio:['pipe','pipe','pipe']});
    this.loginChild=child;
    let captured: string | null = null;
    let exchangeTimer: ReturnType<typeof setTimeout> | undefined;
    const timer=setTimeout(()=>{if(this.state.connection?.id===id)this.state.connection.state='expired';killProcessGroup(child.pid);},10*60_000);
    const capture=(chunk:Buffer)=>{
      if(this.state.connection?.id!==id || ['expired','cancelled','failed'].includes(this.state.connection.state))return;
      const update=provider.onOutput!(chunk,captureState,ctx);
      if(update?.url && this.state.connection.state==='starting')Object.assign(this.state.connection,{url:update.url,state:'awaiting_approval',inputRequired:true});
      if(update?.credential){captured=update.credential.value;killProcessGroup(child.pid);}
      else if(this.state.connection.state==='exchanging' && /oauth error|authentication (?:failed|error)|invalid (?:authorization )?code|invalid_grant|token exchange failed/i.test(stripAnsi(captureState.buf))) {
        this.state.connection.state='failed';this.state.connection.error='oauth_rejected';killProcessGroup(child.pid);
      }
    };
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    child.stdin.on('error',()=>{});
    child.on('error',()=>{if(this.state.connection?.id===id)this.state.connection.state='failed';});
    child.on('close',()=>{
      clearTimeout(timer);clearTimeout(exchangeTimer);if(this.pendingEnter)clearTimeout(this.pendingEnter);this.pendingEnter=null;this.exchangeDeadline=null;killProcessGroup(child.pid);
      try {
        if(!this.state.connection || ['cancelled','expired','failed'].includes(this.state.connection.state))return;
        captured ??= provider.onClose!(captureState,ctx)?.credential?.value ?? null;
        if(!captured)throw new Error('missing_credential');
        const token=validateClaudeCredential(captured), previous=structuredClone(this.state),old=this.claudeCredential,oldApplied=this.appliedGeneration;
        this.claudeCredential=token;this.state.claudeConnected=true;this.storedAccount('claude');this.state.generation++;this.appliedGeneration=0;this.state.verification=null;
        try{this.persist();}catch{this.claudeCredential=old;this.state=previous;this.appliedGeneration=oldApplied;throw new Error('store_failed');}
        this.state.connection={id,provider:'claude',state:'stored',expiresAt:Date.now()};
      }catch{if(this.state.connection)this.state.connection={id,provider:'claude',state:'failed',error:'credential_capture_failed',expiresAt:Date.now()};}
      finally{captured=null;captureState.buf='';captureState.dispOut='';captureState.dispTail='';this.loginChild=null;this.state.busy=null;this.state.activity=null;rmSync(loginHome,{recursive:true,force:true});}
    });
    this.exchangeDeadline=()=>{exchangeTimer=setTimeout(()=>{if(this.state.connection?.id===id && this.state.connection.state==='exchanging'){this.state.connection.state='failed';this.state.connection.error='exchange_timeout';killProcessGroup(child.pid);}},45_000);};
    return this.snapshot();
  }
  private exchangeDeadline: (()=>void) | null = null;
  input(id: string, code: string) {
    const c=this.state.connection;
    if(!c || c.id!==id || c.provider!=='claude' || c.state!=='awaiting_approval' || !c.inputRequired || !this.loginChild?.stdin)throw new Error('Claude 인증 입력 대기 상태가 아닙니다.');
    if(typeof code!=='string' || !/^[A-Za-z0-9_#.-]{1,2048}$/.test(code))throw new Error('인증 코드 형식을 확인해주세요.');
    // Ink treats a long code plus Enter in one chunk as a paste. Submit a separate key event.
    this.loginChild.stdin.write(code);
    this.pendingEnter=setTimeout(()=>{this.pendingEnter=null;if(this.state.connection?.id===id&&this.state.connection.state==='exchanging'&&this.loginChild?.stdin?.writable)this.loginChild.stdin.write('\r');},250);
    c.inputRequired=false;c.state='exchanging';this.startActivity('oauth_exchange',45_000);this.exchangeDeadline?.();
    return this.snapshot();
  }
  cancel(id: string) {
    if(this.state.connection?.id !== id)throw new Error('연결 세션이 변경되었습니다.');
    if(this.loginChild){this.state.connection.state='cancelled';this.stopLogin();}
    return this.snapshot();
  }
  private storedAccount(provider: 'codex' | 'claude') {
    this.state.accounts={...this.state.accounts,[provider]:{storedAt:new Date().toISOString()}};
  }
  private checkedAccount(model: string, result: string) {
    const provider=classificationModelProvider(model)==='claude-cli'?'claude':'codex';
    this.state.accounts={...this.state.accounts,[provider]:{...this.state.accounts?.[provider],model,result,checkedAt:new Date().toISOString()}};
  }
  private async manualModelAdmission() {
    try {
      // Manual account/configuration checks have no publisher source/job authority.
      if (await publicationClassificationPath() !== 'legacy') throw new ModelCapacityDeferredError('provider_contract_unavailable');
    } catch (error) { this.state.busy = null; throw error; }
  }
  async probe(provider: 'codex' | 'claude') {
    this.available();
    if(provider!=='codex'&&provider!=='claude')throw new Error('지원하지 않는 AI 제공자입니다.');
    if(provider==='codex'?!this.credential:!this.claudeCredential)throw new Error('계정을 먼저 연결해주세요.');
    const expectedProvider=provider==='claude'?'claude-cli':'codex-cli';
    const selected=[this.state.config.primary,this.state.config.fallback].find(m=>m&&knownClassificationProvider(m.model)===expectedProvider);
    const fallback=classificationModelOptions().find(option=>option.provider===expectedProvider);
    if(!selected&&!fallback)throw new Error('이 제공자의 모델이 등록되어 있지 않습니다.');
    const model=selected??{model:fallback!.model,effort:'high' as const};
    this.state.busy='account_check';
    await this.manualModelAdmission();
    void (async()=>{
      try{
        if(provider==='claude') {
          this.startActivity('model',35_000,model.model);
          const response=await (this.claudeRun??runClaude(this.claudeCredential!,'text'))(['-m',model.model],'hi~',35_000);
          const ok=response.kind==='exit'&&response.code===0&&Boolean(response.stdout.trim());
          const result=ok?'success':failureReason(response);
          this.checkedAccount(model.model,result);
          // Only the fixed greeting's successful reply is exposed, never raw CLI diagnostics or credentials.
          const reply=ok&&response.kind==='exit'?response.stdout.trim().slice(0,2000).replace(/sk-ant-[A-Za-z0-9_-]+/g,'[REDACTED]'):undefined;
          this.state.accounts!.claude!.probe={prompt:'hi~',reply,result,model:model.model,checkedAt:new Date().toISOString()};
        } else await classifyCategories(SAMPLE,this.routeRun,[{...model,timeoutMs:35_000}],(model,result)=>this.checkedAccount(model,result));
      }
      catch{this.checkedAccount(model.model,'error');}
      finally{try{this.captureRefresh();}catch{this.checkedAccount(model.model,'credential_store_failed');}this.state.busy=null;this.state.activity=null;}
    })();
    return this.snapshot();
  }
  async test(configInput: unknown) {
    this.available();if(!this.credential && !this.claudeCredential)throw new Error('Codex 또는 Claude 계정부터 연결해주세요.');
    const config=modelConfigSchema.parse(configInput),id=randomUUID(),generation=this.state.generation;
    this.state.busy='verification';
    await this.manualModelAdmission();
    this.state.verification={id,state:'running',config,generation,results:[]};
    void (async()=>{
      try {
        let successes = 0;
        for(const m of [config.primary,...(config.fallback?[config.fallback]:[])]) {
          const categories=await classifyCategories(SAMPLE,this.routeRun,[{...m,timeoutMs:35_000}],(model,result)=>{this.checkedAccount(model,result);this.state.verification?.results.push({model,result});});
          if(categories[0]!==null)successes++;
        }
        this.state.verification!.state=successes > 0 ? 'verified' : 'failed';
      } catch { this.state.verification!.state='failed'; }
      finally { try {this.captureRefresh();}catch{this.state.verification!.state='failed';}this.state.busy=null;this.state.activity=null; }
    })();
    return this.snapshot();
  }
  apply(input: { verificationId: string; expectedVersion: number; config: unknown }) {
    this.available();const config=modelConfigSchema.parse(input.config),v=this.state.verification;
    if(!v || v.state!=='verified' || v.id!==input.verificationId || v.generation!==this.state.generation || JSON.stringify(v.config)!==JSON.stringify(config) || input.expectedVersion!==this.state.configVersion) throw new Error('인증 또는 설정이 변경되었습니다. 다시 검사해주세요.');
    const previous=structuredClone(this.state),oldGeneration=this.appliedGeneration;
    this.state.config=config;this.state.configVersion++;this.state.appliedAt=new Date().toISOString();this.appliedGeneration=this.state.generation;
    try{this.persist();}catch{this.state=previous;this.appliedGeneration=oldGeneration;throw new Error('설정 저장 실패');}
    this.state.verification!.state='applied';
    return this.snapshot();
  }
  async classify(input: unknown) {
    this.available();
    const running = this.classifyAccepted(input);
    this.activeClassification = running;
    try { return await running; }
    finally { if (this.activeClassification === running) this.activeClassification = null; }
  }
  private async classifyAccepted(input: unknown) {
    const {inputs,definitions,authority}=classifyPayloadSchema.parse(input);
    if(!this.canClassify())throw new Error('AI 연결 후 모델 검사·적용이 필요합니다.');
    this.state.busy='classification';const config=this.state.config;let unknown = false;
    try {
      const native = await publicationClassificationPath() === 'native';
      if (native && !authority) throw new ModelCapacityDeferredError('owner_unavailable');
      const run = native ? this.nativeClassificationRun({ inputs, definitions }, authority!) : this.routeRun;
      const result=await classifyCategories(inputs,run,[config.primary,...(config.fallback?[config.fallback]:[])].map(m=>({...m,timeoutMs:35_000})),(model,result)=>{
        this.checkedAccount(model,result);this.state.lastAttempt={model,result,at:new Date().toISOString(),generation:this.state.generation,configVersion:this.state.configVersion};
      },definitions);
      this.state.lastUsedVersion=this.state.configVersion;
      return { categories: result, configVersion:this.state.configVersion, generation:this.state.generation };
    } catch (error) { unknown = error instanceof CliPhysicalEndUnknownError; throw error; }
    finally {
      if (unknown) this.state.busy = 'classification_unknown';
      else try {this.captureRefresh();}finally{this.state.busy=null;this.state.activity=null;}
    }
  }
  /** Stop admission synchronously; an admitted native promise returns only after its terminal reconciliation. */
  drain(): Promise<void> {
    this.shuttingDown = true;
    if (this.activeClassification) return this.activeClassification.then(() => {});
    if (this.state.busy === 'classification_unknown') return Promise.reject(new CliPhysicalEndUnknownError());
    return Promise.resolve();
  }
  close() {this.stopLogin();rmSync(this.home,{recursive:true,force:true});}
}
