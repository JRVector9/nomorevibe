/**
 * PR 1b WP-B 임시 형 선언 — 1b-A 의 `lib/llm/capacity-devices.ts`·`lib/llm/capacity-devices-repository.ts`(origin/claude/devices-wp-a 1811a833)가 아직
 * 이 worktree 에 없는 동안 `npx tsc --noEmit` 이 그 모듈의 공개 형(이 화면이 쓰는 부분)을 보게 한다. 런타임 구현은 없다
 * (테스트는 setCapacityDeviceRepositoryForTest 로 메모리 구현을 끼운다).
 *
 * **1b-A 가 합쳐지면 이 파일을 지운다.** tsc(moduleResolution bundler + paths)는 실제 파일보다 이 ambient 선언을 우선하므로 남겨 두면
 * 1b-A 의 진짜 형을 가린다 — tests/admin-capacity-devices.test.tsx 의 보호 테스트가 둘이 함께 있으면 실패한다.
 */
declare module "@/lib/llm/capacity-devices" {
  export type ModelCapacityDeviceRole = Readonly<{ routeId: string; rank: number }>;
  export type ModelCapacityDeviceSettings = Readonly<{
    deviceId: string; limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number; physicalLimit: number | null;
    roles: readonly ModelCapacityDeviceRole[]; note: string | null }>;
  export type ModelCapacityDeviceRow = ModelCapacityDeviceSettings & Readonly<{ enabled: boolean; version: number; updatedBy: string; createdAt: string; updatedAt: string }>;
  export type ModelCapacityDeviceState = Readonly<{
    deviceId: string; source: "table" | "policy_fallback"; limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number;
    active: number; secondaryActive: number; secondaryBound: number; primaryBusy: boolean; lending: boolean;
    waiting: number; waitingPrimary: number; version: number | null; updatedAt: string | null }>;
  export type ModelCapacityGeneration = Readonly<{ epoch: number; revision: number; policyHash: string }>;
  export const DEFAULT_DEVICE_IDLE_MS: number;
  export const DEFAULT_DEVICE_RESERVE_SLOTS: number;
  export const UNRANKED_ROLE_RANK: number;
  export const MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION: "model-capacity-device-save";
  export function parseModelCapacityDeviceSettings(input: unknown): ModelCapacityDeviceSettings;
  export function deviceFallbackLimit(groupLimits: Readonly<Record<string, unknown>> | null | undefined, deviceId: string): number | null;
}
declare module "@/lib/llm/capacity-devices-repository" {
  import type { ProductTransaction } from "@/lib/domain/products/generation";
  import type { ModelCapacityDeviceRow, ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
  /** actor = 관리자 로그인(updated_by·감사 actor). 저장소가 operations_audit 한 줄을 스스로 쓴다 */
  export function saveModelCapacityDevice(tx: ProductTransaction, input: unknown, expectedVersion: number | null, actor: string):
    Promise<{ before: ModelCapacityDeviceRow | null; after: ModelCapacityDeviceRow }>;
  export function listModelCapacityDevices(tx?: ProductTransaction): Promise<ModelCapacityDeviceRow[]>;
  export function readModelCapacityDevice(deviceId: string, tx?: ProductTransaction): Promise<ModelCapacityDeviceRow | null>;
  export function readModelCapacityDeviceStates(tx?: ProductTransaction): Promise<ModelCapacityDeviceState[]>;
}
