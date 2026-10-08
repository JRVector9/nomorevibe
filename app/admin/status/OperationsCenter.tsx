'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { JOB_CATALOG } from '@/lib/jobs/catalog';
import { JOB_LABELS, ROLE_LABELS, type AgentStatus } from '@/lib/operations/contracts';
import type { operationsData } from '@/lib/operations/admin';
import type { manualCandidates } from '@/lib/operations/categories';
import { requestOperation } from './actions';
import { AiConnection } from './AiConnection';
import { ManualClassification } from './ManualClassification';
import './operations.css';
import './dashboard/dashboard.css';
import { OperationsDialog } from './OperationsDialog';
import { JobTimeline } from './JobTimeline';
import { JobsStrip } from './dashboard/JobsStrip';
import { LiveRefresh } from './LiveRefresh';
import { staleServiceInstanceCount } from '@/lib/operations/instance';
export type OperationJob = { name:string; status:string; lastRunAt:string|null; lastSuccessAt:string|null; nextScheduledAt:string|null; notBefore:string|null; workerSeenAt:string|null; requestedVersion:number; processedVersion:number; runs:number; lastError:string|null; cursor:string };
const time=(value:unknown)=>typeof value==='string'||typeof value==='number'?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'기록 없음';
/** 관측 시각 기준 경과 — 숫자 표에서 한 칸에 들어가게 짧게 */
const ago=(value:unknown,now:string)=>{if(typeof value!=='string'&&typeof value!=='number')return '—';const s=Math.round((new Date(now).getTime()-new Date(value).getTime())/1000);return s<0?'방금':s<90?`${s}초`:s<5400?`${Math.round(s/60)}분`:s<172800?`${Math.round(s/3600)}시간`:`${Math.round(s/86400)}일`;};
const until=(value:unknown,now:string)=>{if(typeof value!=='string')return '—';const s=Math.round((new Date(value).getTime()-new Date(now).getTime())/1000);return s<=0?'지금':s<90?`${s}초`:s<5400?`${Math.round(s/60)}분`:`${Math.round(s/3600)}시간`;};
const ROLES=['app','scheduler','crawler','reviewer','publisher','text','maintenance','db','connect-agent'];
const DESCRIPTIONS:Record<string,string>={app:'제품 페이지·관리자·API 요청을 처리합니다.',scheduler:'예약 시각을 확인하고 담당 워커에게 작업을 요청합니다.',crawler:'프로젝트 원본·공개 근거를 수집합니다.',reviewer:'규칙 판정과 설정된 AI 심사로 후보를 검토합니다.',publisher:'승인 후보를 분류하고 최종 발행 조건을 검사합니다.',text:'소개 생성과 심사 사유 번역을 처리합니다.',maintenance:'발행된 제품이 열리는지 확인하고, 유효 방문을 집계해 랭킹을 갱신합니다.',db:'제품·후보·작업 요청과 실행 결과를 저장합니다.','connect-agent':'Codex·Claude 인증과 모델 검증·분류 실행을 전담합니다.'};
/**
 * 전체 현황 탭은 서버가 그린 조각(attention·dashboard·statusChips·queue·searchHealth)을 12칸 격자에 놓는다.
 * 숫자를 모으는 쿼리는 page.tsx 에, 상호작용(탭·상세 창·작업 요청)은 여기에 둔다.
 * 조치할 일(attention)은 전체 현황 맨 위 전체 폭 — 전에는 KPI·파이프라인 아래(1440×900 에서 768px)라 첫 화면 밖이었다.
 * initialJob(?job=)이 오면 그 작업의 상세 창을 연 채로 시작한다 — 조치할 일의 작업 링크가 쓴다.
 */
