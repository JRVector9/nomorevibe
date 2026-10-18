'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { JOB_CATALOG } from '@/lib/jobs/catalog';
import { JOB_LABELS, ROLE_LABELS, type AgentStatus } from '@/lib/operations/contracts';
import type { operationsData } from '@/lib/operations/admin';
import { staleServiceInstanceCount, supersededServiceInstanceKeys } from '@/lib/operations/instance';
import type { SplitServiceRoleRow } from '@/lib/operations/split-service-roles';
import { formatAgo, formatDetailTime } from '@/lib/format/time';
import { StatusDot } from '../components/StatusDot';
import { ACTION_LABELS } from '../activity/labels';
import { requestOperation } from './actions';
import { AiConnection } from './AiConnection';
import './operations.css';
import './dashboard/dashboard.css';
import { OperationsDialog } from './OperationsDialog';
import { JobTimeline } from './JobTimeline';
import { JobsStrip } from './dashboard/JobsStrip';
import { LiveRefresh } from './LiveRefresh';
import { CollectionSwitch } from './CollectionSwitch';
import { PAUSED_AFTER_MS } from '@/lib/jobs/status';
import { STATUS_TABS, type StatusTab } from './action-links';
export type OperationJob = { name:string; status:string; lastRunAt:string|null; lastSuccessAt:string|null; nextScheduledAt:string|null; notBefore:string|null; workerSeenAt:string|null; requestedVersion:number; processedVersion:number; runs:number; lastError:string|null; cursor:string };
const ROLES=['app','scheduler','crawler','reviewer','publisher','text','maintenance','db','connect-agent'];
const DESCRIPTIONS:Record<string,string>={app:'제품 페이지·관리자·API 요청을 처리합니다.',scheduler:'예약 시각을 확인하고 담당 워커에게 작업을 요청합니다.',crawler:'프로젝트 원본·공개 근거를 수집합니다.',reviewer:'규칙 판정과 설정된 AI 심사로 후보를 검토합니다.',publisher:'승인 후보를 분류하고 최종 발행 조건을 검사합니다.',text:'소개 생성과 심사 사유 번역을 처리합니다.',maintenance:'발행된 제품이 열리는지 확인하고, 유효 방문을 집계해 랭킹을 갱신합니다.',db:'제품·후보·작업 요청과 실행 결과를 저장합니다.','connect-agent':'Codex·Claude 인증과 모델 검증·분류 실행을 전담합니다.',
  // 분리 역할(batch versioned 에서만 따로 돈다) — 기존 방식에서는 같은 잡을 원래 역할이 맡는다
  translation:'사유 번역·한국어 소개·제품 번역(reason-translate·product-tagline-ko·product-translate)을 따로 맡습니다. 작업 배치가 versioned 일 때만 돕니다.',
  'product-health':'공개 제품이 열리는지 응답을 점검합니다(uptime-ping). 작업 배치가 versioned 일 때만 돕니다.',
  'site-evidence':'공식 사이트 근거를 수집합니다(product-site-evidence-refresh). 작업 배치가 versioned 일 때만 돕니다.',
  'official-news':'AI 소식을 수집합니다(news-refresh). 작업 배치가 versioned 일 때만 돕니다.'};
