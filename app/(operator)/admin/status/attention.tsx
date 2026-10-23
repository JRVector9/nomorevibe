import { Fragment } from "react";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { listJobStates } from "@/lib/jobs/runner";
import { readJobBatchMode } from "@/lib/jobs/batch-repository";
import { isPausedJob } from "@/lib/jobs/status";
import { downProductCount, DOWN_THRESHOLD } from "@/lib/domain/products/health";
import { getEvidenceStatusSummary } from "@/lib/domain/evidence/admin";
import { operationsData } from "@/lib/operations/admin";
import { readSettingsApply, type SettingsApply } from "@/lib/operations/settings-apply";
import { latestServiceInstance } from "@/lib/operations/instance";
import { pipelineThroughput } from "@/lib/operations/throughput";
import { buildWorkerProgress } from "@/lib/operations/worker-progress-query";
import { attentionCounts, modelHealth } from "@/lib/operations/dashboard";
import { roleOverview } from "@/lib/operations/roles";
import { FAILOVER_ROLES } from "@/lib/operations/failover-readiness";
import { JOB_LABELS, ROLE_LABELS, type AgentStatus } from "@/lib/operations/contracts";
import { readSearchHealth, searchHealthAlerts } from "@/lib/operations/search-health-model";
import { modelServerHealth } from "@/lib/operations/model-servers";
import { attentionBaseline, BACKLOG_KEYS, BADGED_HOLD_KEYS, recordAttentionSample, type AttentionAck, type AttentionSample } from "@/lib/operations/attention";
import { completedLiveRun, parseXStatusRuns, readXStatus, X_STATUS_RUNS_KEY, X_STATUS_STALE_HOURS } from "@/lib/operations/x-status";
import { X_POSTS_KEY } from "@/lib/operations/x-posts";
import { jobHealthIssues, jobsNeedingDeferralReason, type JobHealthIssue } from "@/lib/operations/job-health";
import { readLastJobDeferrals } from "@/lib/jobs/deferral-observation";
import { emailHealth, emailOutboxLevel, loginEmailLevel } from "@/lib/operations/email-health";
import { QWEN_ENDPOINT_OBSERVATION } from "@/lib/crawl/qwen-endpoint-backoff";
import { qwenDirectServerLabel } from "@/lib/crawl/qwen-direct-review";
import { RANKING_STALE_MS } from "@/lib/domain/ranking/view";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { formatWait, isBurst } from "@/lib/domain/products/takedown-view";
import { listGitHubCollectorAccounts, parseCoreQuota } from "@/lib/crawl/github-accounts";
import { listGitHubCollectorApps } from "@/lib/crawl/github-apps";
import { getSettings } from "@/lib/crawl/settings";
import { sharedHumanQueueOverview } from "@/lib/operations/shared-reads";
import { sharedStore } from "@/lib/cache/shared";
import { sharedStale } from "@/lib/operations/shared-cache";
import { humanFlowLabel, humanWaitLabel, type HumanQueueOverview } from "@/lib/crawl/human-queue";
import { recentSecondReviewFailures } from "@/lib/crawl/second-review";
import { SPAM_DETECTOR_VERSION } from "@/lib/crawl/spam-signals";
import { MAX_AUTO_BANS_PER_DAY } from "@/lib/jobs/products/spam-rescan";
import { formatListTime } from "@/lib/format/time";
import { logger } from "@/lib/observability/logger";
import { ACTION_LINKS, jobHref } from "./action-links";
import { REPO_COVERAGE_TARGET, REPO_REVIEW_OVERDUE_HOURS } from "./dashboard/RepoHealthCard";
import { sortActions, type ActionItem, type SplitItem } from "./dashboard/AttentionList";
import { modelName } from "./dashboard/ModelCards";
import { MODEL_HEALTH_JOBS, progressStageJobs, type ActionWork } from "./work-owners";
import { EXPECTED_WEB_INSTANCES, READINESS_LABELS, webSummary, type CollectorQuotaStatus } from "./status-summary";
import { readAssistQueueStatus } from "@/lib/operations/llm-assist";

/**
 * 조치할 일 — 무엇을 읽어(loadActionInputs) 어떤 줄을 세우는지(buildActions), 그 줄을 "지금 조치"와 "쌓인 일"로 나누는 것(splitActions).
 *
 * 운영센터 화면과 메뉴의 긴급 배지(criticalActionCount)가 같은 함수로 센다 — 전에는 page.tsx 안에만 있었다.
 */

export type ActionInputs = {
  settings: CrawlSettings;
  /** 워커마다 지금 저장된 크롤 설정 판으로 도는지(ADM-19) — 못 읽으면 null */
  settingsApply: SettingsApply | null;
  ops: Awaited<ReturnType<typeof operationsData>>;
  jobStates: Awaited<ReturnType<typeof listJobStates>>;
  /** 지금 batch 상태 — versioned 전용 잡(Oracle 분리 역할)을 일정·목록에서 가른다 */
  jobBatch: Awaited<ReturnType<typeof readJobBatchMode>>;
  evidenceSummary: Awaited<ReturnType<typeof getEvidenceStatusSummary>>;
  downCount: number;
  overview: HumanQueueOverview;
  secondFailures: Awaited<ReturnType<typeof recentSecondReviewFailures>>;
  throughput: Awaited<ReturnType<typeof pipelineThroughput>> | null;
  models: Awaited<ReturnType<typeof modelHealth>> | null;
  attention: Awaited<ReturnType<typeof attentionCounts>> | null;
  roles: Awaited<ReturnType<typeof roleOverview>> | null;
  accounts: Awaited<ReturnType<typeof listGitHubCollectorAccounts>> | null;
  apps: Awaited<ReturnType<typeof listGitHubCollectorApps>> | null;
  takedowns: Awaited<ReturnType<typeof takedownSummary>> | null;
  modelServers: Awaited<ReturnType<typeof modelServerHealth>> | null;
  /**
   * 30분 넘게 성공하지 못한 잡의 마지막 미룸 까닭(defer:<job>) — 일부러 미룬 잡을 고장으로 부르지 않게(job-health.ts).
   * 못 읽었으면 null — 그때는 까닭 모를 성공 끊김을 경보하지 않는다. 없으면(옛 입력) null 과 같다
   */
  jobDeferrals?: Awaited<ReturnType<typeof readLastJobDeferrals>> | null;
  /** 알림 메일 발송함·로그인 코드 메일의 최근 결과(email-health.ts) — 못 읽었으면 null */
  email?: Awaited<ReturnType<typeof emailHealth>> | null;
  assistQueue?: Awaited<ReturnType<typeof readAssistQueueStatus>> | null;
};

/** 한 묶음이 실패해도 화면은 나가야 한다 — 그 칸만 비운다 */
const warn = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};

/** 조치할 일과 머리말 칩이 읽는 것 — 서로 기다릴 까닭이 없어 한꺼번에 띄운다 */
export async function loadActionInputs(settings: CrawlSettings): Promise<ActionInputs> {
  const jobStatesRead = listJobStates();
  // 성공이 30분 넘게 끊긴 잡만 미룸 까닭을 묻는다(열쇠 몇 개 — 평소에는 묻지 않는다)
  const jobDeferralsRead = jobStatesRead.then((states) => readLastJobDeferrals(jobsNeedingDeferralReason(states, new Date())))
    .catch(warn("operations.job_deferrals_unavailable"));
  const [ops, jobStates, jobBatch, evidenceSummary, downCount, overview, secondFailures, throughput, models, attention, roles, accounts, apps, takedowns, modelServers, settingsApply, jobDeferrals, email, assistQueue] = await Promise.all([
    operationsData(), jobStatesRead, readJobBatchMode(), getEvidenceStatusSummary(new Date()), downProductCount(),
    // 사람 몫의 수(직접 판단·확정만·나이·24시간 흐름)는 심사 큐와 같은 humanQueueOverview 하나에서 온다
    // 사람 몫은 웹 여러 대·화면 여러 개가 30초 나눠 쓴다(shared-reads.ts) — 메뉴 배지도 이 읽기를 거친다
    sharedHumanQueueOverview(settings), recentSecondReviewFailures(),
    pipelineThroughput(settings).catch(warn("operations.throughput_unavailable")),
    modelHealth(settings).catch(warn("operations.models_unavailable")),
    attentionCounts().catch(warn("operations.attention_unavailable")),
    roleOverview().catch(warn("operations.roles_unavailable")),
    listGitHubCollectorAccounts().catch(warn("operations.accounts_unavailable")),
    listGitHubCollectorApps().catch(warn("operations.apps_unavailable")),
    takedownSummary().catch(warn("operations.takedowns_unavailable")),
    modelServerHealth().catch(warn("operations.model_servers_unavailable")),
    readSettingsApply().catch(warn("operations.settings_apply_unavailable")),
    jobDeferralsRead,
    emailHealth().catch(warn("operations.email_health_unavailable")),
    readAssistQueueStatus().catch(warn("operations.assist_queue_unavailable")),
  ]);
  return { settings, settingsApply, ops, jobStates, jobBatch, evidenceSummary, downCount, overview, secondFailures, throughput, models, attention, roles, accounts, apps, takedowns, modelServers, jobDeferrals, email, assistQueue };
}