export function OperationsCenter({initialTab="overview",initialJob=null,jobs,data,candidates,reviewMode,enabled,attention,dashboard,statusChips,queue,searchHealth,children }:{initialTab?: "overview" | "jobs" | "ai" | "manual";initialJob?:string|null;jobs:OperationJob[];data:Awaited<ReturnType<typeof operationsData>>;candidates:Awaited<ReturnType<typeof manualCandidates>>;reviewMode:string;enabled:boolean;attention:React.ReactNode;dashboard:React.ReactNode;statusChips:React.ReactNode;queue:React.ReactNode;searchHealth:React.ReactNode;children:React.ReactNode}) {
  const [tab,setTab]=useState<string>(initialTab),[selected,setSelected]=useState('publisher'),[selectedJob,setJob]=useState<OperationJob|null>(()=>jobs.find(j=>j.name===initialJob)??null),[worker,setWorker]=useState(false),[message,setMessage]=useState(''),[pending,start]=useTransition();
  const job=jobs.find(j=>j.name===selectedJob?.name)??null;
  const router=useRouter();const snapshots=new Map(data.observations.map(o=>[o.key,o]));
  const instancesFor=(key:string)=>data.serviceInstances.filter(instance=>instance.role===key).sort((a,b)=>new Date(b.observedAt).getTime()-new Date(a.observedAt).getTime());
  const latestFor=(key:string)=>instancesFor(key)[0];
  /** 지난 배포·예비의 키는 지워지지 않는다 — 1시간 넘게 관측이 없는 인스턴스는 지금 도는 것이 아니다(9개 옛 스케줄러 키가 늘 "일부 지연"을 냈다) */
  const liveFor=(key:string)=>instancesFor(key).filter(instance=>new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()<=3_600_000);
  const agent=latestFor('connect-agent')?.value as AgentStatus|undefined;
  const observation=latestFor(selected),owned=jobs.filter(j=>JOB_CATALOG.find(c=>c.name===j.name)?.role===selected),runtime=observation?.value;
  function status(key:string){
    if(key==='db')return '조회 성공';
    const instances=liveFor(key),seen=instances[0];if(!seen)return instancesFor(key).length?'관측 지연':'관측 없음';
    const stale=staleServiceInstanceCount(instances,new Date(data.fetchedAt).getTime());
    if(stale===instances.length)return '관측 지연';if(stale>0)return `일부 관측 지연 · ${stale}개`;
    return key==='connect-agent'?(agent?.busy?'작업 중':'응답 관측'):seen.value.status==='running'?'실행 관측':String(seen.value.status??'확인 필요');
  }
  function request(name:string){start(async()=>{const result=await requestOperation(name);setMessage(result.error??result.message??'');router.refresh();});}
  return <div className="ops-center">
    <header className="ops-header compact"><div><h1>운영센터</h1><span className="ops-snapshot-inline">{time(data.fetchedAt)} KST · 수집 {enabled?'켜짐':'꺼짐'} · 워커 관측 15초 · 화면 10초</span></div><div className="ops-actions"><LiveRefresh/><button disabled={pending} onClick={()=>start(()=>router.refresh())}>새로고침</button><button className="primary" onClick={()=>setTab('ai')}>AI 연결·설정</button></div></header>
    <div className="ops-status-chips">{statusChips}</div>
    {tab!=='ai'&&(!agent?.configReady||agent.lastAttempt?.result&&agent.lastAttempt.result!=='success')&&<div className="ops-alert"><div><strong>AI 연결·분류 상태를 확인해주세요</strong><p>분류 실패 후보는 보류됩니다. 계정을 연결하거나 수동으로 카테고리를 지정할 수 있습니다.</p></div><button onClick={()=>setTab('ai')}>연결 상태 확인 →</button></div>}
    <nav className="ops-tabs" aria-label="운영센터 화면">{[['overview','전체 현황'],['jobs','작업 흐름'],['ai','AI 연결'],['manual','수동 분류']].map(([key,label])=><button key={key} aria-current={tab===key?'page':undefined} onClick={()=>setTab(key)}>{label}{key==='manual'&&data.held>0&&<span>{data.held}</span>}</button>)}</nav>
    {message&&<p className="ops-message" role="status">{message}</p>}
    {tab==='overview'&&<div className="ops-console">
      <div className="dash">
        {attention}
        {dashboard}
        <JobsStrip jobs={jobs} now={data.fetchedAt} onOpen={setJob}/>
      </div>
      <div className="ops-console-main">{queue}</div>
      <details className="ops-panel ops-console-full"><summary>수집·근거·랭킹 상세 지표</summary>
        {searchHealth}
        <div className="mt-3 grid gap-3 xl:grid-cols-2">
          <section className="ops-mini"><h3>서비스 관측 <small>{ROLES.filter(key=>!/없음|지연|필요|failed/.test(status(key))).length}/{ROLES.length} 정상</small></h3>
            <table><tbody>{ROLES.map(key=>{const warn=/없음|지연|필요|failed/.test(status(key));return <tr key={key} onClick={()=>{setSelected(key);setWorker(true);}} title={DESCRIPTIONS[key]}>
              <td><i className={`ops-dot ${warn?'warn':'ok'}`}/>{ROLE_LABELS[key]}</td><td className="n">{key==='db'?`${data.dbLatencyMs}ms`:`${liveFor(key).length}대`}</td><td className="n">{key==='db'?'조회':ago(latestFor(key)?.observedAt,data.fetchedAt)}</td></tr>;})}</tbody></table></section>
          <section className="ops-mini"><h3>작업 <small>마지막 · 다음</small></h3>
            <table><tbody>{jobs.filter(j=>j.name!=='heartbeat').map(j=><tr key={j.name} onClick={()=>setJob(j)} title={j.name}>
              <td><i className={`ops-dot ${j.lastError?'bad':'ok'}`}/>{JOB_LABELS[j.name]??j.name}</td><td className="n">{ago(j.lastRunAt,data.fetchedAt)}</td><td className="n">{until(j.nextScheduledAt,data.fetchedAt)}</td></tr>)}</tbody></table></section>
          <section className="ops-mini"><h3>최근 관리자 작업 <Link href="/admin/activity" prefetch={false}>전체 기록 →</Link></h3>{data.audit.length?<ul>{data.audit.slice(0,8).map(a=><li key={a.id}><b>{a.action}</b> {a.target}<small>{a.actor} · {ago(a.createdAt,data.fetchedAt)}</small></li>)}</ul>:<p>기록 없음</p>}</section>
        </div>
        {children}
      </details>
    </div>}
    {tab==='jobs'&&<JobTimeline jobs={jobs.filter(j=>j.name!=='heartbeat')} onOpen={setJob}/>}
    {tab==='ai'&&<AiConnection initial={agent??null} reviewMode={reviewMode}/>}
    {tab==='manual'&&<ManualClassification candidates={candidates}/>}
    {worker&&<OperationsDialog labelledBy="worker-title" onClose={()=>setWorker(false)}><div className="ops-worker-detail"><div className="ops-row"><div><div className="ops-eyebrow">WORKER DETAIL</div><h2 id="worker-title">{ROLE_LABELS[selected]}</h2><code>{selected}</code></div><span className="ops-badge">{status(selected)}</span><button onClick={()=>setWorker(false)}>닫기</button></div><p>{DESCRIPTIONS[selected]}</p>{selected!=='db'&&<div><h3>인스턴스별 관측</h3>{instancesFor(selected).length?instancesFor(selected).map(instance=><div className="ops-job-item" key={instance.key}><div><strong>{instance.instanceId}</strong><code>{instance.key}</code><small>{time(instance.observedAt)} · {String(instance.value.release??'릴리스 미확인')} · RSS {typeof (instance.value.supervisorRssBytes??instance.value.rssBytes)==='number'?`${Math.round(Number(instance.value.supervisorRssBytes??instance.value.rssBytes)/1024/1024)}MB`:'미확인'}</small></div><span className={`ops-badge ${new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()>45_000?'warn':'ok'}`}>{new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()>45_000?'관측 지연':'정상 관측'}</span></div>):<div className="ops-note">관측된 인스턴스가 없습니다.</div>}</div>}<div className="ops-detail-grid"><div><h3>담당 작업과 실행 조건</h3>{owned.length?owned.map(j=><div className="ops-job-item" key={j.name}><div><strong>{JOB_LABELS[j.name]}</strong><code>{j.name}</code><small>{j.status} · 다음 예약 {time(j.nextScheduledAt)}</small>{snapshots.get(`job:${j.name}`)&&<small>최근 회차 {Number(snapshots.get(`job:${j.name}`)!.value.durationMs)/1000}초 · {time(snapshots.get(`job:${j.name}`)!.observedAt)}</small>}</div><button onClick={()=>setJob(j)}>상세</button></div>):<div className="ops-note">예약 잡을 소비하지 않는 서비스입니다.</div>}</div><div><h3>최근 인스턴스 상태</h3><dl className="ops-facts"><div><dt>현재 작업</dt><dd>{typeof runtime?.currentJob==='string'?JOB_LABELS[runtime.currentJob]??runtime.currentJob:'관측된 실행 작업 없음'}</dd></div><div><dt>작업 시작</dt><dd>{time(runtime?.jobStartedAt)}</dd></div><div><dt>마지막 진행</dt><dd>{time(runtime?.lastProgressAt)}</dd></div><div><dt>프로세스 시작</dt><dd>{time(runtime?.bootedAt)}</dd></div><div><dt>감시 프로세스 RSS</dt><dd>{typeof (runtime?.supervisorRssBytes??runtime?.rssBytes)==='number'?`${Math.round(Number(runtime?.supervisorRssBytes??runtime?.rssBytes)/1024/1024)}MB`:'관측 없음'}</dd></div><div><dt>릴리스</dt><dd>{String(runtime?.release??'관측 없음')}</dd></div></dl><div className="ops-trace">{selected==='reviewer'?`AI 심사 모드: ${reviewMode}. 회차 성공은 모델 호출 성공과 별개입니다.`:selected==='publisher'?`AI 분류 실패는 보류합니다. 분류 보류 ${data.held}건.`:'저장된 프로세스 관측입니다. 컨테이너 상태와 전체 후보 처리율을 추정하지 않습니다.'}</div>{selected==='publisher'&&<button onClick={()=>setTab('ai')}>AI 연결·모델 설정 보기 →</button>}</div></div></div></OperationsDialog>}
    {job&&<OperationsDialog labelledBy="job-title" onClose={()=>setJob(null)}><div className="ops-row"><h2 id="job-title">{JOB_LABELS[job.name]}</h2><button onClick={()=>setJob(null)}>닫기</button></div><code>{job.name}</code><dl className="ops-facts">{[['상태',job.status],['요청 / 처리',`${job.requestedVersion} / ${job.processedVersion}`],['마지막 실행',time(job.lastRunAt)],['마지막 성공',time(job.lastSuccessAt)],['다음 예약',time(job.nextScheduledAt)],['재시도 가능',time(job.notBefore)],['누적 실행 회차',job.runs],['마지막 오류',job.lastError??'없음']].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl><details open><summary>최근 회차의 처리 결과</summary><pre>{snapshots.get(`job:${job.name}`)?JSON.stringify(snapshots.get(`job:${job.name}`)!.value,null,2):"수집된 회차 결과 없음"}</pre></details><details><summary>저장된 재개 위치</summary><pre>{job.cursor}</pre></details>{job.name!=='heartbeat'&&<button disabled={pending||job.requestedVersion>job.processedVersion} onClick={()=>request(job.name)}>작업 실행 요청</button>}{message&&<p role="status">{message}</p>}</OperationsDialog>}
  </div>;
}
