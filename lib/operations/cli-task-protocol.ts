import { z } from 'zod';
import { cliModelDispatchSchema } from '@/lib/llm/capacity';
import { cliTransportSchema } from '@/lib/llm/cli-serving-contract';
import { CLI_HOST_BODY_LIMIT, cliHostHandleSchema, cliHostNotStartedResponseSchema } from '@/lib/operations/cli-host-protocol';

type JsonObject = Record<string, unknown>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const safeOpenCodeID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
const safeVariant = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const task = z.enum(['product-intro-check', 'product-audit']);

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every(item => isJsonValue(item, depth + 1));
}

const jsonObjectSchema = z.custom<JsonObject>(value => isRecord(value) && isJsonValue(value));

const responseFormatSchema = z.object({
  type: z.literal('json_schema'),
  json_schema: z.object({
    name: z.string().min(1),
    strict: z.boolean().optional(),
    schema: jsonObjectSchema,
  }).strict(),
}).strict();

const systemMessageSchema = z.object({ role: z.literal('system'), content: z.string() }).strict();
const userMessageSchema = z.object({ role: z.literal('user'), content: z.string() }).strict();
const messagesSchema = z.tuple([systemMessageSchema, userMessageSchema]);

export const cliTaskPrepareDataSchema = z.object({
  task,
  connectionId: z.uuid(),
  model: safeOpenCodeID,
  reasoningEffort: safeVariant.optional(),
  inputHash: sha256,
  messages: messagesSchema,
  responseFormat: responseFormatSchema.optional(),
  timeoutMs: z.number().int().positive().safe().max(300_000),
}).strict().superRefine((value, ctx) => {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > CLI_HOST_BODY_LIMIT) {
      ctx.addIssue({ code: 'custom', message: 'cli_task_body_too_large' });
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'cli_task_body_invalid' });
  }
});

export type CliTaskPrepareData = z.infer<typeof cliTaskPrepareDataSchema>;

export const cliTaskPreparedCallSchema = z.object({
  kind: z.literal('prepared_cli_task'),
  routeId: task,
  provider: z.literal('opencode-cli'),
  model: safeOpenCodeID,
  inputHash: sha256,
  transport: z.lazy(() => cliTransportSchema),
  totalTokenBound: z.number().int().positive().safe(),
}).strict();

export type PreparedCliTaskCall = z.infer<typeof cliTaskPreparedCallSchema>;

export const cliTaskPrepareResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prepared'), handle: cliHostHandleSchema, call: cliTaskPreparedCallSchema }).strict(),
  z.object({ kind: z.literal('unsupported'), reason: z.literal('provider_contract_unavailable') }).strict(),
]);

export type CliTaskPrepareResponse = z.infer<typeof cliTaskPrepareResponseSchema>;

const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().safe().optional(),
  outputTokens: z.number().int().nonnegative().safe().optional(),
  costUsd: z.number().nonnegative().finite().optional(),
}).strict();

export const cliTaskResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), content: z.string(), usage: usageSchema }).strict(),
  z.object({ ok: z.literal(false), error: z.enum(['cancelled', 'timeout', 'output_too_large', 'missing_cli', 'cli_error', 'auth', 'invalid_output']), usage: usageSchema.optional() }).strict(),
]);

export type CliTaskResult = z.infer<typeof cliTaskResultSchema>;

const identity = { handle: cliHostHandleSchema, requestId: z.uuid(), bindingHash: sha256 };
const indeterminateReason = z.enum(['process_exit', 'transport_unknown']);

export const cliTaskRunResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('settled'), terminalEvidenceHash: sha256, result: cliTaskResultSchema }).strict(),
  z.object({ ...identity, kind: z.literal('indeterminate'), reason: indeterminateReason }).strict(),
]);

export type CliTaskRunResponse = z.infer<typeof cliTaskRunResponseSchema>;

export const cliTaskNotStartedResponseSchema = cliHostNotStartedResponseSchema;
export type CliTaskNotStartedResponse = z.infer<typeof cliTaskNotStartedResponseSchema>;

export const cliTaskReleaseResponseSchema = z.object({ released: z.boolean() }).strict();

const boundTaskDataSchema = z.object({ handle: cliHostHandleSchema, dispatch: z.lazy(() => cliModelDispatchSchema) }).strict();

export const cliTaskRequestSchema = z.discriminatedUnion('action', [
  z.object({ version: z.literal(1), action: z.literal('taskPrepare'), data: cliTaskPrepareDataSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal('taskRun'), data: boundTaskDataSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal('taskNotStarted'), data: boundTaskDataSchema }).strict(),
  z.object({ version: z.literal(1), action: z.literal('taskRelease'), data: z.object({ handle: cliHostHandleSchema }).strict() }).strict(),
]);

export type CliTaskRequest = z.infer<typeof cliTaskRequestSchema>;