const LEGACY_BATCH = { mode: "legacy", writerContractVersion: 0 } as const;
const asDate = (value: Date | string | null | undefined) => value ? new Date(value) : null;
/**
 * 잡마다 진짜 성공이 끊겼거나 제 일 못 한 틱이 이어지는지(lib/operations/job-health.ts) — 조치할 일과 작업 띠가 같은 판단을 쓴다.
 * 워커·스케줄러 관측이 끊긴 역할은 그 경보가 먼저 말하므로 뺀다.
 */
export function deriveJobHealth(inputs: ActionInputs, workerProgress: DerivedStatus["workerProgress"] | null): JobHealthIssue[] {
  const silentRoles = new Set<string>((workerProgress?.liveness ?? []).filter((row) => row.alarm).map((row) => row.role));
  return jobHealthIssues({
    jobs: inputs.jobStates.map((row) => ({ name: row.name, lastRunAt: asDate(row.lastRunAt), lastSuccessAt: asDate(row.lastSuccessAt),
      lastError: row.lastError, notBefore: asDate(row.notBefore), runs: typeof row.runs === "number" ? row.runs : 0 })),
    observations: inputs.ops.observations, deferrals: inputs.jobDeferrals ?? null, batch: inputs.jobBatch ?? LEGACY_BATCH,
    silentRoles, now: new Date(inputs.ops.fetchedAt),
  });
}

/** 잡 하나의 "제 일 못 함·성공 끊김" 한 줄 — 까닭 코드는 그대로(고칠 때 찾을 말), 설명은 처리기가 적은 짧은 글 */
function jobHealthLine(issue: JobHealthIssue, now: string) {
  const degraded = issue.degraded;
  return <>{job(issue.job)} {degraded
    ? <>제 일 못 함 <span className="font-mono">{degraded.code}</span>{degraded.detail ? `(${degraded.detail})` : ""} 연속 {n(degraded.streak)}회</>
    : "성공 없음"} · 마지막 성공 {formatListTime(issue.lastSuccessAt, now, "없음")}{issue.deferral ? <> · 마지막 미룸 <span className="font-mono">{issue.deferral.reason}</span></> : null}</>;
}
/** 처리기의 제 일 못 함 중 따로 세운 조치가 맡는 것 — 작업 묶음 줄에 겹쳐 세우지 않는다 */
const DEDICATED_DEGRADED = (issue: JobHealthIssue) => issue.kind === "degraded"
  && ((issue.job === "uptime-ping" && issue.degraded?.code === "broad_failure_held") || issue.job === "email-outbox-send");
const maxTone = (...tones: ("hold" | "critical" | null | undefined)[]) =>
  tones.includes("critical") ? "critical" as const : tones.includes("hold") ? "hold" as const : null;
/** 보류에서 긴급까지 — job-health.ts 의 JOB_ESCALATE_FACTOR 와 같은 4배 */
const ESCALATE = 4;
/** Qwen 직접 서버 물러나기 — 1분에서 두 배씩 15분까지라 n번째 탈 전까지 누적은 Σ min(15, 2^(k-1))분: 6번째 = 30분, 12번째 = 2시간 */
const QWEN_HOLD_FAILURES = 6;
const QWEN_CRITICAL_FAILURES = 12;
/** X 하루 보고 — 하루 한 번이라 3일(보고 세 번)을 넘기면 긴급, 후보 0 은 이틀(두 번)이면 보류·그 4배면 긴급 */
const X_CRITICAL_HOURS = 72;
const X_ZERO_HOLD_RUNS = 2;

/** 조치할 일과 화면 조각이 함께 쓰는 판단 — 웹 인스턴스, 워커 진행, 검색 점검, GitHub 한도, AI 연결 */
export function deriveStatus(inputs: ActionInputs) {
  const { ops, jobStates, throughput } = inputs;
  const fetchedAt = Date.parse(ops.fetchedAt);
  const ageMs = (at: string | Date) => fetchedAt - new Date(at).getTime();
  const states = new Map(jobStates.map((job) => [job.name, job]));
  const agentInstance = latestServiceInstance(ops.serviceInstances, "connect-agent");
  // 두 관측 ID 는 웹 사이트 두 곳이다. 같은 ID 를 쓰는 개별 복제본의 health probe 는 아니다.
  const web = EXPECTED_WEB_INSTANCES.map((id) => {
    const instance = latestServiceInstance(ops.serviceInstances.filter((row) => row.instanceId === id), "app");
    const age = instance ? ageMs(instance.observedAt) : Number.NaN;
    return { instance: id, release: typeof instance?.value.release === "string" ? instance.value.release : null,
      observedAt: instance?.observedAt ?? null, stale: !Number.isFinite(age) || age < -5_000 || age > 45_000 };
  });
  const healthObservation = ops.observations.find((row) => row.key === "job:product-search-health");
  const health = states.get("product-search-health")?.lastError ? null : readSearchHealth(healthObservation);
  const quota: CollectorQuotaStatus = { readFailed: !inputs.accounts || !inputs.apps, sources: [
    ...(inputs.accounts ?? []).filter((row) => row.enabled).map((row) => ({ ...row, label: `PAT ${row.login}` })),
    ...(inputs.apps ?? []).filter((row) => row.enabled).map((row) => ({ ...row, label: `App ${row.appSlug} · 설치 ${row.installationId}` })),
  ].map((row) => {
    const value = parseCoreQuota(row.coreQuota);
    const age = row.quotaObservedAt ? ageMs(row.quotaObservedAt) : Number.NaN;
    return { label: row.label, quota: value, observedAt: row.quotaObservedAt?.toISOString() ?? null,
      stale: !value || !Number.isFinite(age) || age < -5_000 || age > 3_600_000 || value.reset * 1000 <= fetchedAt };
  }) };
  return {
    ageMs, states, web, healthObservation, health, quota, agentInstance,
    agent: agentInstance?.value as AgentStatus | undefined,
    workerProgress: throughput ? buildWorkerProgress(throughput, jobStates, ops.observations, new Date(ops.fetchedAt), inputs.jobBatch) : null,
  };
}

export type DerivedStatus = ReturnType<typeof deriveStatus>;

const n = (value: number) => value.toLocaleString("ko-KR");
/** 사람이 읽는 작업 이름 — 코드는 툴팁으로만(ADM-28) */
const job = (name: string) => <span title={name}>{JOB_LABELS[name] ?? name}</span>;
const role = (name: string) => <span title={name}>{ROLE_LABELS[name] ?? name}</span>;
const joined = (nodes: React.ReactNode[], separator = ", ") =>
  nodes.map((node, index) => <Fragment key={index}>{index > 0 && separator}{node}</Fragment>);
/** 칸마다 이 일을 맡는 작업·서비스(work-owners.ts) — 같은 일을 하는 칸끼리 같은 묶음을 쓴다 */
const AI_WORK: ActionWork = { jobs: ["crawl-publish"], services: ["connect-agent"] };
const SEARCH_WORK: ActionWork = { jobs: ["product-search-health", "product-search-profile", "product-search-verify"] };
const UPTIME_WORK: ActionWork = { jobs: ["uptime-ping"] };
const AUDIT_WORK: ActionWork = { jobs: ["product-audit"] };
const X_WORK: ActionWork = { services: ["x-collector"] };

/**
 * 지금 사람이 손대야 하는 것.
 *
 * 막고 있는 순서대로 놓는다 — AI 연결이 끊겨 있으면 심사 큐가 쌓이는 것은 결과이지
 * 원인이 아니다. 원인을 위에 두어야 아래가 저절로 풀린다. 급(critical → hold)은 sortActions 가 앞세운다.
 * 숫자 칸에는 단위(unit)를 단다 — 건·%·회가 한 칸에 섞여 크기를 견줄 수 없었다(ADM-08). 숫자가 아닌 것은 "상태".
 */
