import { z } from "zod";

/** Shared wire values must not import the ledger/domain graph used by either RPC family. */
/** Public HMAC context, not an authentication credential. */
export const CLI_HOST_RPC_DOMAIN = "nmv-cli-host-rpc-v1";
export const CLI_HOST_BODY_LIMIT = 384 * 1024;
export const cliHostHandleSchema = z.object({ bootId: z.uuid(), callId: z.uuid(), connectionId: z.uuid() }).strict();

const identity = { handle: cliHostHandleSchema, requestId: z.uuid(), bindingHash: z.string().regex(/^[a-f0-9]{64}$/) };
export const cliHostNotStartedResponseSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("settled"), terminalEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ ...identity, kind: z.literal("indeterminate"), reason: z.enum(["process_exit", "transport_unknown"]) }).strict(),
]);
