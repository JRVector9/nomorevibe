/* OAuth uses an anchor so prefetch never starts authentication. */
/* eslint-disable @next/next/no-html-link-for-pages */
'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Countdown } from './Countdown';
import { OperationsDialog } from './OperationsDialog';
import { useAgentConnection } from './useAgentConnection';
import { DEFAULT_CONFIG, MODEL_IDS, modelConfigSchema, type AgentStatus, type ModelConfig } from '@/lib/operations/contracts';

type Provider = 'codex'|'claude';
const PROVIDERS: Provider[]=['codex','claude'];
const providerName=(p:Provider)=>p==='codex'?'Codex':'Claude';
const modelName=(m:string)=>m==='sonnet'?'Claude Sonnet':m==='gpt-5.3-codex-spark'?'Codex Spark':'Codex Terra';
const time=(value:string|null|undefined)=>value?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'기록 없음';
const LABELS:Record<string,string>={starting:'인증 페이지 준비 중',awaiting_approval:'공식 페이지 승인 대기',exchanging:'인증 코드 확인 중',stored:'연결 완료',cancelled:'연결 취소됨',expired:'연결 시간 만료',failed:'연결 실패',running:'검사 중',verified:'검사 통과',applied:'설정 적용 완료',success:'정상 응답 확인',auth:'인증 실패 · 재연결 필요',timeout:'응답 시간 초과',access_denied:'이 모델에 접근할 수 없음',rate_limit:'사용 한도 또는 요청 제한',invalid_output:'응답 형식 오류',no_cli:'CLI 실행 불가',error:'요청 실패',cli_error:'CLI 요청 실패',output_too_large:'응답 크기 초과',credential_store_failed:'인증 저장 실패'};
const label=(s:string)=>LABELS[s]??s;
const CONNECTION_ERRORS:Record<string,string>={oauth_rejected:'Claude가 인증 코드를 거절했습니다. 새 연결을 시작한 뒤 공식 페이지에서 받은 최신 코드를 입력해주세요.',exchange_timeout:'코드 확인에 응답이 없습니다. 새 연결을 시작해주세요.',credential_capture_failed:'인증 정보를 저장하지 못했습니다. 새 연결로 다시 시도해주세요.'};