export function buildActions(inputs: ActionInputs, derived: DerivedStatus): ActionItem[] {
  const { ops, jobStates, evidenceSummary, downCount, overview, secondFailures, throughput, models, attention, roles, takedowns, modelServers } = inputs;
  const { ageMs, states, web, healthObservation, health, quota, agent, agentInstance, workerProgress } = derived;
  const now = ops.fetchedAt;
  const failedJobs = jobStates.filter((row) => row.lastError);
  const healthIssues = deriveJobHealth(inputs, workerProgress);
  const actions: ActionItem[] = [];
  const assist = inputs.assistQueue;
  if (assist === null) actions.push({ key: "assist-unknown", tone: "hold", count: "미확인", unit: "상태",
    title: "LLM 보강 큐를 읽지 못했습니다", detail: "조회 실패는 대기 0건이나 모델 종료를 뜻하지 않습니다.", work: { jobs: ["product-llm-assist-review"] } });
  if (assist?.length) {
    const assistJobs = [...new Set(assist.flatMap(row => [
      ["decision_audit", "semantic_exception"].includes(row.task) ? "product-llm-assist-audit-review" : "product-llm-assist-review",
      ...(row.originJob ? [row.originJob] : []),
    ]))];
    const sum = (states: string[]) => assist.filter(row => states.includes(row.state)).reduce((total, row) => total + row.count, 0);
    const unknown = sum(["indeterminate"]), human = sum(["human", "waiting_evidence"]), capacity = sum(["waiting_capacity"]);
    const stopped = assist.filter(row => row.confirmationRequired && (!row.dispatchEnabled || !row.applyEnabled))
      .reduce((total, row) => total + row.count, 0);
    for (const [key, count, title, detail] of [
      ["assist-indeterminate", unknown, "보강 호출의 정산을 확인해야 합니다", "원격 종료나 결과 기록이 불명확한 작업을 보존 중입니다. 시간 경과만으로 모델 슬롯을 해제하지 않습니다."],
      ["assist-human", human, "보강 근거·사람 확인을 기다립니다", "수집 실패·접근 차단·잘못된 출력·의미 충돌은 자동 내림으로 대체하지 않습니다."],
      ["assist-stopped", stopped, "LLM 확인 후보가 보류 중입니다", "확인 소비나 적용이 꺼져 있습니다. 확인이 필수인 후보는 기존 즉시 내림으로 돌아가지 않습니다."],
      ["assist-capacity", capacity, "보강 모델 수용량을 기다립니다", "다른 작업과 공유하는 물리 한도로 대기 중이며, 용량 대기는 모델 실패 시도에 포함하지 않습니다."],
    ] as const) if (count) actions.push({ key, tone: "hold", count, unit: "건", title, detail,
      action: { label: "보강 소비자", href: jobHref(assistJobs[0]) }, work: { jobs: assistJobs } });
  }
  const unavailable = [[roles, "roles", "역할·예비", ACTION_LINKS.roles], [models, "models", "모델", ACTION_LINKS.models],
    [throughput, "throughput", "저장 진행", ACTION_LINKS.jobs], [attention, "attention", "제품 운영 집계", ACTION_LINKS.jobs]] as const;
  for (const [value, key, label, href] of unavailable) if (value === null) {
    actions.push({ key: `${key}-unknown`, tone: "hold", count: "미확인", unit: "상태", title: `${label} 상태를 읽지 못했습니다`,
      detail: "조회 실패는 정상이나 대기 0건을 뜻하지 않습니다. 새로고침 뒤에도 계속되면 DB·서비스 로그를 확인합니다.",
      action: { label: "상태 확인", href } });
  }
  const webState = webSummary(web);
  if (!webState.ready) actions.push({ key: "web", tone: "hold", count: "확인 필요", unit: "상태", title: webState.label,
    detail: "M3·mini 웹의 두 관측 ID와 45초 이내 시각·릴리스를 확인합니다. 개별 웹 복제본 상태는 Dokploy에서 확인합니다.",
    action: { label: "웹 관측", href: ACTION_LINKS.roles }, work: { services: ["web"] } });
  if (health) {
    actions.push(...searchHealthAlerts(health).map((alert) => ({ ...alert, unit: "건", key: `search-${alert.key}`,
      action: { label: "점검 작업", href: ACTION_LINKS.jobs }, work: SEARCH_WORK })));
  }

  /**
   * AI 연결(connect-agent)은 발행 워커의 카테고리 분류만 맡는다 — 1차·2차 심사는 게이트웨이로 간다.
   * 2026-10-07 Codex 가 access_denied 인데 Claude 예비가 분류를 이어 받아 화면에 아무 경보도 없었다.
   * 그 뒤 재로그인하자 적용 전까지 분류가 통째로 막혔는데, 제목은 "연결돼 있지 않습니다"였다.
   */
  const ACCOUNT_FAILURES = new Set(["access_denied", "auth", "rate_limit", "no_cli"]);
  const providerName = { codex: "Codex", claude: "Claude" } as const;
  const configuredProviders = agent ? [...new Set([agent.config?.primary, agent.config?.fallback]
    .flatMap((model) => model ? [model.model === "sonnet" ? "claude" as const : "codex" as const] : []))] : [];
  const failingProviders = configuredProviders.filter((provider) => ACCOUNT_FAILURES.has(agent?.accounts?.[provider]?.result ?? ""));
  // 옛 연결 서비스는 classifyReady 를 보내지 않는다 — 그때는 적용 전 분류를 거부하므로 configReady 가 곧 분류 가능 여부다
  const classifyReady = agent?.classifyReady ?? agent?.configReady === true;
  if (!agent || !agentInstance || ageMs(agentInstance.observedAt) > 2 * 60_000) {
    actions.push({
      key: "ai", tone: "critical", count: "끊김", unit: "상태", title: "AI 연결 서비스 관측이 끊겼습니다",
      detail: <>{role("connect-agent")} 마지막 관측 {agentInstance ? formatListTime(agentInstance.observedAt, now) : "없음"} — 발행 워커가 카테고리를 정하지 못해 승인 후보를 1시간씩 보류합니다.</>,
      action: { label: "연결 상태", href: ACTION_LINKS.ai }, work: AI_WORK,
    });
  } else if (!classifyReady) {
    actions.push({
      key: "ai", tone: "critical", count: "멈춤", unit: "상태", title: "AI 분류를 받지 않습니다",
      detail: <>{agent.configVersion > 0 ? "새 인증 뒤 모델 검사·적용이 남았습니다" : "적용한 모델 설정이 없습니다"} — 적용할 때까지 발행 워커가 승인 후보를 1시간씩 보류합니다.</>,
      action: { label: "검사·적용", href: ACTION_LINKS.ai }, work: AI_WORK,
    });
  } else {
    if (failingProviders.length > 0) {
      const all = failingProviders.length === configuredProviders.length;
      actions.push({
        key: "ai-account", tone: all ? "critical" : "hold", count: `${failingProviders.length}/${configuredProviders.length}`, unit: "계정",
        title: all ? "설정한 AI 계정이 모두 실패합니다" : `${failingProviders.map((provider) => providerName[provider]).join("·")} 계정이 실패합니다 — 예비 모델이 대신 분류 중`,
        detail: <>{failingProviders.map((provider) => `${providerName[provider]} ${agent.accounts?.[provider]?.result}${agent.accounts?.[provider]?.checkedAt ? ` · ${formatListTime(agent.accounts[provider]!.checkedAt!, now)}` : ""}`).join(" · ")} — 다시 인증하고 모델을 검사·적용합니다.</>,
        action: { label: "다시 인증", href: ACTION_LINKS.ai }, work: AI_WORK,
      });
    }
    if (!agent.configReady) {
      actions.push({
        key: "ai-apply", tone: "hold", count: "대기", unit: "상태", title: "새 인증으로 모델 검사·적용이 남았습니다",
        detail: <>그때까지 기존 설정({agent.config?.primary.model}{agent.config?.fallback ? ` → ${agent.config.fallback.model}` : ""})으로 분류를 계속합니다.</>,
        action: { label: "검사·적용", href: ACTION_LINKS.ai }, work: AI_WORK,
      });
    }
  }
  const unhealthyServers = modelServers?.filter((server) => !server.ok) ?? [];
  if (unhealthyServers.length > 0) {
    actions.push({
      key: "model-servers", tone: "hold", count: unhealthyServers.length, unit: "대", title: "검색 모델 서버가 응답하지 않습니다",
      detail: <>{unhealthyServers.map((server) => `${server.name} ${server.error}`).join(" · ")} — 검색은 단어 검색으로만 나가고, 새 제품의 의미 검색 벡터가 밀립니다(M3 launchd bot.brut.nmv-*).</>,
      action: { label: "의미 검색 벡터", href: jobHref("product-embedding") }, work: { jobs: ["product-embedding"] },
    });
  }
  if (!health) {
    actions.push({
      key: "search-health-missing", tone: "hold", count: "모름", unit: "상태", title: "검색 데이터 점검 결과가 없습니다", work: { jobs: ["product-search-health"] },
      detail: <>{states.get("product-search-health")?.lastError ? "점검 작업이 마지막 회차에 실패했습니다" : `마지막 점검 ${healthObservation ? formatListTime(healthObservation.observedAt, now) : "없음"} — 45분이 지나면 결과를 믿지 않습니다`}. 키워드 대기 수도 알 수 없습니다.</>,
      action: { label: "점검 작업", href: ACTION_LINKS.jobs },
    });
  }
  if (failedJobs.length > 0) {
    actions.push({
      key: "jobs", tone: "critical", count: failedJobs.length, unit: "개", title: "마지막 회차가 실패한 작업",
      detail: <>{joined(failedJobs.map((row) => job(row.name)))} — 실패한 작업 뒤의 단계는 새 일감을 받지 못합니다.</>,
      action: { label: "작업 흐름", href: failedJobs.length === 1 ? jobHref(failedJobs[0].name) : ACTION_LINKS.jobs }, work: { jobs: failedJobs.map((row) => row.name) },
    });
  }
  /**
   * 돌기는 하는데 제 일을 못 하는 작업(job-health.ts) — 던지지 않고 실패를 삼키거나(검색 실패·키 없음·서버 없음), 미루기만 하며 성공하지 못한다.
   * 전에는 lastRunAt 만 보고 초록이었다. 보류: 성공이 주기 6번(최소 30분) 넘게 끊김 또는 제 일 못 함이 잇달아 2번(최소 30분어치), 긴급: 그 4배.
   */
  const jobIssues = healthIssues.filter((issue) => !DEDICATED_DEGRADED(issue));
  if (jobIssues.length > 0) {
    const critical = jobIssues.some((issue) => issue.level === "critical");
    actions.push({
      key: "job-health", tone: critical ? "critical" : "hold", count: jobIssues.length, unit: "개",
      title: critical ? "작업이 오래 제 일을 하지 못합니다" : "돌기는 하는데 제 일을 하지 못하는 작업",
      detail: <>{joined(jobIssues.map((issue) => jobHealthLine(issue, now)), " · ")} — 실행은 됐지만 성공으로 세지 않았습니다. 까닭 코드로 설정·키·바깥 서버를 확인합니다.</>,
      action: { label: "작업 흐름", href: jobIssues.length === 1 ? jobHref(jobIssues[0].job) : ACTION_LINKS.jobs }, work: { jobs: jobIssues.map((issue) => issue.job) },
    });
  }
  /**
   * 사람 몫 — 심사 큐의 "직접 판단"·"확정만 하면 됨"과 같은 수(humanQueueOverview). 전에는 보류 전체(AI·2차 대기 포함)를
   * "사람이 가려야 할 후보"로, 보류가 아닌 후보까지 센 2차 칩 합을 "2차 심사 확인"으로 보여 심사 큐와 숫자가 갈렸다.
   */
  if (overview.stages.human > 0) {
    actions.push({
      key: "review", tone: "hold", count: overview.stages.human, unit: "건", title: "사람이 가려야 할 후보 — 직접 판단",
      detail: <>
        {humanWaitLabel(overview)} · {humanFlowLabel(overview)}.
        {(overview.wait?.stalled ?? 0) > 0 && <> 그중 <span className="font-mono">{n(overview.wait!.stalled)}건</span>은 판정한 지 2주가 넘었습니다 — 갈래별로 묶으면 한 번에 처리할 수 있습니다.</>}
      </>,
      action: { label: "심사 큐", href: ACTION_LINKS.reviewHuman }, work: { jobs: ["crawl-agent-review", "second-review", "human-deepseek-review"] },
    });
  }
  if (overview.stages.agreed + overview.secondPublished > 0) {
    actions.push({
      key: "second", tone: "hold", count: overview.stages.agreed + overview.secondPublished, unit: "건", title: "2차 심사 확인",
      detail: <>확정만 하면 됨 {n(overview.stages.agreed)}건(거부 {n(overview.agreed.reject)} · 승인 {n(overview.agreed.approve)}, 그중 만장일치 {n(overview.second.unanimous_reject + overview.second.unanimous_approve)})은 한 번에 확정 · 공개분 {n(overview.secondPublished)}건은 사람이 봅니다. 엇갈린 것은 직접 판단에 들어 있습니다.</>,
      // 비어 있는 구간을 열지 않는다 — 할 일이 있다고 해 놓고 빈 화면을 주면 신뢰를 잃는다
      action: { label: "2차 심사", href: overview.stages.agreed > 0 ? ACTION_LINKS.reviewAgreed : ACTION_LINKS.reviewPublished }, work: { jobs: ["second-review"] },
    });
  }
  /**
   * 2차가 실패하고 있으면 대기 수만 보여 줘선 안 된다.
   *
   * 게이트웨이는 모델 목록이 예고 없이 바뀌어, 없는 모델을 적어 두면 매 틱 404 로 끝난다 —
   * 화면에는 "대기 N건"만 늘어나 멈춘 줄 모른다. 어느 모델이 무슨 까닭으로 실패했는지 적는다.
   */
  if (secondFailures.length > 0) {
    const total = secondFailures.reduce((sum, row) => sum + row.count, 0);
    const gone = secondFailures.some((row) => row.errorCode === "model_unavailable" || row.errorCode === "not_configured");
    actions.push({
      key: "second-failed", tone: gone ? "critical" : "hold", count: total, unit: "건", title: "2차 심사가 실패하고 있습니다",
      detail: <>
        최근 24시간 미해결 오류 · {secondFailures.slice(0, 3).map((row) => `${row.model ? modelName(row.model) : "모델 미상"} ${row.errorCode} ${row.count}건`).join(" · ")}
        {gone && <> — 설정한 모델을 게이트웨이가 더 이상 갖고 있지 않습니다.</>}
      </>,
      action: { label: "2차 심사 설정", href: ACTION_LINKS.secondSettings }, work: { jobs: ["second-review"] },
    });
  }
  if (ops.held > 0) {
    actions.push({
      key: "held", tone: "hold", count: ops.held, unit: "건", title: "분류를 못 정해 발행이 멈춘 후보",
      detail: <>승인은 끝났고 카테고리만 없습니다. 1시간 뒤 저절로 다시 분류합니다{ops.heldNextRetryAt ? ` — 다음 ${formatListTime(ops.heldNextRetryAt, now)}` : ""}. 급하면 수동으로 지정합니다.</>,
      action: { label: "수동 분류", href: ACTION_LINKS.manual }, work: AI_WORK,
    });
  }
  if (downCount > 0) {
    actions.push({
      key: "down", tone: "critical", count: downCount, unit: "건", title: "응답하지 않는 공개 제품",
      detail: <>{DOWN_THRESHOLD}회 넘게 연속으로 실패해 공개 목록에서 빠져 있습니다. 지우거나 차단하지는 않습니다 — 다시 열리면 그대로 돌아옵니다. 끝난 서비스인지는 사람이 보고 정합니다.</>,
      action: { label: "응답 없음 목록", href: ACTION_LINKS.productsDown }, work: UPTIME_WORK,
    });
  }
  /**
   * 생존 확인의 광역 실패 보류(uptime.ts) — 한 회차의 30% 넘게 실패하면 이 서버 쪽 문제로 보고 세지 않고 확인 시각만 넘긴다.
   * 그래서 M3 네트워크가 오래 끊겨도 "응답 없음"·"생존 확인 밀림"은 0 으로 남았다. 보류가 잇달아 이어지면(30분어치) 올리고 그 4배면 긴급.
   */
  const uptimeHeld = healthIssues.find((issue) => issue.job === "uptime-ping" && issue.kind === "degraded" && issue.degraded?.code === "broad_failure_held");
  if (uptimeHeld?.degraded) {
    actions.push({
      key: "uptime-held", tone: uptimeHeld.level, count: uptimeHeld.degraded.streak, unit: "회", title: "생존 확인이 광역 실패로 판정을 보류하고 있습니다",
      detail: <>{job("uptime-ping")} 회차가 잇달아 {n(uptimeHeld.degraded.streak)}번 30% 넘게 실패해 이 서버 쪽 문제로 보고 세지 않았습니다(시작 {formatListTime(uptimeHeld.degraded.since, now)}{uptimeHeld.degraded.detail ? ` · 마지막 ${uptimeHeld.degraded.detail}` : ""}).
        {" "}그동안 응답 없음·생존 확인 밀림 수는 0 으로 보입니다 — 확인하는 서버(M3)의 네트워크·DNS·IP 평판을 확인합니다.</>,
      action: { label: "응답 점검 작업", href: jobHref("uptime-ping") }, work: UPTIME_WORK,
    });
  }
  /**
   * 역할·워커·모델·한도 — 전에는 스크립트와 접힌 표에만 있던 것들. 예비가 일하면 주가 죽은 것과 같은 무게로 올린다.
   */
  const standbyActive = roles?.roles.filter((row) => row.reason === "standby_active") ?? [];
  if (standbyActive.length > 0) {
    actions.push({
      key: "standby", tone: "critical", count: standbyActive.length, unit: "개", title: "예비가 일하고 있는 역할",
      detail: <>{joined(standbyActive.map((row) => role(row.role)))} — 현재 담당·주 관측·격리 사유를 확인하고 외부 runbook의 주 복귀 절차를 따릅니다.</>,
      action: { label: "역할 표", href: ACTION_LINKS.roles }, work: { roles: standbyActive.map((row) => row.role) },
    });
  }
  // 역할마다 주·예비를 비교한다. 웹만 새로 배포한 정상 상태를 전체 SHA 불일치로 경보하지 않는다.
  if (roles) for (const name of FAILOVER_ROLES) {
    const row = roles.roles.find((item) => item.role === name);
    if (row?.reason === "ready" || row?.reason === "standby_active") continue;
    const reason = row ? READINESS_LABELS[row.reason] : "역할 관측 없음";
    actions.push({ key: `role-${name}`, tone: row?.reason === "standby_missing" || row?.reason === "release_mismatch" ? "hold" : "critical",
      count: reason, unit: "상태", title: `${ROLE_LABELS[name]} · ${reason}`,
      detail: <>현재 담당 {row?.ownerInstanceId ?? "미확인"} · 담당 차례 {row?.epoch ?? "미확인"} — 역할 표의 주·예비 릴리스와 담당 기한을 확인합니다.</>,
      action: { label: "역할 표", href: ACTION_LINKS.roles }, work: { roles: [name] } });
  }
  const workerAlarms = workerProgress?.liveness.filter((row) => row.alarm) ?? [];
  if (workerAlarms.length > 0) {
    actions.push({
      key: "liveness", tone: "critical", count: workerAlarms.length, unit: "개", title: "워커 관측이 끊겼거나 반복 재시작 중",
      detail: <>{joined(workerAlarms.map((row) => <>{role(row.role)} {row.reason === "restart_loop" ? "5분 내 반복 재시작" : "관측 끊김"}</>), " · ")}</>,
      action: { label: "작업 흐름", href: ACTION_LINKS.jobs }, work: { roles: workerAlarms.map((row) => row.role) },
    });
  }
  // 같은 릴리스로 다시 뜬 워커 — 5분 안 세 번이 아니어도 죽고 있다는 뜻이다(2026-10-08 발행 워커가 20분 사이 두 번)
  const restarted = (["crawler", "reviewer", "publisher", "text", "maintenance"] as const).flatMap((name) => {
    const count = latestServiceInstance(ops.serviceInstances, name)?.value.restartCount1h;
    return typeof count === "number" && count > 0 ? [{ role: name, count }] : [];
  });
  if (restarted.length > 0) {
    actions.push({
      key: "restarts", tone: "hold", count: restarted.reduce((sum, row) => sum + row.count, 0), unit: "회", title: "최근 1시간 안에 다시 뜬 워커",
      detail: <>{joined(restarted.map((row) => <>{role(row.role)} {row.count}회</>), " · ")} — 배포가 아닌 재시작입니다. 컨테이너 로그(supervisor.stopping 사유)를 봅니다.</>,
      action: { label: "역할 표", href: ACTION_LINKS.roles }, work: { roles: restarted.map((row) => row.role) },
    });
  }
  if (roles && roles.scheduler.freshReplicas < 2) {
    actions.push({
      key: "scheduler-replicas", tone: roles.scheduler.freshReplicas === 0 ? "critical" : "hold", count: `${roles.scheduler.freshReplicas}/2`, unit: "대", title: "스케줄러 복제 관측이 부족합니다",
      detail: <>최근 관측 {roles.scheduler.freshReplicas}대 — scheduler 앱의 두 복제본과 로그를 확인합니다.</>,
      action: { label: "역할 표", href: ACTION_LINKS.roles }, work: { services: ["scheduler"] },
    });
  }
  if (workerProgress?.scheduler.reason === "scheduler_missed") {
    const overdue = workerProgress.scheduler.overdueJobs;
    actions.push({
      key: "scheduler", tone: "critical", count: overdue.length, unit: "개", title: "스케줄러 예약이 밀렸습니다",
      detail: <>{joined(overdue.map(job))}</>,
      action: { label: "작업 흐름", href: overdue.length === 1 ? jobHref(overdue[0]) : ACTION_LINKS.jobs }, work: { jobs: overdue, services: ["scheduler"] },
    });
  }
  if (workerProgress?.scheduler.reason === "unknown_schedule") {
    actions.push({
      key: "scheduler-unknown", tone: "hold", count: "모름", unit: "상태", title: "스케줄러 예약 상태를 확인할 수 없습니다",
      detail: <>다음 예약 시각이 없는 작업이 있습니다 — 스케줄러 관측과 작업 표를 확인합니다.</>,
      action: { label: "작업 흐름", href: ACTION_LINKS.jobs }, work: { services: ["scheduler"] },
    });
  }
  // 워커는 관측되는데 저장 진행이 없는 단계 — 관측 끊김(liveness)과 달리 프로세스는 살아 있다
  const stuckStages = workerProgress?.stages.filter((row) => row.alarm && row.reason === "no_progress") ?? [];
  if (stuckStages.length > 0) {
    actions.push({
      key: "stage-progress", tone: "critical", count: stuckStages.length, unit: "단계", title: "워커는 살아 있는데 단계가 나아가지 않습니다",
      detail: <>{stuckStages.map((row) => throughput?.stages.find((stage) => stage.key === row.stage)?.label ?? row.stage).join(" · ")} — 오래 기다린 후보가 있는데 5분간 저장 진행이 없습니다.</>,
      action: { label: "작업 흐름", href: ACTION_LINKS.jobs }, work: { jobs: stuckStages.flatMap(progressStageJobs) },
    });
  }
  /**
   * 바깥 오류로 멈춘 단계(worker-progress.ts upstream_stalled) — 오래(30분) 기다린 일감이 있는데 공급자·작업 오류가 이어진다.
   * 진행 판정은 이것을 경보로 셌는데 조치에는 오르지 않았다. 다시 띄워도 풀리지 않는다 — 2시간(보류 30분의 4배)이면 긴급.
   */
  const upstreamStages = workerProgress?.stages.filter((row) => row.alarm && row.reason === "upstream_stalled") ?? [];
  if (upstreamStages.length > 0) {
    const age = (row: typeof upstreamStages[number]) => row.providerErrorMinutes ?? row.oldestMinutes ?? 0;
    const upstreamJob = upstreamStages.length === 1 ? upstreamStages[0].job : undefined;
    actions.push({
      key: "stage-upstream", tone: upstreamStages.some((row) => age(row) >= 30 * ESCALATE) ? "critical" : "hold", count: upstreamStages.length, unit: "단계",
      title: "바깥 오류로 단계가 나아가지 않습니다",
      detail: <>{joined(upstreamStages.map((row) => <>{throughput?.stages.find((stage) => stage.key === row.stage)?.label ?? row.stage}
        {typeof row.waiting === "number" ? ` 대기 ${n(row.waiting)}건` : ""} · {formatWait(age(row) / 60)}째{row.errors5m ? ` · 최근 5분 오류 ${n(row.errors5m)}` : ""}</>), " · ")}
        {" "}— 오래 기다린 일감이 있는데 공급자·작업 오류가 이어집니다. 워커를 다시 띄워도 풀리지 않습니다 — 작업 상세의 마지막 오류와 GitHub 한도·인증·모델 연결을 확인합니다.</>,
      action: { label: "작업 흐름", href: upstreamJob ? jobHref(upstreamJob) : ACTION_LINKS.jobs }, work: { jobs: upstreamStages.flatMap(progressStageJobs) },
    });
  }
  // 1시간 실패율 20% 이상인 모델 자리 — 예비가 받아 주면 "미해결 오류"에는 안 잡힌다(2차 투표 26% 가 숨었다)
  const failingModels = (models ?? []).filter((row) => row.calls1h >= 10 && row.failed1h / row.calls1h >= 0.2);
  if (failingModels.length > 0) {
    actions.push({
      key: "model-failures", tone: "hold", count: failingModels.length, unit: "자리", title: "모델 호출이 자주 실패합니다",
      detail: <>{failingModels.map((row) => `${row.label} ${row.model ? modelName(row.model) : ""} 실패 ${Math.round((row.failed1h / row.calls1h) * 100)}% (${row.failed1h}/${row.calls1h})`).join(" · ")} — 재시도와 예비 모델이 받아 주지만 처리량이 줄고 지연이 늘어납니다.</>,
      action: { label: "모델 연결", href: ACTION_LINKS.models }, work: { jobs: failingModels.map((row) => MODEL_HEALTH_JOBS[row.key]) },
    });
  }
  /**
   * Qwen 직접 서버의 물러나기(qwen-endpoint-backoff.ts) — 감사 직접 심사·두 번째 의견·공개분 거르기·2차 갈림 판가름·보류 재심사가 모두 멈춘다.
   * 감사 화면에만 보였다. 6번째 탈(누적 30분)이면 보류, 12번째(누적 2시간)면 긴급.
   * 부르는 쪽이 없어 묵은 관측(물러나기도 끝났고 30분 넘게 그대로)은 올리지 않는다.
   */
  const qwen = ops.observations.find((row) => row.key === QWEN_ENDPOINT_OBSERVATION)?.value as
    { failures?: unknown; retryAt?: unknown; lastError?: unknown; at?: unknown } | undefined;
  const qwenFailures = typeof qwen?.failures === "number" ? qwen.failures : 0;
  const qwenRetryAt = typeof qwen?.retryAt === "string" ? Date.parse(qwen.retryAt) : Number.NaN;
  const qwenAt = typeof qwen?.at === "string" ? Date.parse(qwen.at) : Number.NaN;
  const qwenLive = qwenRetryAt > Date.parse(now) || Date.parse(now) - qwenAt <= 30 * 60_000;
  if (qwenFailures >= QWEN_HOLD_FAILURES && qwenLive) {
    actions.push({
      key: "qwen-backoff", tone: qwenFailures >= QWEN_CRITICAL_FAILURES ? "critical" : "hold", count: qwenFailures, unit: "회",
      title: `Qwen 직접 서버(${qwenDirectServerLabel()})가 잇달아 실패해 물러나 있습니다`,
      detail: <>연속 {n(qwenFailures)}번{typeof qwen?.lastError === "string" ? <> · 마지막 <span className="font-mono">{qwen.lastError}</span></> : null}
        {Number.isFinite(qwenRetryAt) ? ` · 다음 시도 ${formatListTime(new Date(qwenRetryAt).toISOString(), now)}` : ""}
        {" "}— 그동안 감사 Qwen 직접 심사·두 번째 의견·공개분 거르기·2차 갈림 판가름·보류 재심사가 묻지 않습니다. 서버와 vLLM 이 떠 있는지 확인합니다.</>,
      action: { label: "감사", href: ACTION_LINKS.audit }, work: { jobs: ["product-audit", "second-review", "human-deepseek-review", "audit-screen-review"] },
    });
  }
  // 내려달라는 요청 — 상세 페이지가 내려 준다고 약속했다. 24시간을 넘기면 다른 경보처럼 맨 앞 급으로
  if (takedowns && takedowns.pending > 0) {
    const oldest = takedowns.oldestHours === null ? "" : ` · 최장 ${formatWait(takedowns.oldestHours)}`;
    actions.push({
      key: "takedowns", tone: takedowns.overdue > 0 ? "critical" : "hold", count: takedowns.pending, unit: "건",
      title: takedowns.overdue > 0 ? `내려달라는 요청 — 24시간 넘음 ${takedowns.overdue}` : "내려달라는 요청",
      detail: <>대기 {takedowns.pending}{oldest}{isBurst(takedowns) ? ` · 지난 1시간 ${takedowns.lastHour.requests}건 몰림` : ""} — 내릴 후보에서 처리</>,
      action: { label: "처리", href: ACTION_LINKS.takedowns },
    });
  }
  if (attention && attention.auditRejectsOpen > 0) {
    actions.push({
      key: "audit", tone: "hold", count: attention.auditRejectsOpen, unit: "건", title: "감사가 거절 판정한 발행분이 처리되지 않았습니다",
      detail: <>발행 뒤 감사가 &ldquo;제품 아님&rdquo;으로 본 것 — 사람이 내리거나 유지로 정해야 합니다.</>,
      action: { label: "내릴 후보", href: ACTION_LINKS.audit }, work: { jobs: ["product-audit", "audit-screen-review"] },
    });
  }
  if (attention && attention.auditHeld > 0) {
    actions.push({
      key: "audit-held", tone: "hold", count: attention.auditHeld, unit: "건", title: "감사 보류로 목록에서 빠진 제품이 사람을 기다립니다",
      detail: <>AI 감사가 높은 확신으로 &ldquo;제품 아님&rdquo;이라 해 공개 목록에서만 뺀 것 — 차단이 아닙니다. 내리거나 유지로 정해야 풀립니다.</>,
      action: { label: "보류 중", href: ACTION_LINKS.auditHeld }, work: AUDIT_WORK,
    });
  }
  if (attention?.auditCampaign && !attention.auditCampaign.current) {
    actions.push({
      key: "audit-stalled", tone: "hold", count: attention.auditCampaign.unanswered, unit: "건", title: "발행분 감사가 멈춰 있습니다",
      detail: <>감사 #{attention.auditCampaign.id}은 프롬프트 {attention.auditCampaign.promptVersion}로 시작했는데 지금 코드와 달라 매 틱 건너뜁니다 — 남은 {n(attention.auditCampaign.unanswered)}건은 사람이 중단하고 새 감사를 열어야 다시 봅니다.</>,
      action: { label: "감사", href: ACTION_LINKS.audit }, work: AUDIT_WORK,
    });
  }
  if (attention && attention.cdnPurgesPending > 0) {
    actions.push({
      key: "cdn-purge", tone: "hold", count: attention.cdnPurgesPending, unit: "건", title: "내린 제품의 CDN 캐시가 지워지지 않았습니다",
      detail: <>10분 넘게 확인되지 않은 지우기 요청 — 발행 워커의 CLOUDFLARE_ZONE_ID·CLOUDFLARE_PURGE_TOKEN 을 확인합니다. 그동안 내린 페이지가 Cloudflare 에 남습니다.</>,
      action: { label: "작업 흐름", href: ACTION_LINKS.jobs }, work: { jobs: ["cdn-purge"] },
    });
  }
  /**
   * 알림 메일(email-health.ts) — 발신 설정이 없거나 Resend 가 키·도메인·한도로 거절하면 경고 로그만 남기고 미루다 하루 뒤 닫았다.
   * 발송함의 결과와 보내는 잡의 제 일 못 함(설정 없음·공급자 거절)을 한 줄에 모은다.
   */
  const emailJob = healthIssues.find((issue) => issue.job === "email-outbox-send" && issue.kind === "degraded");
  const outbox = inputs.email?.outbox ?? null;
  const outboxTone = maxTone(outbox ? emailOutboxLevel(outbox) : null, emailJob?.level);
  if (outboxTone) {
    const undelivered = (outbox?.unknown ?? 0) + (outbox?.expired ?? 0) + (outbox?.pendingOverdue ?? 0);
    actions.push({
      key: "email-outbox", tone: outboxTone, count: undelivered || outbox?.pending || 0, unit: "통", title: "알림 메일이 나가지 않습니다",
      detail: <>{outbox ? <>최근 이틀 결과 모름 {n(outbox.unknown)} · 못 보내고 하루 지나 닫음 {n(outbox.expired)} · 거절 {n(outbox.rejected)} · 보냄 {n(outbox.accepted)} · 대기 {n(outbox.pending)}
        {outbox.pendingOverdue > 0 ? `(1시간 넘음 ${n(outbox.pendingOverdue)}${outbox.oldestPendingMinutes !== null ? `, 가장 오래 ${formatWait(outbox.oldestPendingMinutes / 60)}` : ""})` : ""}</> : "발송함 결과를 읽지 못했습니다"}
        {emailJob ? <> · {jobHealthLine(emailJob, now)}</> : null}
        {" "}— maintenance 의 LOGIN_EMAIL_API_KEY·LOGIN_EMAIL_FROM·PUBLIC_AUTH_SECRET 과 Resend 도메인·한도를 확인합니다. 하루가 지난 메일은 보내지 않고 닫습니다.</>,
      action: { label: "메일 작업", href: jobHref("email-outbox-send") }, work: { jobs: ["email-outbox-send"] },
    });
  }
  // 로그인 코드 메일 — 웹이 그 자리에서 보낸다(잡이 아니다). 한 통이라도 실패하면 보류, 가장 최근 세 통이 모두 실패면 지금 막힌 것이라 긴급
  const login = inputs.email?.login ?? null;
  const loginTone = login ? loginEmailLevel(login) : null;
  if (login && loginTone) {
    actions.push({
      key: "login-email", tone: loginTone, count: login.failed24h, unit: "통",
      title: loginTone === "critical" ? "로그인 코드 메일이 나가지 않습니다" : "로그인 코드 메일 일부가 실패했습니다",
      detail: <>최근 24시간 {n(login.total24h)}통 중 거절·결과 모름 {n(login.failed24h)}통{loginTone === "critical" ? " · 가장 최근 세 통이 모두 실패" : ""}
        {" "}— 웹의 LOGIN_EMAIL_API_KEY·LOGIN_EMAIL_FROM 과 Resend 도메인 인증·한도를 확인합니다. 그동안 메일 로그인은 코드를 받지 못합니다(GitHub 로그인은 그대로).</>,
      action: { label: "웹 관측", href: ACTION_LINKS.roles }, work: { services: ["web"] },
    });
  }
  /**
   * 랭킹 집계(ranking-refresh) — 주기가 없어(click-rollup 이 끝나며 요청한다) 작업 띠에서 늘 초록이었고, 진단 탭의 글자색만 바뀌었다.
   * 공개 화면이 "오래됨"을 붙이는 2시간(RANKING_STALE_MS)이면 보류, 그 4배면 긴급. 한 번도 돌지 않은 새 환경은 세우지 않는다.
   */
  const ranking = states.get("ranking-refresh");
  const rankingSuccess = asDate(ranking?.lastSuccessAt);
  const rankingAge = rankingSuccess ? Date.parse(now) - rankingSuccess.getTime() : ranking?.lastRunAt ? Number.POSITIVE_INFINITY : null;
  if (rankingAge !== null && rankingAge > RANKING_STALE_MS && !isPausedJob(ranking)) {
    const rollup = states.get("click-rollup");
    actions.push({
      key: "ranking-stale", tone: rankingAge > RANKING_STALE_MS * ESCALATE ? "critical" : "hold", elapsed: true,
      count: Number.isFinite(rankingAge) ? Math.floor(rankingAge / 3_600_000) : "없음", unit: Number.isFinite(rankingAge) ? "시간" : "상태",
      title: "랭킹이 2시간 넘게 갱신되지 않았습니다",
      detail: <>{job("ranking-refresh")} 마지막 성공 {formatListTime(rankingSuccess?.toISOString() ?? null, now, "없음")}{ranking?.lastError ? " · 마지막 회차 실패" : ""}
        {" "}· {job("click-rollup")} 마지막 성공 {formatListTime(asDate(rollup?.lastSuccessAt)?.toISOString() ?? null, now, "없음")}
        {" "}— 집계가 끝나야 랭킹을 요청합니다. 공개 화면은 랭킹에 &ldquo;오래됨&rdquo;을 붙입니다.</>,
      action: { label: "랭킹 작업", href: jobHref("ranking-refresh") }, work: { jobs: ["ranking-refresh", "click-rollup"] },
    });
  }
  if (evidenceSummary.oldestDueHours !== null && evidenceSummary.oldestDueHours > 72) {
    actions.push({
      key: "evidence-backlog", tone: "hold", count: evidenceSummary.due, unit: "건", title: "제품 근거 갱신이 밀렸습니다",
      detail: <>기한 지난 출처 {n(evidenceSummary.due)}건 · 가장 오래된 것 {Math.round(evidenceSummary.oldestDueHours / 24)}일 — {job("product-evidence-refresh")} 처리량이 출처 수를 못 따라갑니다.</>,
      action: { label: "근거 갱신 작업", href: jobHref("product-evidence-refresh") }, work: { jobs: ["product-evidence-refresh", "product-site-evidence-refresh"] },
    });
  }
  if (attention && attention.healthOverdue > 0) {
    actions.push({
      key: "health-overdue", tone: attention.healthOverdue > 5_000 ? "hold" : "clear", count: attention.healthOverdue, unit: "건", title: "생존 확인이 6시간 넘게 밀린 제품",
      detail: <>{job("uptime-ping")} 처리량이 목표(시간당 {n(attention.healthTargetPerHour)})에 못 미치면 쌓입니다.</>,
      action: { label: "응답 점검 작업", href: jobHref("uptime-ping") }, work: UPTIME_WORK,
    });
  }
  if (attention && attention.introNeedsEditor > 0) {
    actions.push({
      key: "intro", tone: "hold", count: attention.introNeedsEditor, unit: "건", title: "소개 확인이 필요한 제품",
      detail: <>소개 검수가 근거로는 알 수 없다고 한 것{isPausedJob(states.get("product-intro-check")) ? " — 검수 잡은 멈춰 있습니다" : ""}.</>,
      action: { label: "제품 관리", href: ACTION_LINKS.productsIntro }, work: { jobs: ["product-intro-check"] },
    });
  }
  if (attention && attention.repoGone.installable + attention.repoGone.website > 0) {
    const review = attention.repoReview;
    // 2단계(저장소 다시 열어 보기)가 사라졌다고 확정된 뒤 이틀 넘게 끝나지 않은 것이 있으면 맨 앞 급으로
    const overdue = review.oldestHours !== null && review.oldestHours > REPO_REVIEW_OVERDUE_HOURS;
    actions.push({
      key: "repo-gone", tone: overdue ? "critical" : "hold", count: attention.repoGone.installable + attention.repoGone.website, unit: "건",
      title: overdue ? `저장소가 사라진 공개 제품 — ${REPO_REVIEW_OVERDUE_HOURS}시간 넘게 처리 안 됨` : "저장소가 사라진 공개 제품",
      detail: <>GitHub 저장소가 없거나 빈 채로 하루 넘게 이어짐 — 설치형 {n(attention.repoGone.installable)}건은 목록에서 가려짐 · 웹 {n(attention.repoGone.website)}건은 GitHub 표시만 뺌.
        {" "}잡이 github.com 을 다시 열어 정말 없으면 내립니다(하루 100건까지): 확인 대기 {n(review.pending)} · 내릴 후보 {n(review.delistCandidates)} · 사람 확인(옮겨 간 흔적) {n(review.human)} · 저장소 다시 열림 {n(review.kept)}
        {review.oldestHours !== null && <> · 가장 오래 기다린 것 {Math.round(review.oldestHours)}시간</>}.</>,
      action: { label: "제품 관리", href: ACTION_LINKS.productsRepoGone }, work: { jobs: ["product-stars-refresh", "product-repo-review"] },
    });
  }
  // 공개 제품 스팸 재검사(product-spam-rescan)가 자동으로 내린 것 — 하루 한도에 닿으면 판정이 잘못 바뀌었을 수 있어 더 내리지 않는다
  if (attention && attention.spamAutoBans.day > 0) {
    const capped = attention.spamAutoBans.day >= MAX_AUTO_BANS_PER_DAY;
    actions.push({
      key: "spam-auto-ban", tone: capped ? "critical" : "hold", count: attention.spamAutoBans.day, unit: "건",
      title: capped ? `스팸 자동 차단이 하루 한도(${MAX_AUTO_BANS_PER_DAY}건)에 닿아 멈췄습니다` : "스팸 패턴으로 자동 차단한 공개 제품",
      detail: <>지난 24시간에 {n(attention.spamAutoBans.day)}건을 내렸습니다(판정 {SPAM_DETECTOR_VERSION}).{" "}
        {capped ? "더 걸린 것은 내리지 않고 기다립니다 — 판정이 잘못 바뀌지 않았는지 내린 목록부터 보세요." : "잘못 내려간 것은 차단 해제하면 재검사가 다시 내리지 않습니다."}
        {" "}자동 차단으로 남아 있는 것 {n(attention.spamAutoBans.banned)}건.</>,
      action: { label: "자동 차단 목록", href: ACTION_LINKS.productsSpamBanned }, work: { jobs: ["product-spam-rescan"] },
    });
  }
  // 공개 제품의 GitHub 저장소를 하루에 한 번씩 다 보고 있나(product-stars-refresh) — 배포 직후 첫 바퀴(약 10시간)는 낮다
  const repoCoverage = attention && attention.repoHealth.tracked > 0 ? attention.repoHealth.checked24h / attention.repoHealth.tracked : null;
  if (repoCoverage !== null && repoCoverage < REPO_COVERAGE_TARGET) {
    actions.push({
      key: "repo-coverage", tone: "hold", count: Math.floor(repoCoverage * 100), unit: "%", title: "저장소 확인 범위가 95% 아래입니다",
      detail: <>GitHub 저장소가 있는 공개 제품 {n(attention!.repoHealth.tracked)}개 중 지난 24시간에 확인한 것 {n(attention!.repoHealth.checked24h)}개 — {job("product-stars-refresh")} 작업이 밀리거나 GitHub 한도에 걸렸습니다.</>,
      action: { label: "작업 흐름", href: ACTION_LINKS.jobs }, work: { jobs: ["product-stars-refresh"] },
    });
  }
  // 설정을 저장했는데 10분 넘게 옛 판으로 도는 워커(ADM-19) — 설정 화면 머리의 적용 확인과 같은 판단(settings-apply.ts)
  const settingsLag = inputs.settingsApply?.attention;
  if (settingsLag) {
    actions.push({
      key: settingsLag.key, tone: settingsLag.tone, count: settingsLag.count, unit: "개", title: settingsLag.title, detail: settingsLag.detail,
      action: { label: "적용 확인", href: ACTION_LINKS.settingsApply },
    });
  }
  if (quota.readFailed) actions.push({ key: "quota-unknown", tone: "hold", count: "미확인", unit: "상태", title: "GitHub 수집 자격 일부를 읽지 못했습니다",
    detail: "PAT·App의 저장된 core 관측을 모두 읽어야 합니다. 환경 토큰·인증·search·GraphQL 가용성은 이 집계로 판단하지 않습니다.",
    action: { label: "수집 계정", href: ACTION_LINKS.githubAccounts } });
  const lowQuota = quota.sources.filter((row) => !row.stale && row.quota && row.quota.limit > 0 && row.quota.remaining / row.quota.limit < 0.1);
  if (lowQuota.length > 0) {
    actions.push({
      key: "quota", tone: "hold", count: lowQuota.length, unit: "자격", title: "일부 수집 자격의 core 잔량이 적습니다",
      detail: <>{lowQuota.map((row) => `${row.label} ${n(row.quota!.remaining)}/${n(row.quota!.limit)} · ${formatListTime(row.quota!.reset * 1000, now)} 초기화`).join(" · ")} — 다른 자격과 환경 토큰은 별도입니다. 풀 전체 고갈을 뜻하지 않습니다.</>,
      action: { label: "수집 계정", href: ACTION_LINKS.githubAccounts },
    });
  }
  // X 수집기(osaka-smoke)의 하루 보고(v8 PR9) — 이미 읽은 관측 줄에서 꺼낸다(새 쿼리 없음).
  // 받는 주소가 꺼져 있거나(비밀 없음), 아직 보고가 없거나(연결 전), 마지막 보고가 꺼짐(disabled)이면 띄우지 않는다.
  const x = readXStatus(ops.observations, now);
  const hoursSince = (at: string | null) => at ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(at)) / 3_600_000)) : 0;
  if (x.state === "stale" || x.state === "error" || x.state === "invalid") {
    const received = formatListTime(x.receivedAt, now);
    const mode = x.report?.mode === "live" ? "실제 수집(live)" : "시험 실행(dry-run)";
    // 끊김·읽기 실패는 마지막으로 받은 때부터, 오류는 마지막 성공부터(없으면 받은 때부터) — 숫자라야 24시간 변화·숨김이 된다
    const hours = hoursSince(x.state === "error" ? x.report?.lastSuccessAt ?? x.receivedAt : x.receivedAt);
    actions.push({
      // 하루 한 번 오는 보고가 사흘(세 번) 넘게 없거나 오류가 사흘 넘게 이어지면 긴급 — 확인함(7일 숨김)도 긴급은 가리지 않는다
      key: "x-status", tone: hours >= X_CRITICAL_HOURS ? "critical" : "hold", unit: "시간", elapsed: true,
      count: hours,
      title: x.state === "stale" ? "X 수집 보고가 끊겼습니다" : x.state === "error" ? "X 수집기가 오류를 보고했습니다" : "X 수집 보고를 읽지 못했습니다",
      detail: x.state === "stale"
        ? <>마지막 보고 {received}(받은 시각) · {mode} — 하루 한 번 오는 보고가 {X_STATUS_STALE_HOURS}시간 넘게 없습니다. osaka-smoke 의 X 수집 타이머와 보고 전송을 확인합니다.</>
        : x.state === "error"
          ? <>오류 <span className="font-mono">{x.report?.error}</span> · {mode} · 마지막 성공 {formatListTime(x.report?.lastSuccessAt ?? null, now, "없음")} · 받은 시각 {received} — 수집기 상태와 로그를 확인합니다. 일부러 끈 것이면 꺼짐(disabled)으로 보고하게 합니다.</>
          : <>받은 시각 {received} — 저장된 보고의 모양이 지금 코드와 맞지 않습니다. 수집기를 다시 실행해 새 보고를 받습니다.</>,
      action: { label: "크롤러 활동", href: ACTION_LINKS.crawlers }, work: X_WORK,
    });
  }
  /**
   * 게시물 전달 — 하루 보고는 후보 수만 싣고, 게시물 보고(x-posts)를 웹이 거절했는지는 osaka 의 status.json 에만 남았다.
   * 끝난 실제 수집(completedLiveRun)이 후보를 냈으면 같은 실행의 게시물 보고가 먼저 와 있어야 한다(수집기는 게시물을 먼저 보낸다) —
   * 웹이 받은 게시물 보고의 수집 시각이 그 실행보다 앞이면 전달이 어긋났다. 사흘(세 번) 넘게 어긋나면 긴급.
   */
  if (x.state === "ok" && x.report && completedLiveRun(x.report) && x.report.candidates > 0) {
    const posts = ops.observations.find((row) => row.key === X_POSTS_KEY);
    const postsRunAt = typeof (posts?.value as { observedAt?: unknown } | undefined)?.observedAt === "string"
      ? Date.parse((posts!.value as { observedAt: string }).observedAt) : Number.NaN;
    const runAt = Date.parse(x.report.lastRunAt!);
    if (!(postsRunAt >= runAt)) {
      const missedHours = Number.isFinite(postsRunAt) ? Math.floor((runAt - postsRunAt) / 3_600_000) : null;
      actions.push({
        key: "x-delivery", tone: missedHours !== null && missedHours >= X_CRITICAL_HOURS ? "critical" : "hold", count: x.report.candidates, unit: "건",
        title: "X 수집 결과가 웹에 들어오지 않았습니다",
        detail: <>{formatListTime(x.report.lastRunAt, now)} 실제 수집이 후보 {n(x.report.candidates)}건을 냈는데 같은 실행의 게시물 보고를 받지 못했습니다
          {" "}· 마지막으로 받은 게시물 보고 {Number.isFinite(postsRunAt) ? formatListTime(new Date(postsRunAt).toISOString(), now) : "없음"}
          {" "}— osaka-smoke 의 status.json(reports.posts)에 웹이 돌려준 응답이 있습니다. 서명 비밀·주소(X_POSTS_REPORT_URL)·형식을 확인합니다.</>,
        action: { label: "크롤러 활동", href: ACTION_LINKS.crawlers }, work: X_WORK,
      });
    }
  }
  // 후보 0 이 이틀 — 끝난 실제 수집이 잇달아 후보를 내지 못했다(검색어·요금제·연산자 문제). 그 4배(8일)면 긴급
  const xRuns = parseXStatusRuns(ops.observations.find((row) => row.key === X_STATUS_RUNS_KEY)?.value);
  if ((x.state === "ok" || x.state === "error") && x.report?.mode === "live" && xRuns && xRuns.zeroRuns >= X_ZERO_HOLD_RUNS) {
    actions.push({
      key: "x-candidates", tone: xRuns.zeroRuns >= X_ZERO_HOLD_RUNS * ESCALATE ? "critical" : "hold", count: xRuns.zeroRuns, unit: "일",
      title: "X 수집이 이틀 넘게 후보를 내지 못했습니다",
      detail: <>끝난 실제 수집 {n(xRuns.zeroRuns)}번이 잇달아 후보 0건(처음 {formatListTime(xRuns.zeroSince, now, "모름")}) — 읽기는 하루 10건을 그대로 씁니다.
        {" "}검색어(좋아요 하한)와 X 검색 응답 코드를 확인합니다.</>,
      action: { label: "크롤러 활동", href: ACTION_LINKS.crawlers }, work: X_WORK,
    });
  }
  return actions;
}

