import Link from "next/link";
import Form from "next/form";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { llmAssistControls } from "@/lib/db/llm-assist-schema";
import { getSettings } from "@/lib/crawl/settings";
import { listAuditFindings, listHeldFindings, productAuditOverview } from "@/lib/crawl/product-audit";
import { publishedSecondReviews } from "@/lib/crawl/second-review";
import { recheckPublishedProducts } from "@/lib/domain/products/recheck";
import { listProducts } from "@/lib/domain/products/repository";
import { formatDetailTime } from "@/lib/format/time";
import { AuditHoldSettingsForm, CancelAudit, RestartStalledAudit, StartAudit } from "../audit/AuditControls";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { secondOpinionLabel } from "../audit/second-opinion-label";
import { BanAction } from "./BanAction";
import { PageStamp } from "../components/PageStamp";
import { PrototypeQualityDecision } from "./PrototypeQualityActions";
import { PrototypeEmpty, PrototypePanel, PrototypeTag, n, prototypeRepositoryStatus } from "./PrototypeParts";

export const QUALITY_MODES = [["audit","AI 감사·정책"],["second","공개분 2차"],["rules","규칙 재검수"],["uptime","생존·저장소"]] as const;
type Mode = typeof QUALITY_MODES[number][0];
export function prototypeQualityMode(value:unknown):Mode { return QUALITY_MODES.some(([key])=>key===value) ? value as Mode : "audit"; }
const notice:Record<Mode,string> = {
  audit:"AI 감사·화면 판별·두 번째 의견·정책 처리를 한 업무 맥락에서 관리합니다. 의견 가져오기와 유지 기한·감사 재시작도 보존합니다.",
  second:"공개된 프로젝트의 추가 확인입니다. 신규 후보의 반려와 구분하여 현재 근거로 유지·내림을 결정합니다.",
  rules:"보관 원본을 현재 규칙으로 다시 확인합니다. 재검수 결과만으로 프로젝트를 자동으로 내리지 않습니다.",
  uptime:"확인 소비·공개 반영 상태를 실제 저장값으로 조회합니다. 이 화면에서 새 설정 쓰기 기능을 만들지 않습니다.",
};
export async function PrototypeQualityWorkspace({ mode: rawMode, offset: rawOffset }: { mode?:string;offset?:string }={}) {
  const mode=prototypeQualityMode(rawMode), parsed=Number(rawOffset), offset=Number.isSafeInteger(parsed)&&parsed>=0?Math.min(parsed,100000):0;
  return <main><PageStamp /><div className="page-heading"><div className="heading-actions"><Link className="button small" href="/admin/products/recheck">규칙 재검수</Link><Link className="button small" href="/admin/audit?tab=audit">AI 감사 시작·관리</Link></div></div>
    <div className="toolbar"><Form action="/admin/products" className="segmented" aria-label="품질 검사 종류"><input type="hidden" name="tab" value="quality"/>{QUALITY_MODES.map(([key,label])=><button key={key} type="submit" name="mode" value={key} aria-pressed={mode===key}>{label}</button>)}</Form><span className="spacer flex">{mode==="audit"?<><Link className="button small" href="/admin/audit?tab=policy">의견 가져오기</Link><Link className="button small" href="/admin/audit?tab=policy">유지 기한 연장</Link><Link className="button small" href="/admin/audit?tab=policy">정책 미리보기</Link></>:mode==="rules"?<Link className="button small primary" href={`/admin/products?tab=quality&mode=rules&offset=${offset}`}>현재 규칙으로 확인</Link>:null}</span></div>
    <div className="stack">{mode!=="uptime"&&<div className={`notice ${mode==="audit"?"":"blue"}`}>{notice[mode]}</div>}{mode==="audit"?<AuditQuality/>:mode==="second"?<PublishedQuality/>:mode==="rules"?<RulesQuality offset={offset}/>:<UptimeQuality/>}</div>
  </main>;
}