export function AiConnection({initial,reviewMode,oauthConfigured,localCodexAllowed}:{initial:AgentStatus|null;reviewMode:string;oauthConfigured:boolean;localCodexAllowed:boolean}) {
  const {status,pending,transportError,message,checkedAt,refresh,perform}=useAgentConnection(initial);
  const [draft,setDraft]=useState<ModelConfig|null>(null),[dialogProvider,setDialogProvider]=useState<Provider|null>(null);
  const [authCode,setAuthCode]=useState(''),[dialogError,setDialogError]=useState(''),[copied,setCopied]=useState(false);
  const config=draft??(status?.configVersion?status.config:DEFAULT_CONFIG);
  const anyConnected=Boolean(status?.connected||status?.claudeConnected),busy=Boolean(status?.busy);
  const valid=modelConfigSchema.safeParse(config).success;
  const verification=status?.verification;
  const verified=verification?.state==='verified'&&verification.generation===status?.generation&&JSON.stringify(verification.config)===JSON.stringify(config);
  const ready=status?.configReady===true;
  const connection=dialogProvider&&(status?.connection?.provider??'codex')===dialogProvider?status?.connection:null;
  const terminal=Boolean(connection&&['stored','failed','expired','cancelled'].includes(connection.state));
  const activity=status?.activity;
  const countdown=activity&&status?.serverNow?<Countdown key={activity.id} deadlineAt={activity.deadlineAt} serverNow={status.serverNow} label={activity.kind==='model'?`${modelName(activity.model!)} 응답 대기`:activity.kind==='oauth_exchange'?'인증 코드 확인':'계정 연결 유효시간'}/>:null;
  const busyText=status?.busy==='login'?`${providerName(status.connection?.provider??'codex')} 계정 연결이 진행 중입니다. 모델은 미리 선택할 수 있으며, 검사는 연결을 완료하거나 취소한 뒤 실행할 수 있습니다.`:status?.busy==='verification'?'선택한 모델에 샘플 분류를 요청하고 있습니다. 모델당 최대 35초가 걸립니다.':status?.busy==='account_check'?'저장된 계정으로 모델 응답을 확인하고 있습니다. 최대 35초가 걸립니다.':status?.busy==='classification'?'퍼블리셔가 분류 중입니다. 완료 후 연결·검사를 진행할 수 있습니다.':'';
  function update(which:'primary'|'fallback',key:'model'|'effort',value:string) {
    setDraft({...config,[which]:key==='model'&&value==='none'?null:{...(config[which]??{model:'sonnet',effort:'high'}),[key]:value,...(key==='model'&&value==='sonnet'?{effort:'high'}:{})}} as ModelConfig);
  }
  async function connect(p:Provider) {
    setDialogProvider(p);setDialogError('');setAuthCode('');setCopied(false);
    if(status?.busy==='login'&&(status.connection?.provider??'codex')===p){await refresh();return;}
    const result=await perform('connect',{provider:p});if(result.error)setDialogError(result.error);
  }
  async function cancel() {
    if(!status?.connection)return;
    const result=await perform('cancel',{id:status.connection.id});if(result.error)setDialogError(result.error);
  }
  async function submitCode(e:React.FormEvent) {
    e.preventDefault();setDialogError('');
    const result=await perform('input',{id:connection?.id,code:authCode.trim()});
    if(result.error)setDialogError(result.error);else setAuthCode('');
  }
  return <div className="ops-ai">
    <div className="ai-heading ops-row"><div><h2>AI 연결과 분류 설정</h2><p>계정 연결, 모델 응답, 퍼블리셔 적용 상태를 각각 확인합니다.</p></div><div className="ai-refresh"><button disabled={pending} onClick={()=>void refresh()}>상태 새로고침</button><span>{checkedAt?`${time(checkedAt)} 확인 · 자동 갱신`:'서버 상태 확인 중'}</span></div></div>
    {transportError&&<div className="ai-notice error" role="alert"><strong>최신 연결 상태를 확인할 수 없습니다.</strong><p>{transportError}</p><p>아래에는 마지막으로 확인한 상태를 표시합니다.</p></div>}
    <div className={`ai-readiness ${ready?'ready':''}`}><strong>{ready?'퍼블리셔 모델 설정 적용됨':'퍼블리셔 모델 설정 적용 전'}</strong><span>{ready?`${modelName(status!.config.primary.model)}${status!.config.fallback?` → ${modelName(status!.config.fallback.model)}`:''} · 다음 분류 배치에서 사용` : anyConnected?'저장된 계정이 있습니다. 아래에서 모델을 선택하고 검사·적용해주세요.':'계정을 연결한 뒤 모델을 검사·적용해주세요.'}</span></div>
    <section className="ops-panel ai-accounts" aria-labelledby="ai-accounts-title">
      <div className="ops-row"><h3 id="ai-accounts-title">계정 연결</h3><span className="ai-caption">인증 저장과 실제 모델 응답은 별도입니다.</span></div>
      {PROVIDERS.map(p=>{
        const stored=Boolean(p==='codex'?status?.connected:status?.claudeConnected),account=status?.accounts?.[p];
        const connecting=status?.busy==='login'&&(status.connection?.provider??'codex')===p;
        const latest=(status?.connection?.provider??'codex')===p?status?.connection:null;
        return <article className="ai-provider-row" key={p} aria-label={`${providerName(p)} 계정`}>
          <div className="ai-provider-name"><h4>{providerName(p)}</h4><span className={`ops-badge ${stored?'ok':'warn'}`}>{stored?'인증 저장 완료':status?'연결 안 됨':'확인 중'}</span></div>
          <div className="ai-provider-status"><strong>{connecting?label(status!.connection!.state):account?.result?label(account.result):stored?'연결 저장됨 · 모델 응답 미검사':'사용할 계정을 연결해주세요'}</strong>
            <p>{account?.checkedAt?`${modelName(account.model!)} · ${time(account.checkedAt)} 검사`:account?.storedAt?`${time(account.storedAt)} 인증 저장`:stored?'서버의 암호화 저장소에서 인증을 확인했습니다.':'공식 인증 페이지에서 직접 승인합니다.'}</p>
            {p==='claude'&&account?.probe&&<div className="ai-probe-reply" aria-live="polite"><span>연결 확인 · {time(account.probe.checkedAt)}</span><p><b>보낸 메시지</b> <span>{account.probe.prompt}</span></p>{account.probe.result==='success'&&account.probe.reply?<p><b>Claude 답변</b> <span>{account.probe.reply}</span></p>:<p className="ai-warning">답변을 받지 못했습니다: {label(account.probe.result)}</p>}</div>}
            {!connecting&&latest&&['expired','failed'].includes(latest.state)&&<p className="ai-warning">최근 연결 시도: {label(latest.state)}{stored?' · 기존 인증은 보존됨':''}</p>}
          </div>
          <div className="ops-actions"><button disabled={!stored||pending||busy} onClick={()=>void perform('probe',{provider:p})}>{providerName(p)} 연결 확인</button><button disabled={pending||busy&&!connecting} onClick={()=>void connect(p)}>{providerName(p)} {connecting?'연결 계속':stored?'재연결':'연결'}</button></div>
        </article>;
      })}
      {busyText&&<div className="ai-notice"><p role="status">{busyText}</p>{countdown}{status?.busy==='login'&&<button disabled={pending} onClick={()=>void cancel()}>진행 중인 연결 취소</button>}</div>}
      <p className="ai-caption">Claude 연결 확인은 저장된 인증으로 hi~를 보내고 실제 답변을 표시합니다. 분류 설정 적용에는 아래의 선택 모델 검사가 필요합니다.</p>
      {!localCodexAllowed&&<p className="ai-caption">{oauthConfigured?<a href="/api/auth/github">GitHub 관리자 계정으로 로그인</a>:'서버의 관리자 GitHub OAuth 설정이 필요합니다.'}</p>}
    </section>
    <section className="ops-panel ai-model-panel" aria-labelledby="ai-model-title">
      <div className="ops-row"><div><h3 id="ai-model-title">분류 모델 선택</h3><p>우선 모델이 실패하면 예비 모델로 다시 시도합니다.</p></div><button disabled={pending} onClick={()=>setDraft(DEFAULT_CONFIG)}>Spark → Claude 선택</button></div>
      <div className="ai-model-fields">{(['primary','fallback'] as const).map(which=><fieldset key={which} disabled={pending}><legend>{which==='primary'?'우선 모델':'예비 모델'}</legend><label>{which==='primary'?'우선':'예비'} 모델<select value={config[which]?.model??'none'} onChange={e=>update(which,'model',e.target.value)}>{which==='fallback'&&<option value="none">사용하지 않음</option>}{MODEL_IDS.map(id=><option value={id} key={id}>{modelName(id)} · {id}</option>)}</select></label><label>{which==='primary'?'우선':'예비'} 추론 강도<select disabled={!config[which]} value={config[which]?.effort??'high'} onChange={e=>update(which,'effort',e.target.value)}><option value="high">High</option>{config[which]?.model!=='sonnet'&&<option value="xhigh">XHigh</option>}</select></label><p>{config[which]?.model==='sonnet'&&!status?.claudeConnected?'Claude 계정 연결이 필요합니다.':config[which]&&config[which]?.model!=='sonnet'&&!status?.connected?'Codex 계정 연결이 필요합니다.':which==='fallback'?'두 모델 모두 실패하면 발행을 보류합니다.':'제품 설명을 기준으로 카테고리를 분류합니다.'}</p></fieldset>)}</div>
      {!valid&&<p className="ai-warning" role="alert">우선 모델과 예비 모델을 다르게 선택해주세요.</p>}
      <div className="ai-model-footer"><div><strong>{verification?.state==='running'?'모델 검사 중':verified?'검사 통과 · 적용할 수 있습니다.':ready&&JSON.stringify(config)===JSON.stringify(status?.config)?'현재 적용된 모델 설정입니다.':'선택한 모델의 검사가 필요합니다.'}</strong><p>{!anyConnected?'계정을 연결하면 검사를 시작할 수 있습니다.':busy?'진행 중인 AI 작업이 끝나면 검사·적용할 수 있습니다.':'한 모델 이상 정상 응답해야 적용됩니다. 모델을 바꾸면 다시 검사해주세요.'}</p></div><div className="ops-actions"><button disabled={!anyConnected||pending||busy||!valid} onClick={()=>void perform('test',{config})}>선택 모델 검사</button><button className="primary" disabled={!verified||pending||busy} onClick={()=>void perform('apply',{config,verificationId:verification?.id,expectedVersion:status?.configVersion}).then(r=>{if(!r.error)setDraft(null);})}>설정 적용</button></div></div>
      {verification&&<div className="ai-results" aria-live="polite"><h4>최근 모델 검사 · {label(verification.state)}</h4>{verification.results.length?verification.results.map((r,i)=><div key={i}><span>{modelName(r.model)}</span><strong className={r.result==='success'?'ai-success':'ai-warning'}>{label(r.result)}</strong></div>):<p>첫 번째 모델의 응답을 기다리고 있습니다.</p>}</div>}
      {message&&<p className="ai-notice" role="status">{message}</p>}
    </section>
    <section className="ops-panel ai-applied" aria-labelledby="ai-applied-title"><h3 id="ai-applied-title">현재 적용 및 실행 기록</h3><dl><div><dt>저장된 모델 설정</dt><dd>{status?.configVersion?`${modelName(status.config.primary.model)}${status.config.fallback?` → ${modelName(status.config.fallback.model)}`:''}`:'아직 적용하지 않았습니다.'}</dd></div><div><dt>설정 적용 시각</dt><dd>{time(status?.appliedAt)}</dd></div><div><dt>최근 분류 결과</dt><dd>{status?.lastAttempt?`${modelName(status.lastAttempt.model)} · ${label(status.lastAttempt.result)} · ${time(status.lastAttempt.at)}`:'실제 분류 시도 기록이 없습니다.'}</dd></div></dl><details><summary>운영 상세 정보</summary><p>설정 버전 {status?.configVersion??0} · 최근 사용 버전 {status?.lastUsedVersion??'없음'} · 인증 세대 {status?.generation??0}</p><p>후보 AI 심사는 별도 워커입니다. 현재 심사 모드: {reviewMode}.</p><Link href="/admin/review">후보 심사 큐 보기 →</Link></details></section>
    {dialogProvider&&<OperationsDialog labelledBy="connect-title" onClose={()=>setDialogProvider(null)}>
      <div className="ai-connect-dialog"><div className="ops-row"><h2 id="connect-title">{providerName(dialogProvider)} 계정 연결</h2><button onClick={()=>setDialogProvider(null)}>닫기</button></div>
      <p className="ai-dialog-state" role="status">{pending&&!connection?'연결 요청 중':connection?label(connection.state):'연결 상태를 확인하고 있습니다.'}</p>
      {!terminal&&countdown}
      {transportError&&<p className="ai-notice error" role="alert">{transportError}</p>}
      {dialogError&&<p className="ai-notice error" role="alert">{dialogError}</p>}
      {connection?.state==='stored'?<><p>인증을 저장했습니다. 이제 모델 응답을 검사하고 퍼블리셔에 적용할 수 있습니다.</p><button className="primary" onClick={()=>setDialogProvider(null)}>모델 설정으로 이동</button></>:terminal?<><p>{connection?.error?CONNECTION_ERRORS[connection.error]??'연결을 완료하지 못했습니다. 다시 시도해주세요.':connection?.state==='expired'?'10분 내에 인증이 완료되지 않았습니다. 새 코드로 다시 연결해주세요.':'이 연결은 종료되었습니다. 다시 연결할 수 있습니다.'}</p><button disabled={pending||busy} onClick={()=>void connect(dialogProvider)}>새 연결 시작</button></>:<>
        <ol className="ai-connect-steps"><li><strong>공식 페이지에서 계정을 승인하세요.</strong><p>{dialogProvider==='codex'?'아래 코드를 공식 페이지에 입력합니다.':'승인 후 표시되는 인증 코드를 복사합니다.'}</p>{connection?.url&&<a className="ops-button primary" href={connection.url} target="_blank" rel="noreferrer noopener">공식 인증 페이지 열기 ↗</a>}{dialogProvider==='codex'&&connection?.code&&<div className="ai-device"><strong className="ops-device-code">{connection.code}</strong><button onClick={()=>void navigator.clipboard.writeText(connection.code!).then(()=>setCopied(true)).catch(()=>setDialogError('복사할 수 없습니다. 코드를 직접 선택해 복사해주세요.'))}>{copied?'복사됨':'코드 복사'}</button></div>}</li>
        <li><strong>{dialogProvider==='claude'?'인증 코드를 붙여넣고 연결을 완료하세요.':'이 화면에서 연결 완료를 확인하세요.'}</strong>{dialogProvider==='claude'&&connection?.inputRequired?<form onSubmit={e=>void submitCode(e)}><label>Claude 인증 코드<input type="password" autoComplete="off" placeholder="공식 페이지에서 받은 코드" value={authCode} onChange={e=>setAuthCode(e.target.value)} maxLength={2048}/></label><button className="primary" disabled={pending||!authCode.trim()}>인증 코드 확인</button></form>:<p>{connection?.state==='exchanging'?'코드를 전달했습니다. 최대 45초 내에 결과를 표시합니다.':'서버에서 결과를 자동 확인합니다. 이 창을 닫아도 연결은 계속 진행됩니다.'}</p>}</li></ol>
      </>}
      <div className="ai-dialog-footer">{connection&&status?.busy==='login'&&<button disabled={pending} onClick={()=>void cancel()}>연결 취소</button>}<button disabled={pending} onClick={()=>void refresh()}>지금 상태 확인</button></div>
      </div>
    </OperationsDialog>}
  </div>;
}
