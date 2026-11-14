import type { BeltTone, Conveyor } from "./conveyor-model";
import { CONSOLE_STAGE_LABELS, consoleStageHref, formatCount, formatKstTime, type ConsoleProgress, type ConsoleTaskBoard, type ConsoleTaskInputs } from "./console-tasks";
import { aiTask, isAiLiveTask } from "@/lib/llm/ai-tasks";
import type { AiTaskExecutionAdminView } from "./admin-ai-task-execution";
import { stagePanel } from "./stage-panel-catalog";

/**
 * 운영 콘솔 홈의 머리줄과 「흐름」 표 — 순수 함수. 숫자는 전체 흐름(readConveyor)과 워커 진행(readWorkerProgress)을 그대로 옮긴다.
 * 상태는 점 하나와 짧은 말이고, 할 일 규칙이 멈춤·쌓임으로 올린 칸은 같은 판정을 쓴다(할 일과 표가 다른 말을 하지 않게).
 */

export type ConsoleTone = "ok" | "warn" | "bad" | "off";
/** 머리줄 칸 — value 가 null 이면 「셀 수 없음」 */
export type ConsoleStripItem = { key: string; label: string; value: string | null };

export function buildConsoleStrip(input: { conveyor: Conveyor | null; admission: ConsoleTaskInputs["admission"]; progress: ConsoleProgress | null }): ConsoleStripItem[] {
  const { conveyor, admission, progress } = input;
  const admissionText = !admission ? null
    : `${admission.mode === "open" ? "열림" : admission.mode === "draining" ? "중단" : "꺼짐"}${admission.since ? ` · ${formatKstTime(admission.since)}부터` : ""}`;
  const publish = conveyor?.stations.find(station => station.key === "publish") ?? null;
  const liveness = progress?.liveness ?? null;
  return [
    { key: "admission", label: "접수", value: admissionText },
    { key: "published-hour", label: "발행", value: conveyor?.publishedHour == null ? null : `${formatCount(conveyor.publishedHour)}/시간` },
    { key: "published-day", label: "24시간 발행", value: publish?.done24h == null ? null : formatCount(publish.done24h) },
    { key: "public", label: "공개", value: conveyor?.published == null ? null : formatCount(conveyor.published) },
    { key: "workers", label: "워커", value: !liveness?.length ? null : `${liveness.filter(row => row.reason === "present").length}/${liveness.length} 정상` },
  ];
}

export type ConsoleFlowRow = {
  key: string; label: string; href: string | null;
  tone: ConsoleTone; status: string;
  waiting: number | null;
  /** 최근 처리 — 시간·5분·24시간 중 그 칸이 가진 단위 */
  rate: { value: number; per: "시간" | "5분" | "24시간" } | null;
  /** 지난 23시간(이번 시간은 아직 덜 차서 뺀다) */
  spark: number[] | null;
  /** 추이 칸에 선 대신 적는 말(공개 수 등) */
  note?: string;
};

export type ConsoleStageExecution = {
  label: "순위대로" | "동시에" | "혼합" | "방식 미확인" | "CLI 분류" | "별도 설정";
  detail: string;
};

/** Saved execution policy, not proof of concurrent calls. Reuses the home snapshot without more reads. */
export function consoleStageExecution(stage: string,
  executions: readonly Pick<AiTaskExecutionAdminView, "task" | "slot" | "mode">[] | null,
  ranks: ConsoleTaskInputs["ranks"]): ConsoleStageExecution | null {
  const tasks = stagePanel(stage)?.tasks ?? [];
  if (!tasks.length) return null;
  if (stage === "human" || stage === "audit") return { label: "별도 설정", detail: "기존 위임·감사 설정에서 모델과 실행 조건을 정합니다. 단계 패널에서 설정을 확인할 수 있습니다." };
  const policies = tasks.flatMap<{ label: ConsoleStageExecution["label"]; text: string }>(id => {
    const task = aiTask(id);
    if (!task) return [];
    // Non-live task ranks are inventory only; they do not control that task's model selection.
    if (!isAiLiveTask(id) && id !== "publish-classify") return [{ label: "별도 설정" as const, text: `${task.label}: 별도 모델 설정 사용` }];
    if (!executions || task.slots > 1 && ranks === null) return [{ label: "방식 미확인" as const, text: `${task.label}: 실행 설정${executions ? "의 투표자 구성" : ""}을 읽지 못함` }];
    return Array.from({ length: task.slots }, (_, index) => index + 1).flatMap(slot => {
      const execution = executions.find(entry => entry.task === id && entry.slot === slot);
      // Unused voter slots have fallback defaults in the read DTO, but are not extra execution policies.
      if (slot > 1 && execution?.mode !== "workload_pool" && !ranks?.some(rank => rank.task === id && rank.slot === slot)) return [];
      const label: ConsoleStageExecution["label"] = !execution ? "방식 미확인" : execution.mode === "workload_pool" ? "동시에" : id === "publish-classify" ? "CLI 분류" : "순위대로";
      return [{ label, text: `${task.label}${task.slots > 1 ? ` · ${task.slotLabel ?? "칸"} ${slot}` : ""}: ${label}` }];
    });
  });
  if (!policies.length) return null;
  const labels = new Set(policies.map(policy => policy.label));
  const label = labels.has("방식 미확인") ? "방식 미확인" : labels.size > 1 ? "혼합" : policies[0].label;
  return { label, detail: `${policies.map(policy => policy.text).join(" / ")}. 저장된 실행 방식이며 실제 동시 호출 수를 뜻하지 않습니다.` };
}

