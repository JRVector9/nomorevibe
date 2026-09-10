'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { JOB_CATALOG } from '@/lib/jobs/catalog';
import { JOB_LABELS, ROLE_LABELS, type AgentStatus } from '@/lib/operations/contracts';
import type { operationsData } from '@/lib/operations/admin';
import type { manualCandidates } from '@/lib/operations/categories';
import { requestOperation } from './actions';
import { AiConnection } from './AiConnection';
import { ManualClassification } from './ManualClassification';
import './operations.css';
import { OperationsDialog } from './OperationsDialog';
import { JobTimeline } from './JobTimeline';
import { staleServiceInstanceCount } from '@/lib/operations/instance';
export type OperationJob = { name:string; status:string; lastRunAt:string|null; lastSuccessAt:string|null; nextScheduledAt:string|null; notBefore:string|null; workerSeenAt:string|null; requestedVersion:number; processedVersion:number; runs:number; lastError:string|null; cursor:string };
const time=(value:unknown)=>typeof value==='string'||typeof value==='number'?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'기록 없음';
const ROLES=['app','scheduler','crawler','reviewer','publisher','maintenance','db','connect-agent'];
const DESCRIPTIONS:Record<string,string>={app:'제품 페이지·관리자·API 요청을 처리합니다.',scheduler:'예약 시각을 확인하고 담당 워커에게 작업을 요청합니다.',crawler:'프로젝트 원본·공개 근거를 수집합니다.',reviewer:'규칙 판정과 설정된 AI 심사로 후보를 검토합니다.',publisher:'승인 후보를 분류하고 최종 발행 조건을 검사합니다.',maintenance:'발행된 제품이 열리는지 확인하고, 유효 방문을 집계해 랭킹을 갱신합니다.',db:'제품·후보·작업 요청과 실행 결과를 저장합니다.','connect-agent':'Codex·Claude 인증과 모델 검증·분류 실행을 전담합니다.'};
export function OperationsCenter({jobs,data,candidates,reviewMode,enabled,oauthConfigured,localCodexAllowed,actionQueue,pipeline,children}:{jobs:OperationJob[];data:Awaited<ReturnType<typeof operationsData>>;candidates:Awaited<ReturnType<typeof manualCandidates>>;reviewMode:string;enabled:boolean;oauthConfigured:boolean;localCodexAllowed:boolean;actionQueue:React.ReactNode;pipeline:React.ReactNode;children:React.ReactNode}) {
  const [tab,setTab]=useState('overview'),[selected,setSelected]=useState('publisher'),[filter,setFilter]=useState('all'),[selectedJob,setJob]=useState<OperationJob|null>(null),[message,setMessage]=useState(''),[pending,start]=useTransition();
  const job=jobs.find(j=>j.name===selectedJob?.name)??null;
  const router=useRouter();const snapshots=new Map(data.observations.map(o=>[o.key,o]));
  const instancesFor=(key:string)=>data.serviceInstances.filter(instance=>instance.role===key).sort((a,b)=>new Date(b.observedAt).getTime()-new Date(a.observedAt).getTime());
  const latestFor=(key:string)=>instancesFor(key)[0];
  const agent=latestFor('connect-agent')?.value as AgentStatus|undefined;
  const observation=latestFor(selected),owned=jobs.filter(j=>JOB_CATALOG.find(c=>c.name===j.name)?.role===selected),runtime=observation?.value;
  function status(key:string){
    if(key==='db')return '조회 성공';
    const instances=instancesFor(key),seen=instances[0];if(!seen)return '관측 없음';
    const stale=staleServiceInstanceCount(instances,new Date(data.fetchedAt).getTime());
    if(stale===instances.length)return '관측 지연';if(stale>0)return `일부 관측 지연 · ${stale}개`;
    return key==='connect-agent'?(agent?.busy?'작업 중':'응답 관측'):seen.value.status==='running'?'실행 관측':String(seen.value.status??'확인 필요');
  }
  function request(name:string){start(async()=>{const result=await requestOperation(name);setMessage(result.error??result.message??'');router.refresh();});}
  return <div className="ops-center">
    <header className="ops-header"><div><div className="ops-eyebrow">OPERATIONS CENTER</div><h1>운영센터</h1><p>서비스부터 수집·심사·발행까지, 현재 상태와 필요한 조치를 확인하세요.</p></div><div className="ops-actions"><button disabled={pending} onClick={()=>start(()=>router.refresh())}>현황 새로고침</button><button className="primary" onClick={()=>setTab('ai')}>AI 연결·설정</button></div></header>
    <div className="ops-snapshot">조회 시각 {time(data.fetchedAt)} KST · 수집 {enabled?'켜짐':'꺼짐'} · 워커 관측은 15초 간격으로 기록됩니다.</div>
    {tab!=='ai'&&(!agent?.configReady||agent.lastAttempt?.result&&agent.lastAttempt.result!=='success')&&<div className="ops-alert"><div><strong>AI 연결·분류 상태를 확인해주세요</strong><p>분류 실패 후보는 보류됩니다. 계정을 연결하거나 수동으로 카테고리를 지정할 수 있습니다.</p></div><button onClick={()=>setTab('ai')}>연결 상태 확인 →</button></div>}
    <nav className="ops-tabs" aria-label="운영센터 화면">{[['overview','전체 현황'],['jobs','작업 흐름'],['ai','AI 연결'],['manual','수동 분류']].map(([key,label])=><button key={key} aria-current={tab===key?'page':undefined} onClick={()=>setTab(key)}>{label}{key==='manual'&&data.held>0&&<span>{data.held}</span>}</button>)}</nav>
    {message&&<p className="ops-message" role="status">{message}</p>}
    {tab==='overview'&&<>
      {actionQueue}
      {pipeline}
      <div className="ops-row"><h2>서비스 현황</h2><label className="ops-inline-label">표시<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">전체 서비스</option><option value="attention">관측 확인 필요</option><option value="workers">작업 워커</option></select></label></div>
      <div className="ops-services">{ROLES.filter(key=>filter==='all' || (filter==='workers' ? !['app','db','connect-agent'].includes(key) : /없음|지연|필요|failed/.test(status(key)))).map(key=><button key={key} className={`ops-service${selected===key?' selected':''}`} aria-pressed={selected===key} onClick={()=>setSelected(key)}><div className="ops-row"><h3>{ROLE_LABELS[key]}</h3><span className={`ops-badge ${/없음|지연|필요|failed/.test(status(key))?'warn':'ok'}`}>{status(key)}</span></div><code>{key}</code><p>{DESCRIPTIONS[key]}</p><small>{key==='db'?`관리자 DB 조회 ${data.dbLatencyMs}ms`:`${instancesFor(key).length}개 인스턴스 · 최근 관측 ${time(latestFor(key)?.observedAt)}`}</small></button>)}</div>
      <section className="ops-panel ops-worker-detail"><div className="ops-row"><div><div className="ops-eyebrow">WORKER DETAIL</div><h2>{ROLE_LABELS[selected]}</h2><code>{selected}</code></div><span className="ops-badge">{status(selected)}</span></div><p>{DESCRIPTIONS[selected]}</p>{selected!=='db'&&<div><h3>인스턴스별 관측</h3>{instancesFor(selected).length?instancesFor(selected).map(instance=><div className="ops-job-item" key={instance.key}><div><strong>{instance.instanceId}</strong><code>{instance.key}</code><small>{time(instance.observedAt)} · {String(instance.value.release??'릴리스 미확인')} · RSS {typeof (instance.value.supervisorRssBytes??instance.value.rssBytes)==='number'?`${Math.round(Number(instance.value.supervisorRssBytes??instance.value.rssBytes)/1024/1024)}MB`:'미확인'}</small></div><span className={`ops-badge ${new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()>45_000?'warn':'ok'}`}>{new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()>45_000?'관측 지연':'정상 관측'}</span></div>):<div className="ops-note">관측된 인스턴스가 없습니다.</div>}</div>}<div className="ops-detail-grid"><div><h3>담당 작업과 실행 조건</h3>{owned.length?owned.map(j=><div className="ops-job-item" key={j.name}><div><strong>{JOB_LABELS[j.name]}</strong><code>{j.name}</code><small>{j.status} · 다음 예약 {time(j.nextScheduledAt)}</small>{snapshots.get(`job:${j.name}`)&&<small>최근 회차 {Number(snapshots.get(`job:${j.name}`)!.value.durationMs)/1000}초 · {time(snapshots.get(`job:${j.name}`)!.observedAt)}</small>}</div><button onClick={()=>setJob(j)}>상세</button></div>):<div className="ops-note">예약 잡을 소비하지 않는 서비스입니다.</div>}</div><div><h3>최근 인스턴스 상태</h3><dl className="ops-facts"><div><dt>현재 작업</dt><dd>{typeof runtime?.currentJob==='string'?JOB_LABELS[runtime.currentJob]??runtime.currentJob:'관측된 실행 작업 없음'}</dd></div><div><dt>작업 시작</dt><dd>{time(runtime?.jobStartedAt)}</dd></div><div><dt>마지막 진행</dt><dd>{time(runtime?.lastProgressAt)}</dd></div><div><dt>프로세스 시작</dt><dd>{time(runtime?.bootedAt)}</dd></div><div><dt>감시 프로세스 RSS</dt><dd>{typeof (runtime?.supervisorRssBytes??runtime?.rssBytes)==='number'?`${Math.round(Number(runtime?.supervisorRssBytes??runtime?.rssBytes)/1024/1024)}MB`:'관측 없음'}</dd></div><div><dt>릴리스</dt><dd>{String(runtime?.release??'관측 없음')}</dd></div></dl><div className="ops-trace">{selected==='reviewer'?`AI 심사 모드: ${reviewMode}. 회차 성공은 모델 호출 성공과 별개입니다.`:selected==='publisher'?`AI 분류 실패는 보류합니다. 분류 보류 ${data.held}건.`:'저장된 프로세스 관측입니다. 컨테이너 상태와 전체 후보 처리율을 추정하지 않습니다.'}</div>{selected==='publisher'&&<button onClick={()=>setTab('ai')}>AI 연결·모델 설정 보기 →</button>}</div></div></section>
      <section className="ops-panel"><h2>최근 관리자 작업</h2>{data.audit.length?data.audit.map(a=><div className="ops-job-item" key={a.id}><div><strong>{a.action} · {a.target}</strong><small>{a.actor} · {time(a.createdAt)}</small></div></div>):<p>아직 기록된 관리자 작업이 없습니다.</p>}</section>
      <details className="ops-panel"><summary>기존 수집·근거·랭킹 상세 지표</summary>{children}</details>
    </>}
    {tab==='jobs'&&<JobTimeline jobs={jobs.filter(j=>j.name!=='heartbeat')} onOpen={setJob}/>}
    {tab==='ai'&&<AiConnection initial={agent??null} reviewMode={reviewMode} oauthConfigured={oauthConfigured} localCodexAllowed={localCodexAllowed}/>}
    {tab==='manual'&&<ManualClassification candidates={candidates}/>}
    {job&&<OperationsDialog labelledBy="job-title" onClose={()=>setJob(null)}><div className="ops-row"><h2 id="job-title">{JOB_LABELS[job.name]}</h2><button onClick={()=>setJob(null)}>닫기</button></div><code>{job.name}</code><dl className="ops-facts">{[['상태',job.status],['요청 / 처리',`${job.requestedVersion} / ${job.processedVersion}`],['마지막 실행',time(job.lastRunAt)],['마지막 성공',time(job.lastSuccessAt)],['다음 예약',time(job.nextScheduledAt)],['재시도 가능',time(job.notBefore)],['누적 실행 회차',job.runs],['마지막 오류',job.lastError??'없음']].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl><details open><summary>최근 회차의 처리 결과</summary><pre>{snapshots.get(`job:${job.name}`)?JSON.stringify(snapshots.get(`job:${job.name}`)!.value,null,2):"수집된 회차 결과 없음"}</pre></details><details><summary>저장된 재개 위치</summary><pre>{job.cursor}</pre></details>{job.name!=='heartbeat'&&<button disabled={pending||job.requestedVersion>job.processedVersion} onClick={()=>request(job.name)}>작업 실행 요청</button>}{message&&<p role="status">{message}</p>}</OperationsDialog>}
  </div>;
}
