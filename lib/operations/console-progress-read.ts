import "server-only";
import { sharedStore } from "@/lib/cache/shared";
import type { ConsoleProgress } from "./console-tasks";
import { sharedLoader } from "./shared-cache";
import { readWorkerProgress } from "./worker-progress-query";

/**
 * 워커 진행(단계 대기·처리) 읽기 — 홈 할 일(console-home-read)과 바꾼 것 지켜보기(change-watch 의 「일감 없음」 판정)가 같은 공유 캐시로 나눠 쓴다.
 * 웹 여러 대가 30초 나눠 쓰고, 5분 안의 값이면 기다리지 않고 준 뒤 뒤에서 다시 센다.
 */
const progressCache = sharedLoader<ConsoleProgress>({ namespace: "admin:console:progress", ttlMs: 30_000, staleMs: 300_000, store: sharedStore });

async function loadProgress(): Promise<ConsoleProgress> {
  const report = await readWorkerProgress(new Date(), { includeText: true });
  // 수치를 읽지 못한 단계(unread)가 섞인 보고는 지금처럼 「진행을 읽지 못함」으로 둔다 — 할 일·흐름 판정이 빈 수치를 「대기 0건」으로 읽지 않게.
  // 사유 번역 집계는 5분 담아 쓰므로(text-stage-progress.ts) 잠깐의 실패는 여기까지 오지 않는다.
  if (report.stages.some(stage => stage.unread)) throw new Error("console_progress_stage_unread");
  return {
    stages: report.stages.map(stage => ({ stage: stage.stage, job: stage.job ?? null, reason: stage.reason, alarm: stage.alarm,
      waiting: stage.waiting ?? null, oldestMinutes: stage.oldestMinutes ?? null, completed5m: stage.completed5m ?? null,
      skipBlock: stage.skipBlock ? { reason: stage.skipBlock.reason, code: stage.skipBlock.code, detail: stage.skipBlock.detail } : null })),
    liveness: report.liveness.map(row => ({ role: row.role, reason: row.reason })),
  };
}

export function readConsoleProgress(fresh = false): Promise<ConsoleProgress> {
  return progressCache("v1", loadProgress, fresh);
}
