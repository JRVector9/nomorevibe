import { AI_TASK_POOL_LANES_MAX, AI_TASK_POOL_MEMBER_SLOTS_MAX, aiTaskPoolCappedLanes, aiTaskPoolFeatures } from "@/lib/llm/ai-task-execution-config";
import { aiModelChoiceName, type AiConnectionView, type AiRankChoice } from "./admin-ai-tasks";

/**
 * 「동시에」 도움말(2026-11-12 소유자 「이런 내용을 설명에 적어줘, 툴팁같은거 하나 만들어서」) — 작업 배정의 실행 방식 폼과 단계 패널의 모델 구역이 같이 쓴다.
 * 순수 함수만. 숫자는 모두 읽은 값(장비 한도 model_capacity_devices · 실시간 한도 runtime_settings · 수집·판정 설정)에서 오고, 규칙 문장은 실행 쪽 코드
 * (lib/llm/ai-task-execution-config.ts aiTaskPoolCappedLanes · lib/llm/ai-task-resolver.ts TextTaskRanks.lanes · 1차 lib/crawl/jobs/agent-review.ts ·
 * 2차 lib/crawl/second-review-workload.ts)가 하는 그대로 적는다.
 */

/** 장비 한 줄 — 운영 한도(limit_slots)와 모델별 상한(model_limits[].max_slots, 장부의 모델 글자로 맞춤) */
export type PoolHelpDevice = Readonly<{ deviceId: string; limitSlots: number | null; enabled: boolean;
  modelLimits: readonly Readonly<{ model: string; maxSlots: number }>[] }>;

/**
 * 칸 수를 비웠을 때 이 작업 전체의 동시 처리 수가 어디서 오나(실행 쪽 그대로).
 * - route: 글 작업 — 「<작업> 동시 호출」(runtime_settings routes.limits.<경로>.concurrency). roundsMax 는 공개 번역의 한 틱 고르기 상한(그 값에서 자른다)
 * - one: 사유 번역 — 칸 수가 없으면 한 줄로 차례차례(동시 1)
 * - review: 1차 심사 — 칸 수와 상관없이 「심사 동시 수」(수집·판정 설정 reviewConcurrency, 16 에서 자름)만큼 한 틱에 함께 본다
 * - consumer: 2차 심사(투표자 1) — 소비자가 한꺼번에 맡는 후보 수(runtime_settings jobs.second-review.consumerConcurrency)
 */
export type PoolHelpBase =
  | Readonly<{ kind: "route"; label: string; path: string; value: number | null; roundsMax?: number }>
  | Readonly<{ kind: "one" }>
  | Readonly<{ kind: "review"; value: number | null; max: number }>
  | Readonly<{ kind: "consumer"; path: string; value: number | null }>;

/** 서버가 한 번 읽어 넘기는 값 — 못 읽은 것은 null(지어내지 않는다) */
export type PoolHelpContext = Readonly<{ devices: readonly PoolHelpDevice[] | null; bases: Readonly<Record<string, PoolHelpBase>> }>;

