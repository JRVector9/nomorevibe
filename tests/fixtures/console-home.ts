import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import type { LimitsView } from "@/lib/operations/admin-limits-view";
import type { Conveyor } from "@/lib/operations/conveyor-model";
import type { ConsoleHomeRead } from "@/lib/operations/console-home-read";
import type { ConsoleLedgerRow, ConsoleTaskInputs } from "@/lib/operations/console-tasks";
import type { StageJobState, StageRuntime } from "@/lib/operations/stage-panel-model";
import probe from "./console-home-probe.json";

/**
 * 운영 콘솔 홈 시험의 고정 자료 — 2026-11-12 08:59 KST(2026-11-11T23:59Z) 운영 읽기(admin-final-20261112/probe.json)를 줄인 것.
 * 칸은 그때 관리자 읽기 함수가 돌려준 값 그대로다(readConveyor · readWorkerProgress · listJobStates · readAdminModelsObservation ·
 * listAiConnections · listAiTaskRows · readAiTaskExecutionAdminViews · sharedInbox · sharedHumanQueueOverview · openBacklogStats · 24시간 장부).
 * 단계 패널(조각 2a)용으로 같은 실측에서 장비 한도·경로 점유, 잡 행, 실행 쪽 순위 사정(readAiTaskRuntime), 실시간 한도 4줄(readLimitsAdminView)을 덧붙였다.
 * 연결 id 는 읽기 쉬운 가짜 id 로 바꿨고, 주소·키·저장소 이름은 넣지 않았다.
 */
export const CONSOLE_PROBE_AT = probe.at;

/**
 * 실측 장부의 「결과 없이 끝남」(noResult)을 두 갈래로 — 그때 읽기는 종류를 나누지 않았다. LG EXAONE(장비 Exaone)의 것은 모델의 거절(gateway_http_rejected),
 * 나머지는 보내기 전에 끝난 것(gateway_not_started)으로 둔다 — 11-12 배포 직후 실측에서 EXAONE 은 거절, gpu3090-qwen 은 전부 보내기 전에 끝남이었다.
 * 나머지 작은 수(supa 3 · m1-gemma 1)의 종류는 실측이 없다 — 어느 쪽이든 기준(10건) 아래다.
 */
export function splitLedgerRow<T extends { groupId: string; noResult: number }>({ noResult, ...row }: T): Omit<T, "noResult"> & Pick<ConsoleLedgerRow, "rejected" | "notStarted"> {
  return { ...row, rejected: row.groupId === "Exaone" ? noResult : 0, notStarted: row.groupId === "Exaone" ? 0 : noResult };
}

export function consoleFixtureInputs(): ConsoleTaskInputs {
  const copy = structuredClone(probe);
  return {
    now: copy.at,
    conveyor: copy.conveyor as unknown as Conveyor,
    progress: copy.progress,
    jobs: copy.jobs,
    admission: { mode: copy.observation.mode as "open", since: copy.observation.since },
    takedown: copy.takedown,
    agreed: copy.agreed,
    audit: copy.audit,
    // supa 의 두 이름은 같은 root(별칭) — 모델 묶음 하나. M1max 는 목록 이름과 직접 적은 이름이 달라 둘(model-console fixture 와 같은 사실)
    connections: copy.connections.map(row => ({ ...row, kind: row.kind as "api" | "cli", modelGroups: row.id === "conn-supa-direct" ? 1 : row.models.length })),
    ranks: copy.ranks,
    pools: copy.pools,
    devices: copy.observation.devices,
    ledger: copy.ledger.map(splitLedgerRow),
  };
}

/** 잡 행 — listJobStates 의 마지막 실행·성공·오류(멈춤은 fixture 의 판정 그대로) */
export function consoleFixtureJobStates(): StageJobState[] {
  const copy = structuredClone(probe);
  return copy.jobs.map(job => {
    const state = copy.jobStates.find(row => row.name === job.name);
    return { name: job.name, paused: job.paused, lastRunAt: job.lastRunAt, lastSuccessAt: state?.lastSuccessAt ?? null, lastError: state?.lastError ?? null,
      notBefore: job.notBefore ?? null };
  });
}

export const consoleFixtureExecutions = () => structuredClone(probe.executions) as unknown as AiTaskExecutionAdminView[];
export const consoleFixtureLimits = () => structuredClone(probe.limits) as unknown as LimitsView;
export const consoleFixtureRuntime = (): StageRuntime[] => Object.entries(structuredClone(probe.runtime))
  .map(([task, view]) => ({ task, at: view.at, served: view.served, unusable: view.unusable, degraded: view.degraded }));

export function consoleFixtureRead(overrides: Partial<ConsoleTaskInputs> = {}): ConsoleHomeRead {
  const inputs = { ...consoleFixtureInputs(), ...overrides };
  return { checkedAt: inputs.now, inputs, conveyor: inputs.conveyor as Conveyor | null,
    jobControls: { "product-intro-check": { paused: true, notBefore: "2126-10-10T17:03:03.555Z", version: 28123 } },
    jobStates: consoleFixtureJobStates(), executions: consoleFixtureExecutions(), // 작업 제어 판 — 소개 검수는 실측, 1차 심사는 시험용 값(패널의 멈춤 폼이 판을 싣는지만 본다)
    jobVersions: { "product-intro-check": 28123, "crawl-agent-review": 27001 } };
}