/** 분리 역할이 기존 방식(legacy·draining)이라 일하지 않을 때의 상태 — 경보가 아니다 */
const SPLIT_IDLE='대기 · 기존 방식(legacy)';
const TAB_LABELS:Record<StatusTab,string>={overview:'전체 현황',jobs:'작업 흐름',crawlers:'크롤러 활동',ai:'AI 연결',manual:'수동 분류',diagnostics:'진단'};
/** 머리의 "마지막 갱신 13:38:20" — 서버가 읽은 시각(KST)의 시:분:초 */
const clock=(value:string)=>formatDetailTime(value).split(' ')[1]??'—';
/**
 * 전체 현황 탭은 서버가 그린 조각(attention·dashboard·statusChips·diagnostics·manual)을 12칸 격자에 놓는다.
 * 숫자를 모으는 쿼리는 page.tsx 에, 상호작용(탭·상세 창·작업 요청)은 여기에 둔다.
 *
 * 탭과 열어 둔 상세(작업·워커)는 주소에 있다 — ?tab=jobs&job=crawl-fetch, ?worker=publisher(2026-10-08 UX 감사 ADM-29).
 * 전에는 처음 열 때만 ?tab= 을 읽고 그 뒤는 화면 상태라 뒤로 가기·새로고침·링크 공유에서 사라졌다.
 * 바꿀 때는 history.replaceState 로 주소만 바꾼다 — Next 가 useSearchParams 와 맞춰 주고(공식 문서 "Native History API"),
 * router.replace 와 달리 force-dynamic 인 이 페이지의 서버 조회 전체를 탭 하나 누를 때마다 다시 돌리지 않는다.
 */