/** 칸 수 권장의 근거 — 어느 상한이 가장 좁았나 */
export type PoolHelpBound = "model" | "device" | "slots-max" | "unknown";
export type PoolHelpRow = Readonly<{
  /** deviceId 는 같은 서버를 쓰는 모델을 묶을 때만 쓴다 — 화면에는 모델 이름만 낸다(2026-11-12 소유자 「모델 사용량만 보면 돼」) */
  index: number; order: number; name: string; deviceId: string | null;
  /** 권장 칸 수 = 이 모델이 동시에 받을 수 있는 수(그 서버의 운영 한도 · 그 서버에서 이 모델의 상한 · 칸 수 상한 8 중 가장 작은 값). 못 읽으면 null */
  recommended: number | null; bound: PoolHelpBound; reason: string;
  /** 지금 적은 칸 수(빈 칸·잘못 적은 칸은 null) */
  slots: number | null;
  /** 같은 엔진(같은 연결·모델·장비)이 앞 줄에도 있으면 그 줄 차례 */
  twinOf: number | null;
  warnings: readonly string[];
}>;
export type PoolHelpView = Readonly<{
  taskLabel: string; caps: boolean; reserve: boolean;
  /** 칸 수 상태 — none(모두 비움) · all(모두 적음) · partial(일부만 — 저장 거절) */
  capsState: "none" | "all" | "partial";
  /** 모두 적었을 때 함께 처리하는 수(합, 16 에서 자름) */
  lanes: number | null;
  base: PoolHelpBase | null;
  rows: readonly PoolHelpRow[];
  /** 「2개를 동시에 쓰는 방법 …」 — 권장 칸 수가 2 이상인 첫 모델로 */
  example: string | null;
  /** 같은 서버를 쓰는 모델끼리 한도를 합치면 서버 전체를 넘을 때만 — 「m3-deepseek와 함께 쓰는 서버라 둘을 합쳐 3개까지」 */
  shared: readonly string[];
  devicesRead: boolean;
}>;

// ── 한국어 조사 ─────────────────────────────────────────────────────────────
const DIGIT_FINAL = [true, true, false, true, false, false, true, true, true, false]; // 영·일·이·삼·사·오·육·칠·팔·구 — 받침 있음
/** 마지막 글자에 받침이 있나 — 한글은 정확히, 숫자는 읽는 소리로, 영문은 l·m·n 으로 끝나면 받침으로 본다(「qwen을」, 「gemma를」, 「gpt-oss를」) */
export function hasFinalConsonant(word: string): boolean {
  const last = word.trim().replace(/[)\]」』"'.\s]+$/u, "").slice(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return DIGIT_FINAL[Number(last)];
  return /[lmn]/i.test(last);
}
/** 을/를 */
export const objectParticle = (word: string) => hasFinalConsonant(word) ? "을" : "를";
/** 은/는 */
export const topicParticle = (word: string) => hasFinalConsonant(word) ? "은" : "는";
/** 와/과 */
export const withParticle = (word: string) => hasFinalConsonant(word) ? "과" : "와";
const COUNT_WORDS = ["", "하나", "둘", "셋", "넷", "다섯", "여섯", "일곱", "여덟"];
/** 「이 모델은 동시에 2개까지」 */
export const modelLimitText = (name: string, limit: number) => `${name}${topicParticle(name)} 동시에 ${limit}개까지`;

// ── 권장 칸 수 ──────────────────────────────────────────────────────────────
type HelpConnection = Pick<AiConnectionView, "id" | "label" | "kind" | "models" | "cliModels" | "deviceId"> &
  Partial<Pick<AiConnectionView, "displayName" | "cliTool" | "cliCatalog" | "manualModels">>;

/** 장비의 모델별 상한 — 장부가 쓰는 모델 글자(모델 이름 · 「모델@연결 앞 8자」)로 맞춘다(모델 화면 model-console 과 같은 맞춤) */
export function deviceModelCap(device: PoolHelpDevice | null, connectionId: string, model: string): number | null {
  if (!device) return null;
  const names = new Set([model, `${model}@${connectionId.slice(0, 8)}`]);
  return device.modelLimits.find(limit => names.has(limit.model))?.maxSlots ?? null;
}

/**
 * 이 모델에 권할 칸 수 — 그 서버의 운영 한도 · 그 서버에서 이 모델의 상한 · 칸 수 상한(8) 중 가장 작은 값.
 * 근거는 모델의 한도로 말한다(「m1-gemma는 동시에 2개까지」) — 어느 서버·칸인지는 적지 않는다.
 */
