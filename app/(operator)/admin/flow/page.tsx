import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { authSecret, currentAdmin } from "@/lib/auth/admin";
import { listJobStates } from "@/lib/jobs/runner";
import { adminJobControlVersions } from "@/lib/operations/admin-job-control";
import { readConveyor } from "@/lib/operations/conveyor";
import { HUMAN_ASSIST_TASKS, readHumanAssistProgress } from "@/lib/operations/human-assist-progress";
import { readHumanDelegateSummary } from "@/lib/operations/human-delegate-summary";
import { jobRuntimeState, SOCIAL_FLOW_JOBS } from "@/lib/operations/flow-overview-read";
import { readFlowRankEditor } from "@/lib/operations/flow-rank-editor-read";
import { adminWorkspaceReadOnly } from "@/lib/operations/admin-workspace-preview";
import { heldReactionComments } from "@/lib/domain/reactions/review";
import { PUBLIC_TRANSLATION_JOBS, STATION_JOBS } from "@/lib/operations/flow-response";
import { logger } from "@/lib/observability/logger";
import { PageStamp } from "@/app/(operator)/admin/components/PageStamp";
import { OPS_FRESH_COOKIE } from "../status/fresh";
import { jobControlCsrf } from "../status/job-control-csrf";
import { readConsoleHome, type ConsoleHomeRead } from "@/lib/operations/console-home-read";
import { buildConsoleTasks } from "@/lib/operations/console-tasks";
import { stagePanel, type StagePanelDef } from "@/lib/operations/stage-panel-catalog";
import { buildStagePanel, previewContext, stageChanges } from "@/lib/operations/stage-panel-model";
import { readStagePanelExtra } from "@/lib/operations/stage-panel-read";
import { homeTab } from "../workspace-navigation";
import { ChangeWatch } from "./ChangeWatch";
import { StagePanel, StagePanelLoading } from "./StagePanel";
import { readOperatorAway, readOperatorChanges, readOperatorDeskShared, readOperatorDiagnostics } from "./desk";
import { ConsoleHome } from "./ConsoleHome";
import type { FlowControls } from "./FlowBoard";
import { FlowBoard } from "./FlowBoard";
import { HumanModelSettings } from "./HumanModelSettings";
import { HumanAssistDecided, HumanAssistInsight, HumanAssistTaskProgress } from "./HumanAssistProgress";
import { FLOW_DELEGATE_GROUPS, flowDelegateSlot, HumanDelegateCount } from "./HumanDelegateCounts";
import { PrototypeFlow, PrototypeFlowAway, PrototypeFlowChanges } from "./PrototypeFlow";
import type { OperatorDesk } from "@/lib/operations/operator-desk-model";
import { FlowOverviewSummary, SocialFlowSummary } from "./FlowOverview";
import "./flow.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "전체 흐름 — NoMoreVibe", robots: { index: false } };

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/** 칸마다 멈추고 다시 켤 수 있는 작업의 지금 상태 — 운영센터 작업 상세와 같은 읽기(jobs 행·작업 제어 판) */
async function readControls(admin: { login: string; exp: number }): Promise<FlowControls> {
  const names = new Set([...Object.values(STATION_JOBS).flat(), ...PUBLIC_TRANSLATION_JOBS].map((row) => row.job).concat([...SOCIAL_FLOW_JOBS]));
  const [states, versions] = await Promise.all([listJobStates(), adminJobControlVersions()]);
  const now = Date.now();
  const secret = authSecret();
  return {
    measuredAt: new Date(now).toISOString(),
    // 멈춤·이름표·잠김은 SNS 수집기 줄(콘텐츠 운영)과 같은 계산(jobRuntimeState)
    jobs: Object.fromEntries(states.filter((job) => names.has(job.name)).map((job) => [job.name, {
      ...jobRuntimeState(job, now), notBefore: job.notBefore?.toISOString() ?? null, version: versions[job.name] ?? 0,
      lastRunAt: job.lastRunAt?.toISOString() ?? null, workerSeenAt: job.workerSeenAt?.toISOString() ?? null }])),
    csrf: secret && !adminWorkspaceReadOnly() ? { token: jobControlCsrf(admin, secret), expiresAt: admin.exp } : null,
  };
}