export function OperationsCenter({jobs,data,reviewMode,enabled,attention,dashboard,statusChips,diagnostics,manual,crawlers,splitRoles=[]}:{jobs:OperationJob[];data:Awaited<ReturnType<typeof operationsData>>;reviewMode:string;enabled:boolean;attention:React.ReactNode;dashboard:React.ReactNode;statusChips:React.ReactNode;diagnostics:React.ReactNode;manual:React.ReactNode;crawlers:React.ReactNode;
  /** 서비스 관측 표 끝에 더하는 분리 역할 행(lib/operations/split-service-roles.ts) — versioned 이거나 후보가 있을 때만 온다 */
  splitRoles?:SplitServiceRoleRow[]}) {
  const params=useSearchParams();
  const tabParam=params.get('tab');
  const tab:StatusTab=(STATUS_TABS as readonly (string|null)[]).includes(tabParam)?tabParam as StatusTab:'overview';
  const job=jobs.find(j=>j.name===params.get('job'))??null;
  const roles=[...ROLES,...splitRoles.map(row=>row.role)];
  const selected=roles.find(key=>key===params.get('worker'))??null;
  const [message,setMessage]=useState(''),[pending,start]=useTransition(),[phoneFull,setPhoneFull]=useState(false);
  const router=useRouter();const snapshots=new Map(data.observations.map(o=>[o.key,o]));
  /** 주소의 탭·상세만 바꾼다. 전체 현황은 기본이라 ?tab= 을 뺀다 */
  function show(patch:Partial<Record<'tab'|'job'|'worker',string|null>>){
    const next=new URLSearchParams(params.toString());
    for(const [key,value] of Object.entries(patch))if(value)next.set(key,value);else next.delete(key);
    if(next.get('tab')==='overview')next.delete('tab');
    const query=next.toString();
    window.history.replaceState(null,'',query?`?${query}`:window.location.pathname);
  }
  const openJob=(j:OperationJob)=>show({job:j.name});
  const instancesFor=(key:string)=>data.serviceInstances.filter(instance=>instance.role===key).sort((a,b)=>new Date(b.observedAt).getTime()-new Date(a.observedAt).getTime());
  const latestFor=(key:string)=>instancesFor(key)[0];
  /** 지난 배포·예비의 키는 지워지지 않는다 — 1시간 넘게 관측이 없는 인스턴스는 지금 도는 것이 아니다(9개 옛 스케줄러 키가 늘 "일부 지연"을 냈다) */
  const liveFor=(key:string)=>instancesFor(key).filter(instance=>new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()<=3_600_000);
  /** 새 boot·새 릴리스가 이어받은 옛 인스턴스는 지연으로 세지 않는다 — 살아 있어야 할 자리가 모자라면 그만큼은 남긴다 */
  const superseded=supersededServiceInstanceKeys(data.serviceInstances,new Date(data.fetchedAt).getTime());
  const split=(key:string)=>splitRoles.find(row=>row.role===key);
  const agent=latestFor('connect-agent')?.value as AgentStatus|undefined;
  const observation=selected?latestFor(selected):undefined,runtime=observation?.value;
  const owned=jobs.filter(j=>selected&&split(selected)?split(selected)!.jobs.includes(j.name):JOB_CATALOG.find(c=>c.name===j.name)?.role===selected);
  function status(key:string){
    if(key==='db')return '조회 성공';
    const instances=liveFor(key).filter(instance=>!superseded.has(instance.key)),seen=instances[0];
    const idle=split(key)?.alarms===false;
    if(!seen)return idle?SPLIT_IDLE:instancesFor(key).length?'관측 지연':'관측 없음';
    const stale=staleServiceInstanceCount(instances,new Date(data.fetchedAt).getTime());
    if(stale===instances.length)return idle?SPLIT_IDLE:'관측 지연';if(stale>0)return `일부 관측 지연 · ${stale}개`;
    return key==='connect-agent'?(agent?.busy?'작업 중':'응답 관측'):seen.value.status==='running'?'실행 관측':String(seen.value.status??'확인 필요');
  }
  const warns=(key:string)=>/없음|지연|필요|failed/.test(status(key));
  const jobPaused=!!job?.notBefore&&Date.parse(job.notBefore)-Date.parse(data.fetchedAt)>PAUSED_AFTER_MS;
  function request(name:string){start(async()=>{const result=await requestOperation(name);setMessage(result.error??result.message??'');router.refresh();});}
  return <div className="ops-center">
    <header className="ops-header compact"><div><h1>운영센터</h1><span className="ops-snapshot-inline">마지막 갱신 <time dateTime={data.fetchedAt}>{clock(data.fetchedAt)}</time> · 워커 관측 15초 · 화면 10초</span></div><div className="ops-actions"><CollectionSwitch enabled={enabled}/><LiveRefresh/><button disabled={pending} onClick={()=>start(()=>router.refresh())}>새로고침</button><button className="primary" onClick={()=>show({tab:'ai'})}>AI 연결·설정</button></div></header>
    <div className="ops-status-chips">{statusChips}</div>
    {tab!=='ai'&&(!agent?.configReady||agent.lastAttempt?.result&&agent.lastAttempt.result!=='success')&&<div className="ops-alert"><div><strong>AI 연결·분류 상태를 확인해주세요</strong><p>분류 실패 후보는 보류됩니다. 계정을 연결하거나 수동으로 카테고리를 지정할 수 있습니다.</p></div><button onClick={()=>show({tab:'ai'})}>연결 상태 확인 →</button></div>}
    <nav className="ops-tabs" aria-label="운영센터 화면">{STATUS_TABS.map(key=><button key={key} aria-current={tab===key?'page':undefined} onClick={()=>show({tab:key})}>{TAB_LABELS[key]}{key==='manual'&&data.held>0&&<span>{data.held}</span>}</button>)}</nav>
    {message&&<p className="ops-message" role="status">{message}</p>}
    {tab==='overview'&&<div className="ops-console">
      {/* 폰에서는 상태 칩·조치할 일·역할 표만 세로로 — 나머지 지표는 눌러서 편다(ADM-30) */}
      <div className="dash" data-phone-full={phoneFull||undefined}>
        {attention}
        {dashboard}
        <div className="ops-phone-rest"><JobsStrip jobs={jobs} now={data.fetchedAt} onOpen={openJob}/></div>
      </div>
      <button type="button" className="ops-phone-more" aria-expanded={phoneFull} onClick={()=>setPhoneFull(!phoneFull)}>{phoneFull?'나머지 지표 접기':'나머지 지표 보기 — 처리량·파이프라인·모델·신호'}</button>
    </div>}
    {tab==='jobs'&&<JobTimeline jobs={jobs.filter(j=>j.name!=='heartbeat')} now={data.fetchedAt} onOpen={openJob}/>}
    {tab==='crawlers'&&crawlers}
    {tab==='ai'&&<AiConnection initial={agent??null} reviewMode={reviewMode}/>}
    {tab==='manual'&&manual}
    {/* 진단 — 전에는 전체 현황 아래 접힌 "상세 지표"라 펼치면 페이지가 9,589px 이었다(ADM-16) */}
    {tab==='diagnostics'&&<div className="ops-diagnostics">
      {diagnostics}
      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
        <section className="ops-mini"><h3>서비스 관측 <small>{roles.filter(key=>!warns(key)).length}/{roles.length} 정상</small></h3>
          <table><tbody>{roles.map(key=><tr key={key} onClick={()=>show({worker:key})} title={`${key} — ${DESCRIPTIONS[key]}`}>
            <td><StatusDot state={warns(key)?'delayed':status(key)===SPLIT_IDLE?'idle':'ok'} label={ROLE_LABELS[key]}/></td><td className="n">{key==='db'?`${data.dbLatencyMs}ms`:`${liveFor(key).length}대`}</td><td className="n">{key==='db'?'조회':formatAgo(latestFor(key)?.observedAt,data.fetchedAt)}</td></tr>)}</tbody></table></section>
        <section className="ops-mini"><h3>작업 <small>마지막 · 다음</small></h3>
          <table><tbody>{jobs.filter(j=>j.name!=='heartbeat').map(j=><tr key={j.name} onClick={()=>openJob(j)} title={j.name}>
            <td><StatusDot state={j.lastError?'failed':'ok'} label={JOB_LABELS[j.name]??j.name}/></td><td className="n">{formatAgo(j.lastRunAt,data.fetchedAt)}</td><td className="n">{formatAgo(j.nextScheduledAt,data.fetchedAt)}</td></tr>)}</tbody></table></section>
        <section className="ops-mini"><h3>최근 관리자 작업 <Link href="/admin/activity" prefetch={false}>전체 기록 →</Link></h3>{data.audit.length?<ul>{data.audit.slice(0,8).map(a=><li key={a.id}><b title={a.action}>{ACTION_LABELS[a.action]??a.action}</b> {a.target}<small>{a.actor} · {formatAgo(a.createdAt,data.fetchedAt)}</small></li>)}</ul>:<p>기록 없음</p>}</section>
      </div>
    </div>}
    {selected&&<OperationsDialog labelledBy="worker-title" onClose={()=>show({worker:null})}><div className="ops-worker-detail"><div className="ops-row"><div><div className="ops-eyebrow">워커 상세</div><h2 id="worker-title">{ROLE_LABELS[selected]}</h2><code>{selected}</code></div><span className="ops-badge">{status(selected)}</span><button onClick={()=>show({worker:null})}>닫기</button></div><p>{DESCRIPTIONS[selected]}</p>{selected!=='db'&&<div><h3>인스턴스별 관측</h3>{instancesFor(selected).length?instancesFor(selected).map(instance=><div className="ops-job-item" key={instance.key}><div><strong>{instance.instanceId}</strong><code>{instance.key}</code><small>{formatDetailTime(instance.observedAt)} · {String(instance.value.release??'릴리스 미확인')} · RSS {typeof (instance.value.supervisorRssBytes??instance.value.rssBytes)==='number'?`${Math.round(Number(instance.value.supervisorRssBytes??instance.value.rssBytes)/1024/1024)}MB`:'미확인'}</small></div><span className={`ops-badge ${new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()>45_000?'warn':'ok'}`}>{new Date(data.fetchedAt).getTime()-new Date(instance.observedAt).getTime()>45_000?'관측 지연':'정상 관측'}</span></div>):<div className="ops-note">관측된 인스턴스가 없습니다.</div>}</div>}<div className="ops-detail-grid"><div><h3>담당 작업과 실행 조건</h3>{owned.length?owned.map(j=><div className="ops-job-item" key={j.name}><div><strong>{JOB_LABELS[j.name]??j.name}</strong><code>{j.name}</code><small>{j.status} · 다음 예약 {formatDetailTime(j.nextScheduledAt)}</small>{snapshots.get(`job:${j.name}`)&&<small>최근 회차 {Number(snapshots.get(`job:${j.name}`)!.value.durationMs)/1000}초 · {formatDetailTime(snapshots.get(`job:${j.name}`)!.observedAt)}</small>}</div><button onClick={()=>show({worker:null,job:j.name})}>상세</button></div>):<div className="ops-note">예약 잡을 소비하지 않는 서비스입니다.</div>}</div><div><h3>최근 인스턴스 상태</h3><dl className="ops-facts"><div><dt>현재 작업</dt><dd>{typeof runtime?.currentJob==='string'?JOB_LABELS[runtime.currentJob]??runtime.currentJob:'관측된 실행 작업 없음'}</dd></div><div><dt>작업 시작</dt><dd>{formatDetailTime(runtime?.jobStartedAt as string|number|undefined,'기록 없음')}</dd></div><div><dt>마지막 진행</dt><dd>{formatDetailTime(runtime?.lastProgressAt as string|number|undefined,'기록 없음')}</dd></div><div><dt>프로세스 시작</dt><dd>{formatDetailTime(runtime?.bootedAt as string|number|undefined,'기록 없음')}</dd></div><div><dt>감시 프로세스 RSS</dt><dd>{typeof (runtime?.supervisorRssBytes??runtime?.rssBytes)==='number'?`${Math.round(Number(runtime?.supervisorRssBytes??runtime?.rssBytes)/1024/1024)}MB`:'관측 없음'}</dd></div><div><dt>릴리스</dt><dd>{String(runtime?.release??'관측 없음')}</dd></div></dl><div className="ops-trace">{selected==='reviewer'?`AI 심사 모드: ${reviewMode}. 회차 성공은 모델 호출 성공과 별개입니다.`:selected==='publisher'?`AI 분류 실패는 보류합니다. 분류 보류 ${data.held}건.`:'저장된 프로세스 관측입니다. 컨테이너 상태와 전체 후보 처리율을 추정하지 않습니다.'}</div>{selected==='publisher'&&<button onClick={()=>show({worker:null,tab:'ai'})}>AI 연결·모델 설정 보기 →</button>}</div></div></div></OperationsDialog>}
    {job&&<OperationsDialog labelledBy="job-title" onClose={()=>show({job:null})}><div className="ops-row"><h2 id="job-title">{JOB_LABELS[job.name]??job.name}</h2><button onClick={()=>show({job:null})}>닫기</button></div><code>{job.name}</code><dl className="ops-facts">{[['상태',job.status],['요청 / 처리',`${job.requestedVersion} / ${job.processedVersion}`],['마지막 실행',formatDetailTime(job.lastRunAt,'기록 없음')],['마지막 성공',formatDetailTime(job.lastSuccessAt,'기록 없음')],['다음 예약',formatDetailTime(job.nextScheduledAt,'기록 없음')],['재시도 가능',formatDetailTime(job.notBefore,'기록 없음')],['누적 실행 회차',job.runs],['마지막 오류',job.lastError??'없음']].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl><details open><summary>최근 회차의 처리 결과</summary><pre>{snapshots.get(`job:${job.name}`)?JSON.stringify(snapshots.get(`job:${job.name}`)!.value,null,2):"수집된 회차 결과 없음"}</pre></details><details><summary>저장된 재개 위치</summary><pre>{job.cursor}</pre></details>{job.name!=='heartbeat'&&<><p className="ops-note">실행 요청은 접수이며 완료가 아닙니다. 공급자 대기·항목별 재시도 상한·재시도 가능 시각을 유지합니다.{jobPaused&&' 사람이 중단한 작업은 여기서 재개하지 않습니다.'}</p><button disabled={pending||jobPaused||job.requestedVersion>job.processedVersion} onClick={()=>request(job.name)}>작업 실행 요청</button></>}{message&&<p role="status">{message}</p>}</OperationsDialog>}
  </div>;
}
