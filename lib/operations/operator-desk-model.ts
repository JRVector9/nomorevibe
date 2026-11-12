import { aiTask, aiTaskSlotLabel } from "@/lib/llm/ai-tasks";

/**
 * 운영자 책상 — 전체 흐름(/admin/flow) 한 장의 "1인 관리자 필수 칸" 모양과 순수 판정. DB 를 읽지 않는다(읽기는 app/(operator)/admin/flow/desk.ts).
 *
 * 칸은 여섯이다. 고른 까닭은 2026-11-02 실제 사고에서 나왔다(docs/design/admin-redesign-2026-11.md):
 * - 받은함(alerts): 운영센터 "지금 조치"와 같은 buildActions — 경보를 한 곳에서 본다.
 * - 결정함(decisions): 오늘 할 일(inbox)의 칸 중 사람만 할 수 있는 것.
 * - 최근 바뀐 설정(changes): 작업 로그(operations_audit)의 설정·모델·작업 제어 줄과 "되돌리는 곳". 11-02 21:13Z 순위가 드롭다운 저장으로
 *   지워진 것을 운영자가 한참 뒤에 알았다 — 바뀐 설정이 흐름 옆에 있어야 원인과 결과를 같이 본다.
 * - 장비·모델 서버(equipment): 장부 경보(dispatch_stuck 등)와 장비별 점유. 11-02 죽은 dispatched 5건이 supa-direct 4칸·gpu3090 1칸을 잡았다.
 * - 점검 창(window): 모델 접수 OPEN/DRAIN 과 역할 lease(주·예비). M3 커널 패닉 뒤 예비가 lease 를 쥐고 놓지 않는 일이 반복됐다.
 * - 부재 중(away): 내가 마지막으로 작업 로그에 남긴 때 이후 — 발행·새 보류·다른 사람(또는 도구)의 설정 변경.
 */

export type DeskAlert = { key: string; tone: "critical" | "hold" | "clear"; title: string; count: string; href: string | null; actionLabel: string | null };
export type DeskDecision = { key: string; title: string; hint: string; count: number; tone: "critical" | "warn"; href: string; action: string; oldestAt: string | null };
/** 「할 일 → 모두 보기」 서랍의 칸 — 예전 오늘 할 일(/admin/inbox) 칸 하나. rows 는 오래 기다린 것부터 다섯 줄(사유 코드는 사람 말로 바꿔 둔다) */
export type DeskInboxRow = { id: string; name: string; why: string; since: string | null };
export type DeskInboxSection = { key: string; title: string; hint: string; href: string; action: string; tone: "critical" | "warn";
  /** null — 이 칸을 읽지 못했다(0 이 아니다) */
  count: number | null; note: string | null; rows: DeskInboxRow[] };
export type DeskUndo = { text: string; href: string | null };
export type DeskChange = { id: number; at: string; actor: string; action: string; label: string; target: string; ok: boolean; undo: DeskUndo };
export type DeskDevice = { id: string; name: string; held: number; limit: number | null; lending: boolean; stuck: number };
export type DeskRole = { role: string; host: string | null; reason: string; ok: boolean; text: string };
export type LedgerStatus = "ok" | "review" | "alarm" | "unknown";

export type OperatorDesk = {
  measuredAt: string;
  alerts: { critical: number; hold: number; items: DeskAlert[] } | null;
  /**
   * 결정함 — items 는 일이 있는 칸(머리 목록), sections·clear·done 은 「모두 보기」 서랍(예전 오늘 할 일 화면 그대로: 일이 있거나 못 읽은 칸,
   * 할 일 없는 칸 이름, 최근 24시간 처리 수 — 하나도 못 읽으면 null)
   */
  decisions: { remaining: number; failed: number; items: DeskDecision[]; done: number | null; sections: DeskInboxSection[];
    clear: { key: string; title: string; href: string }[] } | null;
  changes: DeskChange[] | null;
  equipment: {
    observedAt: string | null;
    devices: DeskDevice[];
    ledger: { status: LedgerStatus; reasons: string[]; stuckDispatched: number; reviewCount: number; oldestAgeSeconds: number | null; stuckThresholdSeconds: number };
    servers: { name: string; ok: boolean; error?: string }[];
  } | null;
  window: { admission: "open" | "draining" | "disabled" | null; admissionSince: string | null; roles: DeskRole[]; schedulerAlarm: boolean } | null;
  away: { since: string; fromMyLastAction: boolean; published: number | null; newHolds: number | null; othersChanges: DeskChange[]; myLogin: string } | null;
};

/**
 * "최근 바뀐 설정"에 올리는 작업과 되돌리는 곳. 작업 로그는 덧붙이기만 해서 줄 자체를 지울 수 없다 — 되돌리기는 늘 "그 화면에서 이전 값으로 다시 저장"이고,
 * 이전 값은 작업 로그 줄의 detail(전·후)에 있다. 되돌릴 수 없는 것은 그렇게 적는다(href null).
 */