const BELT_TONE: Record<BeltTone, ConsoleTone> = { flow: "ok", slow: "warn", jam: "bad", stop: "off", idle: "off", unknown: "off" };

/** 공개 뒤 단계 — 시안 순서. 진행 판정(readWorkerProgress)의 단계 열쇠 */
const POST_PUBLISH = ["tagline-ko", "product-translate", "reason-translate", "intro-check"] as const;

export function buildConsoleFlow(conveyor: Conveyor | null, progress: ConsoleProgress | null, board: Pick<ConsoleTaskBoard, "marks">,
  audit: ConsoleTaskInputs["audit"] = null):
  { main: ConsoleFlowRow[]; post: ConsoleFlowRow[] } {
  const main: ConsoleFlowRow[] = (conveyor?.stations ?? []).map(station => {
    const stopped = board.marks.stopped.includes(station.key);
    return {
      key: station.key, label: station.label, href: consoleStageHref(station.key),
      tone: stopped ? "bad" : BELT_TONE[station.tone], status: stopped ? station.doneHour === 0 ? "멈춤" : "거의 멈춤" : station.status,
      waiting: station.waiting,
      rate: station.doneHour !== null ? { value: station.doneHour, per: "시간" } : station.done5m !== null ? { value: station.done5m, per: "5분" } : null,
      spark: station.spark?.length ? station.spark.slice(0, -1) : null,
    };
  });
  if (conveyor?.human) {
    const human = conveyor.human;
    main.push({ key: "human", label: "사람 확인", href: consoleStageHref("human"), tone: BELT_TONE[human.tone], status: human.status, waiting: human.waiting,
      rate: human.decided24h === null ? null : { value: human.decided24h, per: "24시간" }, spark: null });
  }
  if (conveyor) main.push({ key: "public", label: "공개", href: "/admin/products", tone: conveyor.published === null ? "off" : "ok",
    status: conveyor.published === null ? "미확인" : "게시 중", waiting: null,
    rate: conveyor.publishedHour === null ? null : { value: conveyor.publishedHour, per: "시간" }, spark: null,
    note: conveyor.published === null ? undefined : `공개 ${formatCount(conveyor.published)}` });
  const post: ConsoleFlowRow[] = POST_PUBLISH.map(key => {
    const stage = progress?.stages.find(row => row.stage === key) ?? null;
    const label = CONSOLE_STAGE_LABELS[key];
    // 줄을 누르면 단계 패널(조각 2a) — 진행 단계를 못 읽어도 패널은 열린다(패널이 「셀 수 없음」을 적는다)
    const href = consoleStageHref(key);
    if (!stage) return { key, label, href, tone: "off", status: "미확인", waiting: null, rate: null, spark: null };
    const waiting = stage.waiting ?? null;
    const [tone, status]: [ConsoleTone, string] = stage.reason === "paused" ? ["bad", "멈춤"]
      : !waiting ? ["off", "일감 없음"]
      : board.marks.piling.includes(key) ? ["warn", "쌓임"]
      : stage.alarm ? ["bad", "막힘"] : ["ok", "흐름"];
    return { key, label, href, tone, status, waiting, rate: stage.completed5m == null ? null : { value: stage.completed5m, per: "5분" }, spark: null };
  });
  post.push({ key: "audit", label: "감사 거절", href: consoleStageHref("audit"),
    tone: !audit || audit.open === 0 ? "off" : "warn",
    status: !audit ? "미확인" : audit.open === 0 ? "일감 없음" : audit.overdue > 0 ? "오래 기다림" : "확인 필요",
    waiting: audit?.open ?? null, rate: null, spark: null });
  return { main, post };
}
