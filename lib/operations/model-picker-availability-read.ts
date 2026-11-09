import { eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { aiConnections, modelCapacityControl, modelCapacityDevices } from "@/lib/db/schema";
import { modelCapacityPolicyHash, modelCapacityPolicySchema } from "@/lib/llm/capacity";
import { readModelCapacityDeviceStates } from "@/lib/llm/capacity-devices-repository";
import { MODEL_CAPACITY_OPEN_STATES_SQL } from "@/lib/llm/capacity-states";
import type { ModelPickerAvailability, ModelPickerModelActivity } from "./model-picker-availability";

type Activity = { device_id: string; model: string; reserved: number; expired_reserved: number; running: number; waiting: number; indeterminate: number };

/** One primary, read-only snapshot. This never probes engines, decrypts keys or modifies admission. */
export async function readModelPickerAvailability(): Promise<ModelPickerAvailability> {
  return withDbDeadline(Date.now() + 4_000, () => onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
    const [session] = await tx.execute<{ replica: boolean; observed_at: string }>(sql`SELECT pg_is_in_recovery() AS replica,
      to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at`);
    if (!session || session.replica) throw new Error("model_picker_primary_unavailable");
    const [control] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1));
    if (!control) throw new Error("model_picker_control_unavailable");
    const policy = control.policy === null ? null : modelCapacityPolicySchema.parse(control.policy);
    if (policy === null && control.mode !== "disabled") throw new Error("model_picker_policy_unavailable");
    if (policy !== null && modelCapacityPolicyHash(policy) !== control.policyHash) throw new Error("model_picker_policy_unverified");
    const connections = await tx.select({ id: aiConnections.id, deviceId: aiConnections.deviceId, enabled: aiConnections.enabled }).from(aiConnections);
    const devices = await readModelCapacityDeviceStates(tx);
    const deviceRows = await tx.select({ deviceId: modelCapacityDevices.deviceId, enabled: modelCapacityDevices.enabled }).from(modelCapacityDevices);
    const counts = await tx.execute<Activity>(sql`SELECT group_id AS device_id,model,
      count(*) FILTER(WHERE state='reserved' AND reserved_until>clock_timestamp())::int AS reserved,
      count(*) FILTER(WHERE state='reserved' AND reserved_until<=clock_timestamp())::int AS expired_reserved,
      count(*) FILTER(WHERE state='dispatched')::int AS running,
      count(*) FILTER(WHERE state='waiting' AND queue_until>clock_timestamp() AND epoch=${control.epoch}
        AND revision=${control.revision} AND policy_hash=${control.policyHash})::int AS waiting,
      count(*) FILTER(WHERE state='indeterminate')::int AS indeterminate
      FROM model_capacity_requests WHERE state IN ${sql.raw(MODEL_CAPACITY_OPEN_STATES_SQL)} GROUP BY group_id,model`);
    return { observedAt: session.observed_at, mode: control.mode, connections: connections.map(connection => {
      const device = devices.find(row => row.deviceId === connection.deviceId);
      const shared = counts.filter(row => row.device_id === connection.deviceId);
      // A connection-qualified ledger identity belongs only to that connection. Bare identities share the engine/device.
      const suffix = `@${connection.id.slice(0, 8)}`;
      const models: ModelPickerModelActivity[] = shared.flatMap(row => /@[0-9a-f]{8}$/.test(row.model) && !row.model.endsWith(suffix) ? []
        : [{ model: row.model.endsWith(suffix) ? row.model.slice(0, -suffix.length) : row.model,
          reserved: row.reserved, expiredReserved: row.expired_reserved, running: row.running, waiting: row.waiting, indeterminate: row.indeterminate }]);
      return { connectionId: connection.id, deviceId: connection.deviceId, enabled: connection.enabled,
        deviceEnabled: deviceRows.find(row => row.deviceId === connection.deviceId)?.enabled ?? null,
        source: device?.source ?? null,
        limit: device?.limitSlots ?? null, occupied: device?.active ?? null, free: device ? Math.max(0, device.limitSlots - device.active) : null,
        reserved: shared.reduce((sum, row) => sum + row.reserved, 0), running: shared.reduce((sum, row) => sum + row.running, 0),
        expiredReserved: shared.reduce((sum, row) => sum + row.expired_reserved, 0),
        waiting: device?.waiting ?? 0, indeterminate: shared.reduce((sum, row) => sum + row.indeterminate, 0), models,
        ...(device?.routes ? { routes: device.routes } : {}), ...(device?.lendIdle === undefined ? {} : { lendIdle: device.lendIdle }),
        ...(device?.models ? { modelCaps: device.models } : {}) };
    }) };
  }, { accessMode: "read only", isolationLevel: "repeatable read" })));
}
