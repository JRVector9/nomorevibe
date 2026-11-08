import { and, eq, sql } from 'drizzle-orm';
import { aiConnectionHiddenModels } from "./admin-ai-tasks";
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { aiConnections, operationsAudit } from '@/lib/db/schema';
import { openSecret } from '@/lib/security/secret-box';
import { adminAuditRow } from './admin-log';
import { aiConnectionKeyAad } from './admin-ai-tasks';
import { engineBaseUrl, probeResponseModel } from './admin-engine-connect';
import { cliHostResponseProbeResponseSchema } from './cli-host-protocol';
import { cliHostRequest } from './cli-host-client';
import { readCliHostTarget } from './cli-host-target';
import { readModelPickerAvailability } from './model-picker-availability-read';

const CONTROL = /[\p{Cc}]/u;
const probeText = (max: number) => z.string().min(1).max(max).refine(value => !CONTROL.test(value));

export const adminSelectedModelProbeInputSchema = z.object({ connectionId: z.uuid(), model: probeText(200),
  reasoningEffort: probeText(80).optional() }).strict();
export type AdminSelectedModelProbeInput = z.infer<typeof adminSelectedModelProbeInputSchema>;

export const selectedModelProbeErrorSchema = z.enum(['unauthorized', 'forbidden', 'invalid_request', 'not_found', 'disabled',
  'model_unavailable', 'draining', 'occupied', 'device_unknown', 'cooldown', 'audit_unavailable', 'secret_unavailable',
  'base_url_invalid', 'reasoning_effort_unsupported', 'unsupported_cli', 'host_unavailable', 'timeout', 'output_too_large', 'cli_error',
  'invalid_output', 'probe_failed', 'busy', 'result_audit_failed', 'unavailable']);
export type SelectedModelProbeError = z.infer<typeof selectedModelProbeErrorSchema>;
export type SelectedModelProbeResult = { ok: boolean; model: string; responseModel?: string; ms?: number; error?: SelectedModelProbeError; auditWarning?: 'result_audit_failed' };

export const SELECTED_MODEL_RESPONSE_PROBE_START_ACTION = 'selected-model-response-probe-start';
export const SELECTED_MODEL_RESPONSE_PROBE_RESULT_ACTION = 'selected-model-response-probe-result';

const failure = (model: string, error: SelectedModelProbeError, ms?: number): SelectedModelProbeResult =>
  ({ ok: false, model, ...(ms === undefined ? {} : { ms }), error });

async function readSelectedConnection(connectionId: string) {
  return onPrimary(() => db.select({ id: aiConnections.id, kind: aiConnections.kind, baseUrl: aiConnections.baseUrl,
    apiKeyCiphertext: aiConnections.apiKeyCiphertext, cliTool: aiConnections.cliTool, cliModels: aiConnections.cliModels,
    models: aiConnections.models, options: aiConnections.options, enabled: aiConnections.enabled, deviceId: aiConnections.deviceId })
    .from(aiConnections).where(eq(aiConnections.id, connectionId)).limit(1));
}
type SelectedConnection = Awaited<ReturnType<typeof readSelectedConnection>>[number];
type ModelPickerAvailabilitySnapshot = Awaited<ReturnType<typeof readModelPickerAvailability>>;

function availabilityRefusal(availability: ModelPickerAvailabilitySnapshot, connectionId: string): SelectedModelProbeError | null {
  const mode = String(availability.mode);
  if (mode === 'draining') return 'draining';
  if (mode !== 'open') return 'disabled';
  const connection = availability.connections.find(entry => entry.connectionId === connectionId);
  if (!connection) return 'device_unknown';
  const source = connection.source === null ? null : String(connection.source);
  const limit = connection.limit, occupied = connection.occupied, deviceEnabled = connection.deviceEnabled;
  if (source === null || source === 'unknown' || limit === null || occupied === null) return 'device_unknown';
  if (deviceEnabled === null) return 'device_unknown';
  if (!connection.enabled || !deviceEnabled) return 'disabled';
  if (occupied >= limit) return 'occupied';
  return null;
}