async function AuditQuality() {
  const overview=await productAuditOverview().catch(()=>null);
  const rows=await (overview?.held||!overview?.campaign ? listHeldFindings({limit:25,offset:0}) : listAuditFindings(overview.campaign.id,"reject",{limit:25,offset:0})).catch(()=>null);
  const campaign=overview?.campaign, running=campaign?.status==="running";
  return <><section className="panel"><div className="table-scroll"><table style={{minWidth:850}}><thead><tr><th>프로젝트</th><th>검사·근거</th><th>현재 판단</th><th>추가 의견</th><th>조치</th></tr></thead><tbody>{rows?.map(row=><tr key={row.id}><td><b>{row.name}</b><p>{row.slug}</p></td><td>AI 감사 · 보관 원문<p>{formatDetailTime(row.reviewedAt)}</p><details><summary className="text-button">판단 근거</summary><p>{row.reason||"기록된 사유 없음"}</p><a href={row.url} target="_blank" rel="noopener noreferrer">현재 사이트 ↗</a></details></td><td><PrototypeTag tone="amber">{row.heldAt?"공개 목록 보류":"내림 제안"}</PrototypeTag><p>{typeof row.confidence==="number"?`확신 ${row.confidence.toFixed(2)}`:"확신 미관측"}</p>{!row.screenJudged&&<p>화면 근거 확인 필요</p>}</td><td>{row.second?.length?row.second.map(opinion=><div key={`${opinion.model}-${opinion.source??""}`}><PrototypeTag tone={opinion.decision==="reject"?"amber":opinion.decision==="approve"?"green":"gray"}>{secondOpinionLabel(opinion)}</PrototypeTag>{opinion.reason&&<details><summary>추가 사유</summary><p>{opinion.reason}</p></details>}</div>):"추가 의견 기록 없음"}</td><td><div className="flex"><Link className="button small" href={`/admin/products/${row.slug}?section=quality`}>근거</Link><PrototypeQualityDecision kind="audit" id={row.id} slug={row.slug} name={row.name}/></div></td></tr>)}</tbody></table>{rows===null?<PrototypeEmpty>감사 검토 대상을 읽지 못했습니다.</PrototypeEmpty>:rows.length===0&&<PrototypeEmpty>{overview===null?"공개 보류 목록은 비어 있습니다. 다른 감사 상태는 확인하지 못했습니다.":"이 조건에서 사람이 볼 감사 대상이 없습니다."}</PrototypeEmpty>}</div><div className="table-note">오래된 공개 보류를 먼저, 없으면 현재 감사의 열린 내림 제안을 최대 25개 표시합니다. <Link href="/admin/audit?tab=audit">모든 보류·갈림·의견·정책 처리 →</Link></div></section>
    <PrototypePanel title="감사 운영 설정" actions={<span className="small muted">{campaign?formatDetailTime(campaign.startedAt):"감사 기록 확인"}</span>}><div className="form-grid"><div className="field"><label>자동 보류·추가 의견</label>{overview?<><p>자동 보류 {overview.hold.enabled?"사용":"중지"} · 확신 {overview.hold.minConfidence.toFixed(2)} 이상</p><p>두 번째 거절 의견 {overview.hold.secondOpinionReject?"보류 조건에 포함":"별도 확인"}</p><details className="mt"><summary className="button small">보류 기준 편집</summary><AuditHoldSettingsForm hold={overview.hold}/></details></>:<p>감사 설정을 확인하지 못했습니다.</p>}</div><div className="field"><label>{campaign?`감사 캠페인 #${campaign.id}`:"감사 캠페인"}</label>{overview&&campaign?<><p>검사 {n(overview.counts.reviewed)} / 대상 {n(overview.counts.total)} · 실패 {n(overview.counts.failed)}</p><p>{overview.stalled?"심사 기준 변경으로 중단됨":overview.paused??(running?"진행 중":"종료됨")}</p><div className="flex mt-sm">{overview.stalled&&<RestartStalledAudit campaignId={campaign.id} from={`${campaign.promptVersion}·${campaign.rulesVersion}`} to={`${REVIEW_PROMPT_VERSION}·${REVIEW_RULES_VERSION}`}/>}<Link className="button small" href="/admin/audit?tab=audit">감사 모델 전환</Link>{running&&<CancelAudit/>}</div></>:<p>{overview?"아직 연 감사가 없습니다.":"감사 진행을 확인하지 못했습니다."}</p>}<details className="mt"><summary className="button small">감사 시작·재시작</summary><StartAudit first={!campaign} blockedReason={!overview?"현재 감사 상태를 먼저 확인하세요.":overview.stalled?"멈춘 감사의 기준을 먼저 확인하세요.":running?"감사가 진행 중입니다.":null}/></details></div></div></PrototypePanel></>;
}