export const CHANGE_UNDO: Readonly<Record<string, (target: string) => DeskUndo>> = {
  "ai-task-models-save": () => ({ text: "이전 순위로 다시 저장(「바꾸기」 되돌리기·작업 ↔ AI 모델)", href: "/admin/models#tasks" }),
  "ai-task-execution-save": () => ({ text: "「작업 ↔ AI 모델」에서 이전 실행 방식·분산 모델로 다시 저장", href: "/admin/models#tasks" }),
  "ai-task-models-import": () => ({ text: "「작업 ↔ AI 모델」에서 칸별로 이전 순위로 다시 저장", href: "/admin/models#tasks" }),
  "ai-connection-save": () => ({ text: "「작업 ↔ AI 모델」 연결 편집에서 이전 값으로 저장", href: "/admin/models#tasks" }),
  "ai-connection-delete": () => ({ text: "지운 연결은 다시 만들어야 합니다(키는 다시 넣음)", href: "/admin/models#tasks" }),
  "runtime-settings-save": () => ({ text: "「실시간 한도」에서 작업 로그의 이전 값으로 다시 저장", href: "/admin/models/limits" }),
  "model-capacity-device-save": () => ({ text: "「장비 한도」에서 이전 칸 수로 다시 저장", href: "/admin/models/devices" }),
  "model-capacity-route-quota-save": () => ({ text: "작업 로그의 이전 경로 몫(보장·상한·빌려주기)으로 다시 저장", href: "/admin/models/devices" }),
  "model-capacity-model-limit-save": () => ({ text: "작업 로그의 이전 모델 상한으로 다시 저장", href: "/admin/models/devices" }),
  "model-capacity-device-retire": () => ({ text: "지운 장비는 「장비 한도」에서 다시 만들고 「작업 ↔ AI 모델」 순위를 저장하면 route 가 다시 붙습니다(작업 로그의 이전 값)", href: "/admin/models/devices" }),
  "model-capacity-routes-prune": () => ({ text: "뺀 route 는 그 모델을 「작업 ↔ AI 모델」 순위로 다시 저장하면 다시 붙습니다(DRAIN 없음)", href: "/admin/models#tasks" }),
  "model-serving-contract-save": () => ({ text: "「서빙 계약·등록부」에서 이 계약을 끄면 이전 경로로 돌아갑니다", href: "/admin/models/contracts" }),
  "model-serving-contract-disable": () => ({ text: "「서빙 계약·등록부」에서 같은 계약을 다시 저장", href: "/admin/models/contracts" }),
  "model-registry-override-save": () => ({ text: "「서빙 계약·등록부」에서 덮어쓰기를 끄면 코드 기본값으로 돌아갑니다", href: "/admin/models/contracts" }),
  "model-registry-override-disable": () => ({ text: "「서빙 계약·등록부」에서 덮어쓰기를 다시 저장", href: "/admin/models/contracts" }),
  "model-assignment-save": () => ({ text: "「모델 배정 표」에서 배정 끄기", href: "/admin/models/assignments" }),
  "model-helper-save": () => ({ text: "「도우미·감시자」에서 이전 값으로 저장", href: "/admin/models/helpers" }),
  "model-helper-mode": () => ({ text: "「도우미·감시자」에서 모드를 다시 바꿈", href: "/admin/models/helpers" }),
  "model-capacity-unknown-reviewed": () => ({ text: "되돌릴 수 없음 — 닫은 검토는 다시 열리지 않습니다(점유에는 영향 없음)", href: null }),
  "job-pause": (target) => ({ text: "같은 작업을 사유와 함께 재개(멈추기 전 재시도 시각이 돌아옵니다)", href: `/admin/status?tab=jobs&job=${encodeURIComponent(target)}` }),
  "job-resume": (target) => ({ text: "같은 작업을 사유와 함께 다시 멈춤", href: `/admin/status?tab=jobs&job=${encodeURIComponent(target)}` }),
  "collection-enabled": () => ({ text: "운영센터에서 수집을 다시 켜거나 끔", href: "/admin/status" }),
  "source-buffer": () => ({ text: "운영센터 원본 공급 조절을 다시 바꿈", href: "/admin/status?tab=crawlers" }),
  "settings-save": () => ({ text: "「크롤 설정」에서 작업 로그의 바뀐 값(전·후)대로 다시 저장", href: "/admin" }),
  "split-tiebreak-settings": () => ({ text: "심사 큐의 「갈림 판가름」 스위치를 다시 바꿈", href: "/admin/review" }),
  "held-qwen-retry-settings": () => ({ text: "심사 큐의 「보류 재심사」 스위치를 다시 바꿈", href: "/admin/review" }),
  "qwen-auto-settings": () => ({ text: "심사 큐의 자동 단계 스위치를 다시 바꿈", href: "/admin/review" }),
  "review-mode": () => ({ text: "심사 큐에서 발행 관문 모드를 다시 바꿈", href: "/admin/review" }),
  "human-review-deepseek": () => ({ text: "「사람 위임 모델」에서 사람 검토 스위치를 다시 바꿈", href: "/admin/models/human" }),
};
export const CHANGE_ACTIONS = Object.keys(CHANGE_UNDO);

