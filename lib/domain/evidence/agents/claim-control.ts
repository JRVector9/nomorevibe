import { eq, sql } from 'drizzle-orm';
import { agentRepositoryClaims, agentScanControl } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { consumerInstancePrefix } from '@/lib/runtime/consumer-registry';

/**
 * 제작 근거 스캔의 모드(agent_scan_control, 0104). pipeline_stage_modes 와 같은 뜻이다(lib/jobs/items/repository.ts).
 *
 * | 모드 | legacy 잡 스캔 쓰기 | consumer 기록 |
 * | legacy | 허용 | 거절 |
 * | draining(from legacy) | 진행 중이던 것 허용 | 거절 |
 * | items | 거절 | 허용(control epoch 일치) |
 * | draining(from items) | 거절 | 진행 중이던 것 허용(control epoch 일치) |
 *
 * lock 순서: (DR fence SHARE) → stage SHARE → 이 행 → 저장소 identity → claim 행 → 스캔 행 → (jobs).
 * 전환은 이 행 FOR UPDATE 가 (fence 다음) 첫 lock 이어야 한다 — stage SHARE 를 잡은 TX 안에서는 부르지 않는다.
 */
export type AgentScanControlRow = typeof agentScanControl.$inferSelect;
export type AgentScanMode = AgentScanControlRow['mode'];
const fail = (code: string): never => { throw new Error(code); };
/** 세션 TimeZone 과 무관한 지금(시간대 없는 UTC). 새 표의 시각 열은 모두 이 값과 비교한다 */
export const AGENT_SCAN_UTC_NOW = sql`(clock_timestamp() AT TIME ZONE 'UTC')`;

export async function lockAgentScanControl(tx: ProductTransaction, strength: 'share' | 'update'): Promise<AgentScanControlRow> {
  const [row] = await tx.select().from(agentScanControl).where(eq(agentScanControl.id, 1)).for(strength);
  return row ?? fail('agent_scan_control_missing');
}

/**
 * 제작 근거 스캔 consumer 의 SERVICE_INSTANCE_ID 접두(consumer 등록부 값 — 'agent-scan-consumer-').
 * 감독이 15초마다 service:crawler:<이 접두><자리> 를 남긴다 — 운영센터 consumer_missing 과 pipeline-control status 가 센다.
 */
export const AGENT_SCAN_CONSUMER_PREFIX = consumerInstancePrefix('agent-scan');
export type AgentScanModeState = Pick<AgentScanControlRow, 'mode' | 'drainingFrom'>;
/** 잠그지 않고 읽는 지금 모드 — 잡의 갈래(legacy 스캔·컨트롤러)와 진행 표시만 쓴다. 쓰기 권한은 각 TX 의 관문이 다시 본다 */
export async function readAgentScanMode(executor: { execute: ProductTransaction['execute'] }): Promise<AgentScanModeState> {
  const [row] = await executor.execute<{ mode: AgentScanMode; draining_from: AgentScanControlRow['drainingFrom'] }>(sql`
    SELECT mode, draining_from FROM agent_scan_control WHERE id = 1`);
  return row ? { mode: row.mode, drainingFrom: row.draining_from } : fail('agent_scan_control_missing');
}
/** consumer 가 claim 표로 스캔하는 모드(items, items 에서 비우는 중). 이때 진행은 잡 커서가 아니라 claim 표로 센다 */
export function agentScanByClaims(state: AgentScanModeState): boolean {
  return state.mode === 'items' || state.mode === 'draining' && state.drainingFrom === 'items';
}

/**
 * legacy 스캔 쓰기(잡의 refresh·backfill 스크립트가 타는 saveRepositoryAgentScan)의 관문. stage SHARE 다음, identity 전에 부른다.
 * items 로 넘어간 뒤 옛 경로가 쓰면 consumer 와 같은 저장소를 겹쳐 쓰고 커서가 뒤로 돈다 — 그래서 거절한다.
 */