async function PublishedQuality() {
  const rows=await publishedSecondReviews(25).catch(()=>null);
  return <section className="panel"><div className="table-scroll"><table style={{minWidth:850}}><thead><tr><th>프로젝트</th><th>검사·근거</th><th>현재 판단</th><th>추가 의견</th><th>조치</th></tr></thead><tbody>{rows?.map(row=><tr key={row.id}><td><b>{row.publishedSlug??row.repo}</b><p>{row.repo}</p></td><td>공개분 2차<p>{row.trigger==="risk"?"위험 신호":"표본 확인"} · {formatDetailTime(row.reviewedAt)}</p><details><summary className="text-button">판단 근거</summary><p>{row.secondReason??"기록된 사유 없음"}</p></details></td><td><PrototypeTag tone="amber">{row.secondDecision==="reject"?"내림 제안":"판단 보류"}</PrototypeTag><p>{typeof row.secondConfidence==="number"?`확신 ${row.secondConfidence.toFixed(2)}`:"확신 미관측"}</p></td><td>{row.autoOpinion?<><PrototypeTag tone={row.autoOpinion.decision==="approve"?"green":"amber"}>{row.autoOpinion.decision==="reject"?"추가 거절":row.autoOpinion.decision==="approve"?"추가 승인":"추가 판단 보류"}</PrototypeTag><details><summary>추가 사유</summary><p>{row.autoOpinion.reason}</p></details></>:"추가 의견 기록 없음"}</td><td>{row.publishedSlug&&<div className="flex"><Link className="button small" href={`/admin/products/${row.publishedSlug}?section=quality`}>근거</Link><PrototypeQualityDecision kind="published" id={row.id} slug={row.publishedSlug} name={row.publishedSlug}/></div>}</td></tr>)}</tbody></table>{rows===null?<PrototypeEmpty>공개분 2차 확인을 읽지 못했습니다.</PrototypeEmpty>:rows.length===0&&<PrototypeEmpty>사람이 볼 공개분 2차 확인이 없습니다.</PrototypeEmpty>}</div><div className="table-note">현재 처리 대기인 공개분을 최대 25개 표시합니다. <Link href="/admin/review?second=published">모든 공개분 확인 →</Link></div></section>;
}

async function RulesQuality({offset}:{offset:number}) {
  const settings=await getSettings();
  const result=await recheckPublishedProducts(settings,{limit:200,offset}).catch(()=>null);
  return <>{result&&<div className="notice">현재 구간 {n(result.checked)}개 확인 · 내림 검토 {n(result.hits.length)}개{result.withoutText>0&&` · 본문 근거 부족 ${n(result.withoutText)}개는 확인 미완료`}</div>}<section className="panel"><div className="table-scroll"><table style={{minWidth:850}}><thead><tr><th>프로젝트</th><th>검사·근거</th><th>현재 판단</th><th>추가 의견</th><th>조치</th></tr></thead><tbody>{result?.hits.map(row=><tr key={row.slug}><td><b>{row.name}</b><p>{row.repo}</p></td><td>현재 보관 원문 · 현재 규칙<details><summary>규칙 근거</summary><p>{row.reason}</p></details></td><td><PrototypeTag tone="amber">현재 기준의 거부</PrototypeTag></td><td>규칙 결과입니다. 모델 의견으로 표시하지 않습니다.</td><td><div className="flex"><Link className="button small" href={`/admin/products/${row.slug}?section=quality`}>근거·유지 확인</Link><BanAction slug={row.slug} name={row.name} banned={false} className="button small danger"/></div></td></tr>)}</tbody></table>{result===null?<PrototypeEmpty>현재 규칙 재검수 결과를 읽지 못했습니다.</PrototypeEmpty>:result.hits.length===0&&<PrototypeEmpty>현재 확인 구간에서 내림을 검토할 결과가 없습니다.</PrototypeEmpty>}</div><div className="table-note">자동으로 내리지 않습니다. 유지하면 현재 상태를 그대로 두며, 내림에는 기존 사유 선택·확인 절차를 적용합니다.</div></section>{result&&result.checked===200&&<Link className="button small" href={`/admin/products?tab=quality&mode=rules&offset=${offset+200}`}>다음 원본 구간 확인 →</Link>}</>;
}