/** 순위 저장의 대상(감사 target `task#slot`)은 사람 말 작업 이름으로(「2차 AI 검수 · 투표자 1」). 모르는 작업·다른 동작은 그대로 */
function changeTarget(action: string, target: string): string {
  if (action !== "ai-task-models-save" && action !== "ai-task-execution-save") return target;
  const [id, slot] = target.split("#");
  const task = aiTask(id);
  return task ? aiTaskSlotLabel(task, Number(slot) || 1) : target;
}

/** 작업 로그 줄 → 바뀐 설정 한 줄. 이름표는 작업 로그 화면과 같은 것(labels.ts)을 넘겨받는다 */
export function deskChange(row: { id: number; createdAt: string; actor: string; action: string; target: string; ok: boolean },
  label: (action: string) => string): DeskChange {
  const undo = CHANGE_UNDO[row.action]?.(row.target) ?? { text: "작업 로그에서 전·후 값을 보고 그 화면에서 다시 저장", href: `/admin/activity?target=${encodeURIComponent(row.target)}` };
  return { id: row.id, at: row.createdAt, actor: row.actor, action: row.action, label: label(row.action), target: changeTarget(row.action, row.target), ok: row.ok, undo };
}

/** 부재 중의 시작 — 내가 마지막으로 작업 로그에 남긴 때. 없거나 72시간보다 오래면 72시간 전, 1시간 안이면 1시간 전(너무 짧은 창은 볼 것이 없다) */
export function awaySince(now: string, myLastAction: string | null): { since: string; fromMyLastAction: boolean } {
  const nowMs = Date.parse(now);
  const last = myLastAction ? Date.parse(myLastAction) : NaN;
  if (!Number.isFinite(last) || nowMs - last > 72 * 3_600_000) return { since: new Date(nowMs - 72 * 3_600_000).toISOString(), fromMyLastAction: false };
  return { since: new Date(Math.min(last, nowMs - 3_600_000)).toISOString(), fromMyLastAction: true };
}

const ROLE_TEXT: Record<string, string> = {
  ready: "주가 일함", primary_missing: "주 없음", standby_missing: "예비 없음", lease_missing: "lease 없음", lease_expired: "lease 만료",
  owner_mismatch: "주인 불일치", release_mismatch: "릴리스 불일치", primary_quarantined: "주 격리 중", standby_active: "예비가 일함",
};
/** 역할 lease 한 줄 — 예비가 일하는 것(standby_active)도 경보다: 예비는 스스로 양보하지 않는다(role-leader.ts) */
export function deskRole(row: { role: string; reason: string; host: string | null }): DeskRole {
  return { role: row.role, host: row.host, reason: row.reason, ok: row.reason === "ready" || row.reason === "standby_missing", text: ROLE_TEXT[row.reason] ?? row.reason };
}

/** 장비별 점유 — 전송 중(dispatched)인데 문턱을 넘긴 요청 수를 장비에 붙인다(dispatch_stuck 이 어느 장비를 잡고 있는지) */
export function deskDevices(groups: readonly { groupId: string; held: number; limit: number | null; lending: boolean }[],
  requests: readonly { groupId: string; state: string; dispatchedAt: string | null }[], now: string, stuckSeconds: number,
  name: (groupId: string) => string): DeskDevice[] {
  const nowMs = Date.parse(now);
  const stuck = new Map<string, number>();
  for (const request of requests) {
    if (request.state !== "dispatched" || !request.dispatchedAt) continue;
    if ((nowMs - Date.parse(request.dispatchedAt)) / 1000 < stuckSeconds) continue;
    stuck.set(request.groupId, (stuck.get(request.groupId) ?? 0) + 1);
  }
  return groups.map((group) => ({ id: group.groupId, name: name(group.groupId), held: group.held, limit: group.limit, lending: group.lending, stuck: stuck.get(group.groupId) ?? 0 }))
    .sort((a, b) => b.stuck - a.stuck || b.held - a.held || a.id.localeCompare(b.id));
}

/** 책상 칸들의 요약 상태 — 머리 줄의 작은 알약에 쓴다 */
export function deskSignals(desk: OperatorDesk) {
  const ledger = desk.equipment?.ledger.status ?? "unknown";
  const roleAlarm = desk.window ? desk.window.roles.some((role) => !role.ok) || desk.window.schedulerAlarm : null;
  return {
    alerts: desk.alerts ? desk.alerts.critical : null,
    decisions: desk.decisions ? desk.decisions.remaining : null,
    ledger, roleAlarm,
    admission: desk.window?.admission ?? null,
  };
}
