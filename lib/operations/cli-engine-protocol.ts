import { z } from "zod";

export const CLI_ENGINE_ENDPOINT_HEADER = "x-nmv-cli-engine-endpoint";
export const CLI_ENGINE_REQUEST_HEADER = "x-nmv-cli-engine-request-id";
export const CLI_ENGINE_RECEIPT_HEADER = "x-nmv-cli-engine-receipt";
export const CLI_ENGINE_SIGNATURE_HEADER = "x-nmv-cli-engine-signature";
export const CLI_ENGINE_MAX_WIRE_BYTES = 8 * 1024 * 1024;
export const CLI_ENGINE_MAX_RESPONSE_BYTES = 128 * 1024;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const uuid = z.string().regex(UUID_PATTERN);
const sha256Hex = z.string().regex(SHA256_HEX_PATTERN);
const nonNegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export type CliEngineAuthorizationInput = Readonly<{
  requestId: string;
  endpoint: string;
  bearer: string;
  wire: string;
  wireHash: string;
  model: string;
  reasoningEffort?: string;
}>;

export type CliEngineAuthorization = Readonly<{
  connectionId: string;
  reasoningEffort?: string;
  model: string;
  responseModel: string;
  totalTokenBound: number;
  timeoutMs: number;
  bindingHash: string;
}>;

export type CliEngineClientAuth = Readonly<{
  bearer: string;
  connectionId: string;
  reasoningEffort?: string;
  bindingHash: string;
}>;

const actualUsageSchema = z
  .object({
    inputTokens: nonNegativeSafeInteger,
    outputTokens: nonNegativeSafeInteger,
    totalTokens: nonNegativeSafeInteger,
  })
  .strict();

export const cliEngineReceiptSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("cli_engine_terminal"),
    requestId: uuid,
    connectionId: uuid,
    bindingHash: sha256Hex,
    wireHash: sha256Hex,
    responseHash: sha256Hex,
    model: z.string().min(1).max(200),
    responseModel: z.string().min(1).max(200),
    reasoningEffort: z
      .string()
      .regex(EFFORT_PATTERN)
      .refine((value) => value !== "default")
      .optional(),
    bootId: uuid,
    ending: z.literal("exited"),
    exitCode: z.literal(0),
    closed: z.literal(true),
    finishReason: z.literal("stop"),
    stdoutHash: sha256Hex,
    stderrHash: sha256Hex,
    stdoutBytes: nonNegativeSafeInteger,
    stderrBytes: nonNegativeSafeInteger,
    actualUsage: actualUsageSchema.nullable(),
    totalTokenBound: positiveSafeInteger,
    cliVersion: z.string().min(1).max(80),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.actualUsage === null) return;
    if (
      receipt.actualUsage.totalTokens !==
      receipt.actualUsage.inputTokens + receipt.actualUsage.outputTokens
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actualUsage totalTokens must equal the exact sum",
        path: ["actualUsage", "totalTokens"],
      });
    }
    if (receipt.actualUsage.totalTokens > receipt.totalTokenBound) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "actualUsage totalTokens exceeds the bound",
        path: ["actualUsage", "totalTokens"],
      });
    }
  });

export type CliEngineReceipt = z.infer<typeof cliEngineReceiptSchema>;

export function serializeCliEngineReceipt(value: CliEngineReceipt): string {
  return JSON.stringify(cliEngineReceiptSchema.parse(value));
}

export function encodeCliEngineReceipt(value: CliEngineReceipt): string {
  return Buffer.from(serializeCliEngineReceipt(value), "utf8").toString(
    "base64url",
  );
}

export function decodeCliEngineReceipt(
  header: string,
): CliEngineReceipt | null {
  if (
    typeof header !== "string" ||
    header.length === 0 ||
    header.length > 8192 ||
    !/^[A-Za-z0-9_-]+$/.test(header)
  ) {
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(header, "base64url");
  } catch {
    return null;
  }
  if (bytes.toString("base64url") !== header) return null;

  let text: string;
  try {
    text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    const receipt = cliEngineReceiptSchema.parse(parsed);
    if (serializeCliEngineReceipt(receipt) !== text) return null;
    return receipt;
  } catch {
    return null;
  }
}