export async function assertLegacyAgentScanWrite(tx: ProductTransaction): Promise<void> {
  const row = await lockAgentScanControl(tx, 'share');
  if (row.mode !== 'legacy' && !(row.mode === 'draining' && row.drainingFrom === 'legacy')) fail('agent_scan_mode_blocked');
}

/** consumer 기록·claim 의 관문. canFinish(lib/jobs/items/repository.ts)와 같은 조건이다 */
export function agentScanRecordAllowed(row: AgentScanControlRow, controlEpoch: number): boolean {
  return row.writerContractVersion >= 1 && row.epoch === controlEpoch
    && (row.mode === 'items' || row.mode === 'draining' && row.drainingFrom === 'items');
}

async function lockForTransition(tx: ProductTransaction): Promise<AgentScanControlRow> {
  // item stage SHARE 를 이미 잡은 TX(lockItemStage 가 남긴 TX 지역 표시)에서 이 행을 올려 잡으면 기록 TX 와 순서가 뒤집힌다
  const [channel] = await tx.execute<{ item_channel: string | null }>(sql`
    SELECT current_setting('nomorevibe.item_stage_guard', true) AS item_channel`);
  if (channel?.item_channel === 'on') fail('agent_scan_lock_order');
  return lockAgentScanControl(tx, 'update');
}
async function contractedForTransition(tx: ProductTransaction): Promise<AgentScanControlRow> {
  const row = await lockForTransition(tx);
  if (row.writerContractVersion < 1) fail('agent_scan_contract_required');
  return row;
}

/** 모든 스캔 writer 가 관문을 가진 release 라는 운영자 확인. legacy 에서만, 한 칸씩 올리고 내리지 않는다 */
export async function bumpAgentScanContract(tx: ProductTransaction): Promise<AgentScanControlRow> {
  const row = await lockForTransition(tx);
  if (row.mode !== 'legacy') fail('agent_scan_transition_invalid');
  const [bumped] = await tx.update(agentScanControl).set({ writerContractVersion: row.writerContractVersion + 1, updatedAt: AGENT_SCAN_UTC_NOW })
    .where(eq(agentScanControl.id, 1)).returning();
  return bumped;
}

/** legacy·items 에서 draining 으로. 새 일(legacy 스캔 시작·consumer claim)은 멈추고 진행 중인 쓰기만 마친다 */
export async function beginAgentScanDrain(tx: ProductTransaction): Promise<AgentScanControlRow> {
  const row = await contractedForTransition(tx);
  if (row.mode === 'draining') return fail('agent_scan_transition_invalid');
  const [draining] = await tx.update(agentScanControl).set({ mode: 'draining', drainingFrom: row.mode, updatedAt: AGENT_SCAN_UTC_NOW })
    .where(eq(agentScanControl.id, 1)).returning();
  return draining;
}

/** 강제 회수 없음: live claim 이 하나라도 있으면 끝내지 않는다. epoch+1 이라 옛 control epoch 의 claim 기록은 모두 거절된다 */
export async function completeAgentScanTransition(tx: ProductTransaction, target: 'legacy' | 'items'): Promise<AgentScanControlRow> {
  const row = await contractedForTransition(tx);
  if (row.mode !== 'draining' || !['legacy', 'items'].includes(target)) fail('agent_scan_transition_invalid');
  // control 행을 잡은 뒤의 실제 시계로 본다 — claim·기록 TX 는 이 행 SHARE 를 잡으므로 여기서 끝난 것만 보인다
  const [live] = await tx.select({ key: agentRepositoryClaims.repositoryKey }).from(agentRepositoryClaims)
    .where(sql`${agentRepositoryClaims.token} IS NOT NULL AND ${agentRepositoryClaims.leaseUntil} > ${AGENT_SCAN_UTC_NOW}`).limit(1);
  if (live) fail('agent_scan_not_drained');
  if (row.epoch >= Number.MAX_SAFE_INTEGER) fail('agent_scan_epoch_exhausted');
  const [complete] = await tx.update(agentScanControl).set({ mode: target, drainingFrom: null, epoch: row.epoch + 1, updatedAt: AGENT_SCAN_UTC_NOW })
    .where(eq(agentScanControl.id, 1)).returning();
  return complete;
}