async function UptimeQuality() {
  const [controlRows,down,missing]=await Promise.all([
    db.select({confirmationRequired:llmAssistControls.confirmationRequired,dispatchEnabled:llmAssistControls.dispatchEnabled,applyEnabled:llmAssistControls.applyEnabled}).from(llmAssistControls).where(eq(llmAssistControls.task,"uptime")).limit(1).catch(()=>null),
    listProducts({statuses:["verified","seeded"],down:true,limit:25}).catch(()=>null),
    listProducts({statuses:["verified","seeded"],repoGone:true,limit:25}).catch(()=>null),
  ]);
  const control=controlRows?.[0];
  const rows=down&&missing?[...new Map([...down,...missing].map(row=>[row.slug,row])).values()]:null;
  const downSlugs=new Set(down?.map(row=>row.slug));
  return <><PrototypePanel title="접속 실패의 LLM 확인 상태" actions={<PrototypeTag tone="gray">조회 전용</PrototypeTag>}><div className="grid three"><div><PrototypeTag tone="blue">{control?control.confirmationRequired?"확인 필수":"필수 확인 아님":"확인 못함"}</PrototypeTag><h3 className="mt-sm">{control?control.confirmationRequired?"확인 근거 후 적용":"현재 정책 확인":"정책 미관측"}</h3><p className="small muted mt-sm">실제 확인 소비·공개 반영 상태를 따로 확인합니다.</p></div><div><PrototypeTag tone={control?.dispatchEnabled?"green":"gray"}>{control?`확인 소비 ${control.dispatchEnabled?"ON":"OFF"}`:"확인 못함"}</PrototypeTag><h3 className="mt-sm">{control?.dispatchEnabled?"모델에 확인 요청":"확인 요청 중지·미확인"}</h3><p className="small muted mt-sm">소비와 프로젝트 내림 적용은 다른 상태입니다.</p></div><div><PrototypeTag tone={control?.applyEnabled?"amber":"gray"}>{control?`적용 ${control.applyEnabled?"ON":"OFF"}`:"확인 못함"}</PrototypeTag><h3 className="mt-sm">{control?.applyEnabled?"공개 상태 반영 허용":"공개 상태 반영 중지·미확인"}</h3><p className="small muted mt-sm">기존 조회 전용 기능을 보존합니다.</p></div></div></PrototypePanel>
    <PrototypePanel title="생존·저장소 확인 대상"><div className="table-scroll"><table style={{minWidth:850}}><thead><tr><th>프로젝트</th><th>사유</th><th>모델/근거 상태</th><th>공개 상태</th><th>관리</th></tr></thead><tbody>{rows?.map(row=><tr key={row.slug}><td><b>{row.name}</b></td><td>{downSlugs.has(row.slug)?"응답 없음":"저장소 확인"}<p>{prototypeRepositoryStatus(row.repoStatus)}</p></td><td><PrototypeTag tone="amber">원본·추가 확인</PrototypeTag></td><td><PrototypeTag tone="green">공개 대상 · 노출 별도</PrototypeTag></td><td><Link className="button small" href={`/admin/products/${row.slug}?section=quality`}>근거 확인</Link></td></tr>)}</tbody></table>{rows===null?<PrototypeEmpty>생존·저장소 대상의 일부를 읽지 못했습니다.</PrototypeEmpty>:rows.length===0&&<PrototypeEmpty>현재 확인 대상이 없습니다.</PrototypeEmpty>}</div><div className="table-note">응답 없음·저장소 소실을 각각 최대 25개 읽고 같은 프로젝트는 한 번만 표시합니다. 확인 소비·적용 값은 읽기 전용입니다.</div></PrototypePanel></>;
}