/**
 * 운영 홈 — 기본 탭(home)은 「지금 할 일」(네 묶음) + 「흐름」 표(조각 1b, ConsoleHome) + 「바꾼 것 지켜보기」(조각 1c, ChangeWatch).
 * ?stage=<단계> 면 그 단계의 패널(조각 2a, StagePanel)이 오른쪽에 열린다 — 새로고침·공유해도 같은 패널이다. 탭 해석은 메뉴와 같은 homeTab.
 * 「흐름 상세」(tab=detail, 옛 주소 tab=flow 도 같다)는 지금까지의 전체 흐름이다 — 탐색 → 검수 → 프로필 준비 → 발행 → 공개. 검색·번역은 공개 후 별도 분기로 보인다.
 * 기존 공용 집계와 잡·역할 관측의 시각·단위를 함께 표시한다. 추가 모델 호출을 하지 않는다(홈의 24시간 장부 집계는 공유 캐시로 나눠 쓴다).
 * 그 자리의 장애 대응, 그리고 1인 관리자 필수 칸(할 일 — 경보·사람 판단·자리 비운 사이·모두 보기, 최근 바뀐 설정·장비·점검 창).
 * 이 화면이 직접 바꾸는 것은 작업 멈춤·재개(운영센터와 같은 서버 동작, 사유 필수, 작업 로그) 하나다. 나머지는 각 조치의 링크가 보내는 화면에서 한다.
 */
export default async function AdminFlowPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  const fresh = (await cookies()).has(OPS_FRESH_COOKIE);
  const params = await searchParams;
  const tab = homeTab(typeof params?.tab === "string" ? params.tab : null);
  const advanced = params?.advanced === "1";
  const stage = typeof params?.stage === "string" ? params.stage : null;
  return (
    <main className="stack pb-10 pt-4"><PageStamp />
      <h1 className="admin-vh">운영 홈 · 실시간 전체 흐름</h1>
      <Suspense fallback={<p className="notice" aria-busy="true">운영 흐름을 읽는 중…</p>}>
        {tab === "home" ? <HomeWorkspace admin={admin} fresh={fresh} stage={stage} />
          : <FlowWorkspace admin={admin} fresh={fresh} tab={tab} advanced={advanced} stage={stage} />}
      </Suspense>
    </main>
  );
}

/** 운영 홈 — 할 일 규칙의 입력을 한 번 읽어(읽기마다 따로 실패) 할 일·흐름 표를 그리고, 단계가 열려 있으면 그 패널을 붙인다 */
async function HomeWorkspace({ admin, fresh, stage }: { admin: NonNullable<Awaited<ReturnType<typeof currentAdmin>>>; fresh: boolean; stage: string | null }) {
  const def = stagePanel(stage);
  // 패널의 덧읽기는 홈 읽기와 함께 시작한다 — 패널은 따로 기다린다(Suspense), 홈을 막지 않는다
  const extraRead = def ? readStagePanelExtra(def, fresh) : null;
  const data = await readConsoleHome(fresh);
  const secret = authSecret();
  const readOnly = adminWorkspaceReadOnly();
  const csrf = secret && !readOnly ? { token: jobControlCsrf(admin, secret), expiresAt: admin.exp } : null;
  // 「바꾼 것 지켜보기」(조각 1c)는 스스로 읽고 스스로 기다린다(웹들이 나눠 쓰는 캐시)
  return <ConsoleHome data={data} csrf={csrf} changeWatch={<ChangeWatch fresh={fresh} />}
    panel={def && extraRead ? <Suspense key={def.key} fallback={<StagePanelLoading label={def.label} />}>
      <StagePanelLoaded def={def} data={data} extraRead={extraRead} csrf={csrf} readOnly={readOnly} />
    </Suspense> : undefined} />;
}