/**
 * "지금 조치"와 "쌓인 일"로 나눈다(2026-10-08 UX 감사 ADM-08).
 *
 * - 지금 조치: critical, 만성 백로그가 아닌 것(장애·설정·요청), 그리고 기준 시각에 없다가 새로 생긴 백로그.
 * - 쌓인 일: 늘 떠 있는 백로그(BACKLOG_KEYS) — 24시간 변화를 단다. "확인함"으로 7일 숨긴 것은 따로 접는다.
 * 숨김은 쌓인 일에만 걸린다 — 같은 항목이 critical 로 바뀌거나 새로 생기면 숨김과 상관없이 지금 조치에 선다.
 */
export function splitActions(items: ActionItem[], options: { samples: AttentionSample[]; acks: Map<string, AttentionAck>; now: Date }) {
  const baseline = attentionBaseline(options.samples, options.now);
  const hours = baseline ? Math.round((options.now.getTime() - Date.parse(baseline.at)) / 3_600_000) : 0;
  const urgent: SplitItem[] = [], backlog: SplitItem[] = [], hidden: SplitItem[] = [];
  for (const item of sortActions(items)) {
    const before = baseline?.counts[item.key];
    const fresh = baseline !== null && before === undefined;
    // 지난 시간을 센 칸(elapsed)은 시간이 가면 저절로 는다 — 24시간 변화로 그리지 않는다
    const trend = !item.elapsed && typeof item.count === "number" && typeof before === "number" ? { delta: item.count - before, hours } : null;
    const split: SplitItem = { ...item, trend, fresh };
    if (item.tone === "critical" || !BACKLOG_KEYS.has(item.key) || fresh) urgent.push(split);
    else if (options.acks.has(item.key)) hidden.push({ ...split, ack: options.acks.get(item.key) });
    else backlog.push(split);
  }
  return { urgent, backlog, hidden };
}