async function beginProbeAudit(actor: string, row: SelectedConnection, model: string, reasoningEffort?: string): Promise<SelectedModelProbeError | null> {
  let start: Awaited<ReturnType<typeof adminAuditRow>>;
  try {
    start = await adminAuditRow(actor, { action: SELECTED_MODEL_RESPONSE_PROBE_START_ACTION, target: row.deviceId,
      detail: { connectionId: row.id, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } });
  } catch { return 'audit_unavailable'; }
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
      const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${'selected-model-response-probe:' + row.deviceId}, 0)) AS locked`);
      if (!lock?.locked) return 'cooldown' as const;
      const [recent] = await tx.select({ id: operationsAudit.id }).from(operationsAudit)
        .where(and(eq(operationsAudit.action, SELECTED_MODEL_RESPONSE_PROBE_START_ACTION), eq(operationsAudit.target, row.deviceId),
          sql`${operationsAudit.createdAt} > now() - interval '60 seconds'`)).limit(1);
      if (recent) return 'cooldown' as const;
      await tx.insert(operationsAudit).values(start);
      return null;
    }));
  } catch { return 'audit_unavailable'; }
}

async function writeProbeResultAudit(actor: string, row: SelectedConnection, model: string, reasoningEffort: string | undefined, result: SelectedModelProbeResult): Promise<void> {
  const code = result.ok ? 'ok' : result.error ?? 'unavailable';
  const audit = await adminAuditRow(actor, { action: SELECTED_MODEL_RESPONSE_PROBE_RESULT_ACTION, target: row.deviceId,
    detail: { connectionId: row.id, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(result.responseModel === undefined ? {} : { responseModel: result.responseModel }),
      ...(result.ms === undefined ? {} : { ms: result.ms }), code },
    ok: result.ok, error: result.ok ? null : code });
  await onPrimary(() => db.insert(operationsAudit).values(audit));
}

/** Same one-token diagnostic as engine registration, additionally require actual generated output. */
const responseRequest: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) { await reader.cancel(); throw new Error("probe_output_too_large"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  const body: unknown = JSON.parse(text);
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const generated = object(body) && Array.isArray(body.choices) && body.choices.some((choice: unknown) => {
    if (!object(choice) || !object(choice.message)) return false;
    return [choice.message.content, choice.message.reasoning_content, choice.message.reasoning]
      .some(value => typeof value === "string" && value.length > 0);
  });
  // max_tokens=1 may legitimately finish with length; metadata-only HTTP 200 is never a success.
  if (!generated) throw new Error("probe_empty_response");
  return new Response(text, { status: response.status, headers: { "content-type": "application/json" } });
};

async function probeApi(row: SelectedConnection, model: string): Promise<SelectedModelProbeResult> {
  const started = Date.now();
  const base = row.baseUrl === null ? null : engineBaseUrl(row.baseUrl);
  if (!base) return failure(model, 'base_url_invalid', Date.now() - started);
  let apiKey: string | null = null;
  if (row.apiKeyCiphertext !== null) {
    apiKey = openSecret(row.apiKeyCiphertext, aiConnectionKeyAad(row.id));
    if (apiKey === null) return failure(model, 'secret_unavailable', Date.now() - started);
  }
  const responseModel = await probeResponseModel(`${base}/chat/completions`, model, apiKey, responseRequest);
  const ms = Date.now() - started;
  if (!responseModel) return failure(model, 'probe_failed', ms);
  return { ok: true, model, responseModel, ms };
}

async function probeCli(row: SelectedConnection, model: string, reasoningEffort?: string): Promise<SelectedModelProbeResult> {
  const started = Date.now();
  try {
    const target = await readCliHostTarget(row.id);
    const response = await cliHostRequest(target, { version: 1, action: 'responseProbe',
      data: { connectionId: row.id, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } },
      cliHostResponseProbeResponseSchema, 40_000);
    if (!response.ok) return failure(model, response.error ?? 'cli_error', response.ms);
    return { ok: true, model, responseModel: model, ms: response.ms };
  } catch (error) {
    const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : null;
    return failure(model, name === 'TimeoutError' ? 'timeout' : 'host_unavailable', Date.now() - started);
  }
}

export async function runAdminSelectedModelProbe(input: unknown, actor: string): Promise<SelectedModelProbeResult> {
  const parsed = adminSelectedModelProbeInputSchema.safeParse(input);
  if (!parsed.success) return failure('', 'invalid_request');
  const { connectionId, model, reasoningEffort } = parsed.data;
  if (!actor.trim()) return failure(model, 'unauthorized');
  let row: SelectedConnection | null = null;
  try { row = (await readSelectedConnection(connectionId))[0] ?? null; }
  catch { return failure(model, 'unavailable'); }
  if (!row) return failure(model, 'not_found');
  if (!row.enabled) return failure(model, 'disabled');
  // 운영자가 연결의 목록에서 삭제한 모델은 시험하지 않는다(화면 선택지에도 없다)
  if (aiConnectionHiddenModels(row.options).includes(model)) return failure(model, 'model_unavailable');
  if (row.kind === 'api') {
    if (reasoningEffort !== undefined) return failure(model, 'reasoning_effort_unsupported');
    if (!row.models?.some(entry => entry.id === model)) return failure(model, 'model_unavailable');
  } else {
    if (!row.cliModels.includes(model)) return failure(model, 'model_unavailable');
    if (row.cliTool !== 'opencode') return failure(model, 'unsupported_cli');
  }
  let availability: ModelPickerAvailabilitySnapshot | null = null;
  try { availability = await readModelPickerAvailability(); }
  catch { return failure(model, 'unavailable'); }
  if (!availability) return failure(model, 'unavailable');
  const refusal = availabilityRefusal(availability, row.id);
  if (refusal) return failure(model, refusal);
  const auditError = await beginProbeAudit(actor, row, model, reasoningEffort);
  if (auditError) return failure(model, auditError);
  const started = Date.now();
  let result: SelectedModelProbeResult;
  try { result = row.kind === 'api' ? await probeApi(row, model) : await probeCli(row, model, reasoningEffort); }
  catch { result = failure(model, 'unavailable', Date.now() - started); }
  try { await writeProbeResultAudit(actor, row, model, reasoningEffort, result); }
  catch { return { ...result, auditWarning: 'result_audit_failed' }; }
  return result;
}
