import Link from "next/link";
import { logger } from "@/lib/observability/logger";
import { readProjectFlowOverview, readSocialFlowOverview, type SocialFlowJobs } from "@/lib/operations/flow-overview-read";
import { flowOverviewRequests, publicationChange, type FlowOverviewContext, type ProjectFlowOverview, type SocialFlowOverview } from "@/lib/operations/flow-overview-model";
import { clock, number, Panel, ReadStamp, Stat, Tag } from "./PrototypeParts";
import "./FlowOverview.css";

const stampHour = (at: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).format(new Date(at));
const warn = (event: string) => (error: unknown) => { logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" }); return null; };

export function PublicationTrend({ overview }: { overview: ProjectFlowOverview | null }) {
  const change = overview ? publicationChange(overview.published24h, overview.previous24h) : null;
  const max = Math.max(1, ...overview?.hours.map(point => point.count) ?? []);
  return <section className="flow-publication-trend" aria-label="시간별 자동 발행량 추이">
    <div className="flow-publication-heading"><div><h3>발행량 증가 추이</h3><p>자동 발행 완료 · 최근 24시간과 직전 24시간 비교</p></div><ReadStamp at={overview?.measuredAt} /></div>
    <div className="flow-publication-body"><div className="flow-publication-summary"><small>최근 24시간 자동 발행</small><strong className="mono">{number(overview?.published24h)}<span>건</span></strong><p>직전 24시간 {number(overview?.previous24h)}건</p><b className={change && change.delta > 0 ? "flow-growth-up" : ""}>{change ? `${change.delta > 0 ? "+" : ""}${number(change.delta)}건${change.percent === null ? " · 이전 기간 0건" : ` (${change.percent > 0 ? "+" : ""}${change.percent.toFixed(1)}%)`}` : "비교를 읽지 못했습니다."}</b></div>
      {overview ? <figure className="flow-publication-chart"><svg viewBox="0 0 740 138" role="img" aria-label="시간별 자동 발행 완료 건수, 마지막 막대는 진행 중인 현재 시간">
        <line x1="0" x2="740" y1="108" y2="108" className="flow-chart-axis" />
        {overview.hours.map((point, index) => { const height = point.count / max * 96; return <rect key={point.hour} x={index * 30 + 4} y={108 - height} width="21" height={height} rx="3" className={index === 23 ? "flow-chart-current" : "flow-chart-bar"}><title>{stampHour(point.hour)}시 · {number(point.count)}건{index === 23 ? " · 현재 시간 집계 중" : ""}</title></rect>; })}
        {[0, 6, 12, 18, 23].map(index => <text key={index} x={index * 30 + 14} y="130" textAnchor={index === 0 ? "start" : index === 23 ? "end" : "middle"}>{stampHour(overview.hours[index].hour)}시</text>)}
        <text x="738" y="14" textAnchor="end">시간당 최대 {number(max === 1 && !overview.hours.some(point => point.count) ? 0 : max)}건</text>
      </svg><figcaption>시간별 24칸 · KST · 마지막 칸은 현재 시간의 부분 집계입니다. 위 합계는 정확히 최근 24시간 기준입니다.</figcaption></figure> : <p className="flow-publication-unread" role="status">발행 기록을 읽지 못했습니다. 다음 갱신에서 다시 확인합니다.</p>}
    </div><p className="flow-publication-note">자동 파이프라인의 발행 완료 전환을 셉니다. 수동 등록·현재 공개 프로젝트 총수와 범위가 다릅니다.</p>
  </section>;
}

export function FlowOverviewView({ overview, data, desk, reactionRequests }: FlowOverviewContext & { overview: ProjectFlowOverview | null }) {
  const requests = flowOverviewRequests(desk, reactionRequests), ledger = desk?.equipment?.ledger;
  return <div className="flow-overview"><div className="flow-overview-kpis">
    <Stat label="전체 등록 프로젝트" value={<>{number(overview?.registered)}<small>개</small></>} foot={overview ? <>공개 등재 {number(overview.listed)} · 검증 대기 {number(overview.unverified)} · 차단 {number(overview.banned)}</> : "등록 원본을 읽지 못했습니다."} />
    <Stat label="최근 1시간 자동 발행" value={number(overview?.published1h)} foot="실제 발행 완료 전환 기준" tone="good" spark={overview?.hours.map(point => point.count)} />
    <Stat label="사람이 판단할 후보" value={<>{number(data.human?.waiting)}<small>건</small></>} foot={data.human ? `직접 판단 ${number(data.human.direct)} · 확정 ${number(data.human.agreed)} · 자동 대기 제외` : "사람 확인 집계를 읽지 못했습니다."} />
    <Stat label="열린 사용자 요청" value={<>{number(requests)}<small>건</small></>} foot={requests === null ? "일부 요청 집계를 확인하지 못함" : "내림·소개 수정·문의·사용자 글 3종"} />
    <Stat label="LLM 확인 필요" value={ledger && ledger.status !== "unknown" ? number(ledger.reviewCount) : "—"} foot="미확정 검토 · 물리 점유와 별도" tone={ledger?.reviewCount ? "bad" : ""} />
  </div><PublicationTrend overview={overview} /></div>;
}

export async function FlowOverviewSummary(props: FlowOverviewContext) {
  const overview = await readProjectFlowOverview().catch(warn("flow.overview_unavailable"));
  return <FlowOverviewView {...props} overview={overview} />;
}

export function SocialFlowView({ data }: { data: SocialFlowOverview | null }) {
  if (!data) return <Panel title="SNS 수집·사이트 발행 흐름"><p className="notice" role="status">SNS 운영 관측을 읽지 못했습니다. 프로젝트 자동 수집 흐름은 별도로 확인할 수 있습니다.</p></Panel>;
  const stages = [
    { step: "01 / 수집", title: "외부 글 수집", value: data.stored, unit: "글", hint: `최근 24시간 새 글 ${number(data.new24h)}건`, foot: "보관 중인 SNS 글 · 숨김·원문 삭제 포함", href: "/admin/content?tab=social", label: "수집 글 확인" },
    { step: "02 / 연결", title: "프로젝트 연결", value: data.linked, unit: "글", hint: "등록 프로젝트에 저장소로 연결", foot: "보관 글 기준 · 공개 자격 판정과 별도", href: "/admin/talk?link=product", label: "연결 상태 확인" },
    { step: "03 / 공개 조건", title: "화제 발행 대상", value: data.qualifiedProjects, unit: "프로젝트", hint: "공개 제품·최근 글·반응 기준 통과", foot: `상위 ${TALK_LIMIT}개가 /talk 노출 대상`, href: "/admin/talk", label: "발행 조건 확인" },
    { step: "04 / 홈 대표", title: "홈 1위 확인 대기", value: data.homeWaiting, unit: "프로젝트", hint: "홈 후보 상위 20개 중 대표 승인 대기", foot: "홈 1위만 승인 · 화제 목록 발행은 별도", href: "/admin/talk#home", label: "홈 대표 결정" },
    { step: "05 / 사이트 발행", title: "화제 목록 노출", value: data.publicEnabled ? data.talkProjects : 0, unit: "프로젝트", hint: data.publicEnabled ? `홈 노출 ${number(data.homeProjects)}개` : "일반 사용자 공개 꺼짐 · 관리자 미리보기", foot: data.publicEnabled ? "현재 공개 조건을 통과한 목록" : `화제 노출 가능 ${number(data.talkProjects)}개`, href: "/admin/content?tab=social", label: "콘텐츠·노출 관리" },
  ];
  return <Panel title="SNS 수집·사이트 발행 흐름" description="SNS에서 모은 글을 프로젝트에 연결해 사이트 화제로 발행합니다. 프로젝트 자동 수집과 별도 흐름입니다." tool={<ReadStamp at={data.measuredAt} />} note="홈 대표 승인은 별도 분기입니다. 외부 SNS에 게시물을 자동 송출하는 기능은 현재 없습니다.">
    <div className="flow-social-scroll" tabIndex={0} role="region" aria-label="SNS 수집부터 사이트 발행까지 단계"><div className="flow-social-stages">{stages.map(stage => <Link prefetch={false} className="flow-social-stage" href={stage.href} key={stage.step}><small className="flow-social-step">{stage.step}</small><b>{stage.title}</b><strong className="mono">{number(stage.value)}<span>{stage.unit}</span></strong><p>{stage.hint}</p><small className="flow-social-stage-foot">{stage.foot}</small><span className="flow-social-link">{stage.label} →</span></Link>)}</div></div>
    <div className="flow-social-collectors">{data.collectors.map(source => <div className="flow-social-collector" key={source.source}><div className="flow-social-collector-head"><b>{source.label}</b><Tag tone={source.tone}>{source.status}</Tag></div><p>{source.note}</p><dl><div><dt>최근 24시간 새 글</dt><dd>{number(source.new24h)}건</dd></div><div><dt>마지막 수집 성공</dt><dd>{clock(source.lastSuccessAt)}</dd></div><div><dt>글 마지막 확인</dt><dd>{clock(source.lastSeenAt)}</dd></div></dl><Link prefetch={false} className="text-button" href={source.href}>수집·원본 확인 →</Link></div>)}</div>
  </Panel>;
}
const TALK_LIMIT = 50;

export async function SocialFlowSummary({ jobs }: { jobs: SocialFlowJobs }) {
  const data = await readSocialFlowOverview(jobs).catch(warn("flow.social_overview_unavailable"));
  return <SocialFlowView data={data} />;
}