/** 시간별 기록에 남길 수 — 숫자인 것만(상태 글자는 견줄 수 없다) */
export function actionCounts(items: ActionItem[]): Record<string, number> {
  return Object.fromEntries(items.flatMap((item) => typeof item.count === "number" ? [[item.key, item.count]] : []));
}

/**
 * 메뉴의 "긴급 N건" 배지 — 운영센터와 같은 buildActions 로 센 critical 수. 긴급이 없으면 작업 이상 보류(BADGED_HOLD_KEYS)를 주황으로 단다.
 *
 * 레이아웃은 모든 관리자 화면 앞에 서므로 화면을 기다리게 하지 않는다 — 30초 들고 있고, 그 뒤 5분 안이면 지난 값을 주며
 * 뒤에서 다시 센다. 처음(프로세스가 막 떴을 때)이거나 5분 넘게 묵었으면 배지 없이 그리고 뒤에서 센다.
 * 웹 여러 대가 Valkey 로 같은 수를 나눠 쓰고, 다시 세기(조치 입력 25개 남짓의 조회)도 30초에 한 대만 한다(sharedStale) —
 * 관리자 화면을 몇 개 열어 두든 주 DB 에 더하는 일은 30초에 한 번이다.
 * 운영센터가 그릴 때마다 rememberCriticalCount 로 이 값을 맞춘다 — 운영센터를 열어 둔 동안 배지와 화면의 수가 같다.
 * 세기에 실패하면 지난 값을 그대로 두고, 5분이 넘으면 배지를 달지 않는다(null).
 * 나눠 쓰는 값의 모양이 숫자 하나에서 {긴급·보류}로 바뀌어 이름공간을 새로 쓴다 — 배포 중 옛 웹이 둔 숫자를 새 웹이 잘못 읽지 않게.
 */
