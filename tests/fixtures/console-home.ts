import type { Conveyor } from "@/lib/operations/conveyor-model";
import type { ConsoleHomeRead } from "@/lib/operations/console-home-read";
import type { ConsoleTaskInputs } from "@/lib/operations/console-tasks";
import probe from "./console-home-probe.json";

/**
 * 운영 콘솔 홈 시험의 고정 자료 — 2026-11-12 08:59 KST(2026-11-11T23:59Z) 운영 읽기(admin-final-20261112/probe.json)를 줄인 것.
 * 칸은 그때 관리자 읽기 함수가 돌려준 값 그대로다(readConveyor · readWorkerProgress · listJobStates · readAdminModelsObservation ·
 * listAiConnections · listAiTaskRows · readAiTaskExecutionAdminViews · sharedInbox · sharedHumanQueueOverview · openBacklogStats · 24시간 장부).
 * 연결 id 는 읽기 쉬운 가짜 id 로 바꿨고, 주소·키·저장소 이름은 넣지 않았다.
 */
export const CONSOLE_PROBE_AT = probe.at;

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
    connections: copy.connections.map(row => ({ ...row, kind: row.kind as "api" | "cli" })),
    ranks: copy.ranks,
    pools: copy.pools,
    devices: copy.observation.devices,
    ledger: copy.ledger,
  };
}

export function consoleFixtureRead(overrides: Partial<ConsoleTaskInputs> = {}): ConsoleHomeRead {
  const inputs = { ...consoleFixtureInputs(), ...overrides };
  return { checkedAt: inputs.now, inputs, conveyor: inputs.conveyor as Conveyor | null,
    jobControls: { "product-intro-check": { paused: true, notBefore: "2126-10-10T17:03:03.555Z", version: 28123 } } };
}