export function recommendSlots(connection: HelpConnection | null, model: string, devices: readonly PoolHelpDevice[] | null, name: string)
  : { recommended: number | null; bound: PoolHelpBound; reason: string; deviceId: string | null } {
  const deviceId = connection?.deviceId ?? null;
  if (!connection || !deviceId) return { recommended: null, bound: "unknown", reason: "연결을 찾지 못했습니다", deviceId };
  if (!devices) return { recommended: null, bound: "unknown", reason: "한도를 읽지 못했습니다", deviceId };
  const device = devices.find(row => row.deviceId === deviceId && row.enabled) ?? null;
  const modelCap = deviceModelCap(device, connection.id, model);
  const deviceCap = device?.limitSlots ?? null;
  if (modelCap === null && deviceCap === null) return { recommended: null, bound: "unknown", reason: `${name}의 동시 한도가 정해져 있지 않습니다`, deviceId };
  const limit = Math.max(1, Math.min(...[modelCap, deviceCap].filter((value): value is number => value !== null)));
  const bound: PoolHelpBound = modelCap !== null && modelCap <= (deviceCap ?? Infinity) ? "model" : "device";
  if (limit > AI_TASK_POOL_MEMBER_SLOTS_MAX)
    return { recommended: AI_TASK_POOL_MEMBER_SLOTS_MAX, bound: "slots-max", reason: `${modelLimitText(name, limit)} · 칸 수는 ${AI_TASK_POOL_MEMBER_SLOTS_MAX}까지`, deviceId };
  return { recommended: limit, bound, reason: modelLimitText(name, limit), deviceId };
}

/**
 * 같은 서버를 쓰는 모델끼리 — 고른 모델의 한도와 그 서버의 다른 모델 상한(장비 줄의 모델별 상한 · 같이 고른 모델)을 합치면 서버 전체 한도를 넘을 때만 한 문장.
 * 서버 이름은 적지 않고 함께 쓰는 모델 이름만 적는다(「m3-deepseek와 함께 쓰는 서버라 둘을 합쳐 3개까지입니다.」).
 */
function sharedServerNotes(rows: readonly PoolHelpRow[], connections: readonly HelpConnection[], devices: readonly PoolHelpDevice[] | null): string[] {
  if (!devices) return [];
  const notes: string[] = [];
  for (const deviceId of [...new Set(rows.flatMap(row => row.deviceId && row.recommended !== null ? [row.deviceId] : []))]) {
    const device = devices.find(entry => entry.deviceId === deviceId && entry.enabled);
    if (!device?.limitSlots) continue;
    // 이 서버의 모델마다 한도(이름 하나로) — 고른 모델은 권장 값, 그 밖은 장비 줄의 모델별 상한(서버 한도에서 자름)
    const limits = new Map<string, number>();
    for (const row of rows) if (row.deviceId === deviceId && row.recommended !== null) limits.set(row.name, row.recommended);
    for (const limit of device.modelLimits) {
      const owner = connections.map(connection => ({ connection, model: connection.deviceId === deviceId ? connectionModelOf(connection, limit.model) : null }))
        .find(entry => entry.model !== null);
      const name = owner ? aiModelChoiceName(owner.connection, owner.model) : limit.model.replace(/@[0-9a-f]{8}$/i, "");
      if (!limits.has(name)) limits.set(name, Math.min(limit.maxSlots, device.limitSlots));
    }
    const total = [...limits.values()].reduce((sum, value) => sum + value, 0);
    if (limits.size < 2 || total <= device.limitSlots) continue;
    const mine = new Set(rows.filter(row => row.deviceId === deviceId).map(row => row.name));
    const others = [...limits.keys()].filter(name => !mine.has(name));
    const lead = (others.length ? others : [...limits.keys()].slice(1)).join("·");
    const count = COUNT_WORDS[limits.size] ?? `${limits.size}개`;
    notes.push(`${lead}${withParticle(lead)} 함께 쓰는 서버라 ${count}${objectParticle(count)} 합쳐 ${device.limitSlots}개까지입니다.`);
  }
  return notes;
}

