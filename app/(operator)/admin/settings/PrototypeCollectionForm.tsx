"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { prototypeCollectionFields, type PrototypeCollectionSettings } from "@/lib/operations/admin-prototype-collection-fields";
import { saveCrawlSettings } from "../actions";
import { describeChanges, formValues } from "./changes";
import { PrototypePanel, PrototypeTag } from "../products/PrototypeParts";

const visible = new Set(["windowDays", "pagesPerTick", "maxNewPerHour", "autoApproveMinStars", "maxPushAgeDays", "excludeForks", "holdAmbiguous"]);
export function PrototypeCollectionForm({ settings, version }: { settings: PrototypeCollectionSettings; version: string }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null), dialog = useRef<HTMLDialogElement>(null), accepted = useRef(false);
  const [dirty, setDirty] = useState(false), [changes, setChanges] = useState<string[]>([]), [formVersion,setVersion] = useState(version);
  const baseline = useRef(prototypeCollectionFields(settings));
  const [result, action, pending] = useActionState(async (previous: Awaited<ReturnType<typeof saveCrawlSettings>>, values: FormData) => {
    const saved = await saveCrawlSettings(previous, values);
    if (saved?.ok) { if(saved.version)setVersion(saved.version); if(form.current)baseline.current=formValues(form.current);setDirty(false);router.refresh(); }
    return saved;
  }, null);
  const fields = prototypeCollectionFields(settings);
  useEffect(() => { if(!dirty)return; const leave=(event:BeforeUnloadEvent)=>event.preventDefault();window.addEventListener("beforeunload",leave);return()=>window.removeEventListener("beforeunload",leave); },[dirty]);
  const numberField = (label: string, name: string, min: number, max: number, hint: string) => <div className="field"><label htmlFor={name}>{label}</label><input id={name} name={name} type="number" defaultValue={fields[name]} min={min} max={max} required /><p>{hint}</p></div>;
  return <><form ref={form} action={action} className="stack" data-dirty={dirty || undefined} onChange={()=>{setDirty(true);accepted.current=false;}} onSubmit={event=>{
    if(accepted.current){accepted.current=false;return;}
    event.preventDefault();if(!form.current)return;
    setChanges(describeChanges(baseline.current,formValues(form.current)));dialog.current?.showModal();
  }}>
    <input type="hidden" name="settingsVersion" value={formVersion} />{Object.entries(fields).filter(([key])=>!visible.has(key)).map(([key,value])=><input key={key} type="hidden" name={key} value={value} />)}
    <PrototypePanel title="수집 범위·검색 신호" actions={<Link className="button small" href="/admin#signals">검색 신호 편집</Link>}><div className="form-grid">{numberField("최근 며칠의 프로젝트","windowDays",1,3650,"발굴 조회 범위 · 기존 진행 위치와 구분")}{numberField("틱당 검색 페이지","pagesPerTick",1,10,"실제 검색 신원의 요청 한도와 함께 적용")}{numberField("시간당 새 저장소 상한","maxNewPerHour",60,3600,"새 발굴량 상한 · 현재 큐와 별도")}<div className="field"><label>수집 소스</label><div className="flex"><PrototypeTag tone="green">GitHub 검색</PrototypeTag><PrototypeTag tone={settings.discover.showHn.enabled?"green":"gray"}>Show HN {settings.discover.showHn.enabled?"사용":"중지"}</PrototypeTag><PrototypeTag tone={settings.discover.showGn.enabled?"green":"gray"}>Show GN {settings.discover.showGn.enabled?"사용":"중지"}</PrototypeTag></div><p>런타임 중지·재개는 운영 홈에서 제어합니다.</p></div></div><div className="table-scroll mt"><table><thead><tr><th>신호</th><th>상태</th><th>원본 종류</th><th>우선순위</th></tr></thead><tbody>{settings.discover.queries.map(query=><tr key={query.label}><td>{query.label}</td><td><PrototypeTag tone={query.enabled?"green":"gray"}>{query.enabled?"사용":"중지"}</PrototypeTag></td><td>{query.kind === "repositories" ? "저장소 검색" : "커밋 검색"}</td><td>{query.priority}</td></tr>)}</tbody></table></div><div className="table-note">검색 신호 편집은 원본 편집기에서 처리합니다. 이 폼은 현재 신호와 고급 기준을 그대로 보존합니다.</div></PrototypePanel>
    <PrototypePanel title="판정 기준·근거 관문"><div className="form-grid">{numberField("자동 승인 최소 스타","autoApproveMinStars",500,10000000,"기존 자동 승인 경로의 조건을 보존")}{numberField("방치 기준 · 일","maxPushAgeDays",1,3650,"공개 후 생존 확인과 구분")}</div>{[["excludeForks","포크 제외","원본 조건을 기반으로 규칙 판정"],["holdAmbiguous","애매하면 보류","끄면 기존 규칙에 따라 거부"]].map(([name,label,hint])=><div className="switch-row" key={name}><span><b>{label}</b><small>{hint}</small></span><input type="checkbox" className="switch" name={name} defaultChecked={fields[name]==="on"} aria-label={label} /></div>)}<div className="notice mt">발행 보호·2차 심사·위임·자동 재심사 정책은 심사 운영 설정에서 관리합니다. 모델 순위는 LLM 운영에 연결합니다.</div><div className="flex mt"><Link className="button small" href="/admin/review">심사 운영 설정</Link><Link className="button small" href="/admin/models/tasks">작업별 모델</Link><Link className="button small" href="/admin#judge">전체 판정·고급 기준</Link></div></PrototypePanel>
    <div className="save-bar"><p role="status">{result?.issues?.join(" · ") ?? (result?.ok?"설정을 저장했습니다. 역할별 적용 상태를 확인하세요.":"변경은 미리보기 후 저장합니다. 기존 설정 판을 견주어 저장합니다.")}</p><button type="submit" className="button primary" disabled={pending}>{pending?"저장 중":"수집·판정 변경 미리보기"}</button></div>
  </form><dialog ref={dialog}><div className="modal-header"><div><div className="eyebrow">변경 확인</div><h2>수집·판정 설정 변경</h2></div><button type="button" className="icon-button" onClick={()=>dialog.current?.close()} aria-label="닫기">×</button></div><div className="modal-body"><ul>{changes.map(change=><li key={change}>{change}</li>)}</ul>{changes.length===0&&<p>변경한 값이 없습니다.</p>}<p className="small muted mt">진행 중인 작업의 근거를 바꾸지 않고, 저장된 설정은 다음 작업에 적용됩니다.</p><div className="modal-actions"><button type="button" className="button" onClick={()=>dialog.current?.close()}>계속 편집</button><button type="button" className="button primary" disabled={changes.length===0||pending} onClick={()=>{accepted.current=true;dialog.current?.close();form.current?.requestSubmit();}}>변경 저장</button></div></div></dialog></>;
}