export type ActionBadgeCounts = { critical: number; hold: number };
const badgeCounts = sharedStale<ActionBadgeCounts>({ namespace: "admin:action-badge", ttlMs: 30_000, staleMs: 5 * 60_000, store: sharedStore });

export function countBadgeActions(items: ActionItem[]): ActionBadgeCounts {
  return { critical: items.filter((item) => item.tone === "critical").length,
    hold: items.filter((item) => item.tone === "hold" && BADGED_HOLD_KEYS.has(item.key)).length };
}

export function rememberCriticalCount(items: ActionItem[]): number {
  const counts = countBadgeActions(items);
  badgeCounts.put("count", counts);
  return counts.critical;
}

export async function actionBadgeCounts(): Promise<ActionBadgeCounts | null> {
  return badgeCounts.get("count", async () => {
    try {
      const inputs = await loadActionInputs(await getSettings());
      const items = buildActions(inputs, deriveStatus(inputs));
      // 아무도 운영센터를 열지 않는 날에도 24시간 변화를 잴 수 있게 시간별 수를 남긴다(55분에 한 번만 적는다)
      await recordAttentionSample(actionCounts(items)).catch(warn("operations.attention_sample_failed"));
      return countBadgeActions(items);
    } catch (error) {
      warn("operations.critical_count_failed")(error);
      throw error;
    }
  });
}

export async function criticalActionCount(): Promise<number | null> {
  return (await actionBadgeCounts())?.critical ?? null;
}