/** 장비 줄의 모델 글자(「모델」 또는 「모델@연결 앞 8자」)가 이 연결의 어느 모델인가 */
function connectionModelOf(connection: HelpConnection, ledgerModel: string): string | null {
  const bare = ledgerModel.endsWith(`@${connection.id.slice(0, 8)}`) ? ledgerModel.slice(0, -9) : ledgerModel;
  const models = [...(connection.models ?? []).map(model => model.id), ...connection.cliModels];
  return models.includes(bare) ? bare : null;
}

/** 칸 수 글자 → 1~8 의 수(아니면 null) */
const slotNumber = (raw: string | undefined): number | null => {
  const text = (raw ?? "").trim(), value = Number(text);
  return text && Number.isInteger(value) && value >= 1 && value <= AI_TASK_POOL_MEMBER_SLOTS_MAX ? value : null;
};

/** 칸 수가 권장을 넘을 때의 말 — 「이 모델은 동시에 2개까지라 넘는 칸은 쓰이지 않습니다」 */
export const overBoundWarning = (bound: number) => `이 모델은 동시에 ${bound}개까지라 넘는 칸은 쓰이지 않습니다`;
export const TWIN_WARNING = "같은 모델이 두 줄 — 칸 수로 늘리세요";

/**
 * 도움말 한 벌 — 지금 고른 모델(draft)과 칸 수로 다시 센다(고칠 때마다 바뀐다).
 * members: 자리 1~4 의 고른 모델(빈 자리 null) · slots: 자리마다 칸 수 글자.
 */
export function buildPoolHelp(input: { task: string; slot: number; taskLabel: string; members: readonly (AiRankChoice | null)[]; slots: readonly string[];
  connections: readonly HelpConnection[]; context: PoolHelpContext | null }): PoolHelpView {
  const features = aiTaskPoolFeatures(input.task, input.slot);
  const devices = input.context?.devices ?? null;
  const chosen = input.members.flatMap((choice, index) => choice ? [{ choice, index }] : []);
  const rows: PoolHelpRow[] = chosen.map(({ choice, index }, order) => {
    const connection = input.connections.find(row => row.id === choice.provider) ?? null;
    const name = connection ? aiModelChoiceName(connection, choice.model) : "지워진 연결";
    const rec = recommendSlots(connection, choice.model, devices, name);
    const twin = chosen.slice(0, order).findIndex(entry => entry.choice.provider === choice.provider && entry.choice.model === choice.model);
    const slots = features.slotCaps ? slotNumber(input.slots[index]) : null;
    const warnings: string[] = [];
    if (twin >= 0) warnings.push(TWIN_WARNING);
    if (slots !== null && rec.recommended !== null && slots > rec.recommended && rec.bound !== "slots-max") warnings.push(overBoundWarning(rec.recommended));
    return { index, order: order + 1, name, deviceId: rec.deviceId, recommended: rec.recommended, bound: rec.bound, reason: rec.reason, slots,
      twinOf: twin >= 0 ? twin + 1 : null, warnings };
  });
  const filled = features.slotCaps ? chosen.filter(({ index }) => (input.slots[index] ?? "").trim() !== "").length : 0;
  const capsState = !filled ? "none" : filled === chosen.length ? "all" : "partial";
  const lanes = capsState === "all" ? aiTaskPoolCappedLanes({ task: input.task, slot: input.slot, mode: "workload_pool",
    members: rows.map(row => ({ maxSlots: row.slots })) }) : null;
  const sample = rows.find(row => row.twinOf === null && (row.recommended ?? 0) >= 2);
  const example = features.slotCaps && sample
    ? `${sample.recommended}개를 동시에 쓰는 방법: ${sample.name}${objectParticle(sample.name)} 한 줄만 넣고 「칸 수」에 ${sample.recommended}${objectParticle(String(sample.recommended))} 적으면 됩니다.`
    : null;
  return { taskLabel: input.taskLabel, caps: features.slotCaps, reserve: features.reserve, capsState, lanes, base: input.context?.bases[input.task] ?? null,
    rows, example, shared: features.slotCaps ? sharedServerNotes(rows, input.connections, devices) : [], devicesRead: devices !== null };
}