/** 단계 패널 — 홈 읽기(진행·잡·연결·순위·장비·장부)에 패널 덧읽기(멈춘 기록·degraded·순위 사정·순위 편집기·한도·바뀐 것)를 더한다 */
async function StagePanelLoaded({ def, data, extraRead, csrf, readOnly }: { def: StagePanelDef; data: ConsoleHomeRead;
  extraRead: ReturnType<typeof readStagePanelExtra>; csrf: { token: string; expiresAt: number } | null; readOnly: boolean }) {
  const extra = await extraRead;
  const board = buildConsoleTasks(data.inputs);
  const panel = buildStagePanel({ key: def.key, now: data.checkedAt, conveyor: data.conveyor, inputs: data.inputs, board, jobStates: data.jobStates,
    pauses: extra.pauses, degraded: extra.degraded, runtime: extra.runtime, executions: data.executions });
  if (!panel) return null;
  const lockReason = readOnly ? "읽기 전용 미리보기 — 여기서는 저장할 수 없습니다."
    : !data.executions ? "실행 방식을 읽지 못했습니다 — 확인할 때까지 배정을 저장할 수 없습니다." : null;
  return <StagePanel panel={panel} editor={extra.editor} context={previewContext(data.inputs)} limits={extra.limits} limitRows={extra.limitRows}
    limitImpact={extra.limitImpact} changes={extra.changes ? stageChanges(extra.changes.rows, panel) : []} changesRead={!!extra.changes}
    csrf={csrf} jobVersions={data.jobVersions} readOnly={readOnly} lockReason={lockReason} now={new Date(data.checkedAt)} />;
}

type DeskRead = Promise<OperatorDesk | null>;

