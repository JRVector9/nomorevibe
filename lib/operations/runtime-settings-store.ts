import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_RUNTIME_SETTINGS, resolveRuntimeSettings, storedSettingsVersion, type RuntimeSettings } from "./runtime-settings-schema";

/**
 * 관리자 실시간 한도의 프로세스 스냅샷 + 틱 고정(AsyncLocalStorage).
 *
 * - runtimeSettings() 는 동기이며 던지지 않는다: 고정된 스냅샷 → 프로세스 스냅샷 → 코드 기본값.
 * - ensureRuntimeSettings(maxAgeMs) 는 등록된 loader(setRuntimeSettingsLoader — DB 읽기는 WP-A 가 serving-contract-store 의 같은 reload 에 꽂는다)로
 *   스냅샷을 새로 받는다. loader 가 없거나 실패하면 지금 스냅샷을 그대로 돌려준다.
 * - withRuntimeSettings(snapshot, run) 은 run 안의 모든 읽기가 그 스냅샷을 보게 고정한다(await 를 넘어도) — 알린 예산과 실제로 쓴 상한이 한 판이다(D3).
 *   lastRuntimeSettingsRead 를 남겨 heartbeat 가 "읽은 판"을 싣는다.
 * - 클라이언트 번들에는 들어가지 않는다(translation-policy 를 client 가 import 할 때는 type 만).
 */
export type RuntimeSettingsSnapshot = Readonly<{ version: string; revision: number | null; loadedAt: number; source: "db" | "default"; settings: RuntimeSettings }>;
export type RuntimeSettingsRead = { version: string; at: number; registryEnv: boolean };
/** 스냅샷을 새로 읽는다. null 이면 지금 스냅샷을 유지한다. 던져도 된다(여기서 받는다). */
export type RuntimeSettingsLoader = (maxAgeMs: number) => Promise<RuntimeSettingsSnapshot | null>;
export const RUNTIME_SETTINGS_REFRESH_MS = 30_000;

type State = { snapshot: RuntimeSettingsSnapshot; loader: RuntimeSettingsLoader | null; loading: Promise<void> | null; override: boolean; lastRead: RuntimeSettingsRead | null };
const holder = globalThis as unknown as { __nmvRuntimeSettings?: State };
const pin = new AsyncLocalStorage<RuntimeSettingsSnapshot>();

export function defaultRuntimeSettingsSnapshot(loadedAt = Date.now()): RuntimeSettingsSnapshot {
  return Object.freeze({ version: "default", revision: null, loadedAt, source: "default" as const, settings: DEFAULT_RUNTIME_SETTINGS });
}
const state = (): State => (holder.__nmvRuntimeSettings ??= { snapshot: defaultRuntimeSettingsSnapshot(0), loader: null, loading: null, override: false, lastRead: null });

/**
 * 저장 행(values·revision) → 스냅샷. issues 는 함께 돌려주되 스냅샷은 늘 만든다(읽을 수 없는 키는 기본값).
 * options.models: 덮어쓴 등록부(model_registry_overrides)의 모델 — 그 purposes 만 아는 경로의 한도가 기본값으로 떨어지지 않게 reload 가 넘긴다.
 */
export function runtimeSettingsSnapshotFromStored(stored: unknown, revision: number | null = null, loadedAt = Date.now(),
  options: Parameters<typeof resolveRuntimeSettings>[1] = {}): { snapshot: RuntimeSettingsSnapshot; issues: string[] } {
  const { settings, issues } = resolveRuntimeSettings(stored, options);
  return { snapshot: Object.freeze({ version: storedSettingsVersion(stored), revision, loadedAt, source: "db" as const, settings }), issues };
}

/**
 * WP-A: serving-contract reload(계약·등록부 덮어쓰기·runtime_settings 를 한 SELECT 묶음으로 읽는다)가 읽은 판을 프로세스 스냅샷으로 올린다 —
 * ensureServingContracts(0) 만 부르는 관리자 화면·CLI 도 runtimeSettings() 로 같은 판을 본다. 테스트 고정이 켜져 있으면 무시한다. 고정된 틱(pin)은 건드리지 않는다.
 */
export function publishRuntimeSettingsSnapshot(snapshot: RuntimeSettingsSnapshot): void {
  const current = state();
  if (!current.override) current.snapshot = snapshot;
}

/** 고정된 스냅샷이 있으면 그것, 없으면 프로세스 스냅샷. 동기, 던지지 않는다. */
export function runtimeSettingsSnapshot(): RuntimeSettingsSnapshot { return pin.getStore() ?? state().snapshot; }
export function runtimeSettings(): RuntimeSettings { return runtimeSettingsSnapshot().settings; }

/** WP-A: DB reload 를 꽂는다. null 이면 뺀다(기본값만). 테스트 고정(setRuntimeSettingsForTest)이 켜져 있으면 loader 는 불리지 않는다. */
export function setRuntimeSettingsLoader(loader: RuntimeSettingsLoader | null): void { state().loader = loader; }

/** maxAgeMs 보다 오래된 프로세스 스냅샷이면 loader 로 새로 받는다. 던지지 않는다; 실패하면 지금 스냅샷을 돌려준다. */
export async function ensureRuntimeSettings(maxAgeMs = RUNTIME_SETTINGS_REFRESH_MS): Promise<RuntimeSettingsSnapshot> {
  const current = state();
  if (current.loader && !current.override && Date.now() - current.snapshot.loadedAt >= maxAgeMs) {
    current.loading ??= (async () => {
      try {
        const next = await current.loader!(maxAgeMs);
        if (next) current.snapshot = next;
        // loader 가 null 을 주면(바뀐 것 없음·읽기 실패) 다음 간격까지 다시 묻지 않는다
        else current.snapshot = { ...current.snapshot, loadedAt: Date.now() };
      } catch {
        current.snapshot = { ...current.snapshot, loadedAt: Date.now() };
      }
    })().finally(() => { current.loading = null; });
    await current.loading;
  }
  return runtimeSettingsSnapshot();
}

/** run 안의 읽기를 snapshot 에 고정한다(await 를 넘어도). 이 프로세스가 마지막으로 읽은 판으로 기록한다. */
export function withRuntimeSettings<T>(snapshot: RuntimeSettingsSnapshot, run: () => T): T {
  state().lastRead = { version: snapshot.version, at: Date.now(), registryEnv: !!process.env.MODEL_REGISTRY_CONFIG?.trim() };
  return pin.run(snapshot, run);
}
/** 이 프로세스가 잡 틱에서 마지막으로 고정한 판·시각·env 등록부 여부(MODEL_REGISTRY_CONFIG 가 있으면 경로 한도 저장이 닿지 않는다). 아직 없으면 null */
export function lastRuntimeSettingsRead(): RuntimeSettingsRead | null { return state().lastRead; }

/** 테스트·리플레이: 저장 문서를 고정하고 loader 를 멈춘다. null 이면 기본값·정상 로딩으로 돌아간다. */
export function setRuntimeSettingsForTest(stored: unknown | null): void {
  const current = state();
  current.override = stored !== null;
  current.snapshot = stored === null ? defaultRuntimeSettingsSnapshot(0) : runtimeSettingsSnapshotFromStored(stored, null).snapshot;
  if (stored === null) current.lastRead = null;
}