/** 자리(1~4)마다의 줄 옆 경고 — 도움말을 열지 않아도 보인다 */
export function poolHelpWarnings(view: PoolHelpView, size = 4): string[][] {
  return Array.from({ length: size }, (_, index) => [...view.rows.find(row => row.index === index)?.warnings ?? []]);
}

/** 칸 수를 비웠을 때의 동시 처리 문장 — 실행 쪽 그대로 */
export function poolBaseText(view: Pick<PoolHelpView, "taskLabel" | "base">): string {
  const base = view.base;
  if (!base) return `칸 수를 비우면 이 작업의 단계 동시 수를 모델끼리 나눠 씁니다(지금 값을 읽지 못했습니다).`;
  const now = (value: number | null) => value === null ? "지금 값을 읽지 못함" : `지금 ${value}`;
  switch (base.kind) {
    case "route": {
      const effective = base.value === null ? null : base.roundsMax ? Math.min(base.value, base.roundsMax) : base.value;
      const rounds = base.roundsMax && base.value !== null && base.value > base.roundsMax ? ` 다만 한 틱에 고르는 차례가 ${base.roundsMax}번까지라 ${base.roundsMax}개에서 자릅니다.` : "";
      return `칸 수를 비우면 ${view.taskLabel} 전체 동시 처리 수가 「${base.label}」 한도(${now(base.value)})를 따릅니다 — 모델이 몇 개든 합쳐서 ${effective ?? "그 수"}개입니다.${rounds}`;
    }
    case "one": return `칸 수를 비우면 ${view.taskLabel}은 한 줄로 차례차례(동시 1개) 처리합니다 — 모델이 몇 개든 합쳐서 1개입니다.`;
    case "review": return `1차 심사는 칸 수와 상관없이 한 틱에 「심사 동시 수」(수집·판정 설정, ${now(base.value)}, ${base.max}에서 자름)만큼 후보를 함께 봅니다. `
      + "칸 수는 모델마다 동시에 맡는 후보(살아 있는 장부 줄) 상한입니다 — 칸이 찬 모델은 고르지 않고, 남은 모델 중에서만 줄에 섭니다.";
    case "consumer": return `2차 심사는 칸 수와 상관없이 소비자가 한꺼번에 맡는 후보 수(「2차 심사 소비자」, ${now(base.value)})만큼 함께 봅니다. `
      + "칸 수는 모델마다 아직 끝나지 않은 표 상한입니다 — 칸이 찬 모델에는 새 표를 주지 않습니다.";
  }
}

/** 칸 수를 모두 적었을 때의 문장 */
export function poolCapsText(view: Pick<PoolHelpView, "base" | "lanes" | "taskLabel">): string {
  if (view.base?.kind === "review" || view.base?.kind === "consumer")
    return "칸 수는 모든 줄에 적거나 모두 비워야 저장됩니다(일부만 적으면 저장을 거절합니다).";
  return `모든 줄에 칸 수를 적으면 그 합(최대 ${AI_TASK_POOL_LANES_MAX})이 ${view.taskLabel}의 동시 처리 수가 되고, 모델마다 적은 칸 수를 넘겨 보내지 않습니다`
    + `${view.lanes !== null ? `(지금 적은 대로면 ${view.lanes}개)` : ""}. 일부 줄에만 적으면 저장을 거절합니다.`;
}

/** 예비 문장 */
export function poolReserveText(view: Pick<PoolHelpView, "base">): string {
  if (view.base?.kind === "consumer") return "예비: 켜면 구성원이 모두 칸 수에 닿거나 쓸 수 없을 때 저장된 순위의 첫 쓸 수 있는 순위가 표를 받습니다. 끄면 그 후보는 기다립니다.";
  return "예비: 켜면 구성원이 모두 차거나 쉴 때 순위대로(1·2·3순위)가 넘겨받습니다. 끄면 예비 없이 기다립니다.";
}