async function FlowWorkspace({ admin, fresh, tab, advanced, stage }: {
  admin: NonNullable<Awaited<ReturnType<typeof currentAdmin>>>; fresh: boolean; tab: string; advanced: boolean; stage: string | null;
}) {
  if (tab === "changes") {
    const desk = await readOperatorChanges(admin.login).catch(quiet("desk.changes_unavailable"));
    return <PrototypeFlowChanges desk={desk} />;
  }
  const diagnostics = tab === "diagnostics";
  const sharedDeskRead = (diagnostics ? readOperatorDiagnostics() : readOperatorDeskShared(fresh))
    .catch(quiet("desk.unavailable"));
  // Personal history streams into its panel; it never blocks the live belt or enters shared cache.
  const fullDeskRead: DeskRead | null = diagnostics ? null : sharedDeskRead.then(async base => base
    ? { ...base, away: await readOperatorAway(admin.login, base.measuredAt) } : null);
  const [conveyor, base, control, editor, reactions] = await Promise.all([
    readConveyor(fresh).catch(quiet("conveyor.unavailable")),
    sharedDeskRead,
    readControls(admin).catch(quiet("flow.controls_unavailable")),
    diagnostics ? Promise.resolve(null) : readFlowRankEditor(),
    diagnostics ? Promise.resolve(null) : heldReactionComments(1).catch(quiet("flow.reactions_unavailable")),
  ]);
  if (!conveyor) return <p role="status" className="notice">흐름을 읽지 못했습니다 — 다음 자동 갱신에서 다시 읽습니다.</p>;
  // 사람 확인 · AI 보조 카드의 처리 현황 — 한 번 읽어 카드마다 나눠 그린다. 늦어도 흐름 화면을 막지 않는다(Suspense)
  const assistRead = diagnostics ? null : readHumanAssistProgress().catch(quiet("flow.human_assist_unavailable"));
  // 사람 몫의 AI 위임 결과(근거 부족·확신 부족) — 복제본 한 번. 늦거나 못 읽어도 흐름 화면을 막지 않는다(미확인)
  const delegateRead = diagnostics ? null : readHumanDelegateSummary(fresh).catch(quiet("flow.human_delegate_unavailable"));
  const humanAssist = assistRead && delegateRead ? {
    decided: <Suspense fallback="읽는 중…"><HumanAssistDecided read={assistRead} /></Suspense>,
    insight: <Suspense fallback={null}><HumanAssistInsight read={assistRead} /></Suspense>,
    ...Object.fromEntries(HUMAN_ASSIST_TASKS.map(task => [task,
      <Suspense key={task} fallback={<span className="flow-model-note" aria-busy="true">처리 현황을 읽는 중…</span>}><HumanAssistTaskProgress read={assistRead} task={task} /></Suspense>])),
    ...Object.fromEntries(FLOW_DELEGATE_GROUPS.map(group => [flowDelegateSlot(group),
      <Suspense key={group} fallback="읽는 중…"><HumanDelegateCount read={delegateRead} group={group} /></Suspense>])),
  } : undefined;
  const desk: OperatorDesk | null = base ? { ...base, away: null } : null;
  const controls = control ?? { jobs: {}, csrf: null };
  const advancedContent = diagnostics && !advanced
    ? <><p className="small muted">전체 업무·장비·변경 기록과 모델 순위를 포함한 기존 고급 화면입니다.</p><Link prefetch={false} className="button mt" href="/admin/flow?tab=diagnostics&advanced=1#flow-advanced">고급 전체 흐름 불러오기 →</Link></>
    : <Suspense fallback={<p className="small muted" aria-busy="true">고급 운영 관측을 읽는 중…</p>}>
        <AdvancedFlow data={conveyor} controls={controls} deskRead={fullDeskRead} editor={editor} readRanks={diagnostics} login={admin.login} fresh={fresh} />
      </Suspense>;
  return <PrototypeFlow initialStage={stage} humanModelSettings={!diagnostics ? <Suspense fallback={<p className="small muted" aria-busy="true">AI 보조 모델 설정을 읽는 중…</p>}><HumanModelSettings /></Suspense> : undefined} data={conveyor} desk={desk} controls={controls} editor={editor} tab={tab} humanAssist={humanAssist}
    reactionRequests={reactions?.count ?? null} advancedContent={advancedContent}
    overviewContent={!diagnostics ? <Suspense fallback={<p className="notice" aria-busy="true">프로젝트 등록 수와 발행 추이를 읽는 중…</p>}>
      <FlowOverviewSummary data={conveyor} desk={desk} reactionRequests={reactions?.count ?? null} />
    </Suspense> : undefined}
    socialContent={!diagnostics ? <Suspense fallback={<p className="notice" aria-busy="true">SNS 수집·사이트 발행 흐름을 읽는 중…</p>}>
      <SocialFlowSummary jobs={controls.jobs} />
    </Suspense> : undefined}
    awayContent={fullDeskRead ? <Suspense fallback={<p className="small muted" aria-busy="true">부재 중 기록을 읽는 중…</p>}><AwayPanel deskRead={fullDeskRead} /></Suspense> : undefined} />;
}

async function AwayPanel({ deskRead }: { deskRead: DeskRead }) {
  return <PrototypeFlowAway desk={await deskRead} />;
}

async function AdvancedFlow({ data, controls, deskRead, editor, readRanks, login, fresh }: {
  data: Awaited<ReturnType<typeof readConveyor>>; controls: FlowControls; deskRead: DeskRead | null;
  editor: Awaited<ReturnType<typeof readFlowRankEditor>>; readRanks: boolean; login: string; fresh: boolean;
}) {
  const [desk, ranks] = await Promise.all([
    deskRead ?? readOperatorDeskShared(fresh).then(async base => ({ ...base, away: await readOperatorAway(login, base.measuredAt) })).catch(quiet("desk.unavailable")),
    readRanks ? readFlowRankEditor() : Promise.resolve(editor),
  ]);
  return <FlowBoard data={data} desk={desk} controls={controls} editor={ranks} />;
}
