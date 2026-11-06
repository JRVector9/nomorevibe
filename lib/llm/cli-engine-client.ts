import { createHash } from "node:crypto";

import {
  fetch as undiciFetch,
  Headers as UndiciHeaders,
  Response as UndiciResponse,
} from "undici";

import {
  CLI_ENGINE_ENDPOINT_HEADER,
  CLI_ENGINE_MAX_RESPONSE_BYTES,
  CLI_ENGINE_MAX_WIRE_BYTES,
  CLI_ENGINE_RECEIPT_HEADER,
  CLI_ENGINE_REQUEST_HEADER,
  CLI_ENGINE_SIGNATURE_HEADER,
  decodeCliEngineReceipt,
  serializeCliEngineReceipt,
  type CliEngineClientAuth,
} from "../operations/cli-engine-protocol";
import { cliEngineProofKey, cliEngineSignatureMatches } from "./cli-engine-auth";
import { CLI_ENGINE_AUTH_PREFIX } from "./cli-engine-config";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

type FetchInput = Parameters<typeof undiciFetch>[0];
type FetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

export type CliEngineClientRequest = Readonly<{
  endpoint: string;
  wire: string;
  headers: Record<string, string>;
  expected: CliEngineClientAuth;
  requestId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function requestUrlString(value: FetchInput): string | null {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  if (typeof value === "object" && value !== null) {
    const url = (value as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return null;
}

function endpointForLookup(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function requireCliEngineEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_cli_engine_request");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/v1/chat/completions"
  ) {
    throw new Error("invalid_cli_engine_request");
  }

  return url.toString();
}

function copyHeaders(input: FetchInit["headers"]): UndiciHeaders {
  return new UndiciHeaders(
    input as ConstructorParameters<typeof UndiciHeaders>[0],
  );
}

function headersToRecord(headers: UndiciHeaders): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function hasCliEngineAuthorization(value: string | null): boolean {
  if (value === null) return false;
  return value
    .toLowerCase()
    .startsWith(`bearer ${CLI_ENGINE_AUTH_PREFIX.toLowerCase()}`);
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBoundedResponseBody(
  response: Awaited<ReturnType<typeof undiciFetch>>,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      total += value.byteLength;
      if (total > CLI_ENGINE_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // bounded rejection remains the same even if cancellation fails
        }
        throw new Error("invalid_cli_engine_response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function prepareCliEngineClientRequest(
  requestId: string,
  url: Parameters<typeof undiciFetch>[0],
  init: Parameters<typeof undiciFetch>[1],
): Promise<CliEngineClientRequest | null> {
  const rawEndpoint = requestUrlString(url);
  const headers = copyHeaders(init?.headers);
  const authorization = headers.get("authorization");
  const engineAuthorizationPresent = hasCliEngineAuthorization(authorization);

  if (rawEndpoint === null) {
    if (engineAuthorizationPresent) {
      throw new Error("invalid_cli_engine_request");
    }
    return null;
  }

  const endpoint = endpointForLookup(rawEndpoint);
  const { resolveCliEngineClientAuth } = await import(
    "../operations/cli-engine-authority"
  );
  const expected = await resolveCliEngineClientAuth(requestId, endpoint);

  if (expected === null) {
    if (engineAuthorizationPresent) {
      throw new Error("invalid_cli_engine_request");
    }
    return null;
  }

  if (!UUID_PATTERN.test(requestId)) {
    throw new Error("invalid_cli_engine_request");
  }

  const checkedEndpoint = requireCliEngineEndpoint(rawEndpoint);
  if (checkedEndpoint !== endpoint) {
    throw new Error("invalid_cli_engine_request");
  }

  if (
    expected.reasoningEffort !== undefined &&
    (expected.reasoningEffort === "default" ||
      !EFFORT_PATTERN.test(expected.reasoningEffort))
  ) {
    throw new Error("invalid_cli_engine_request");
  }
  if (
    !UUID_PATTERN.test(expected.connectionId) ||
    !SHA256_HEX_PATTERN.test(expected.bindingHash)
  ) {
    throw new Error("invalid_cli_engine_request");
  }

  cliEngineProofKey(expected.bearer);

  const method = init?.method;
  if (typeof method !== "string" || method.toUpperCase() !== "POST") {
    throw new Error("invalid_cli_engine_request");
  }

  const wire = init?.body;
  if (
    typeof wire !== "string" ||
    Buffer.byteLength(wire, "utf8") > CLI_ENGINE_MAX_WIRE_BYTES
  ) {
    throw new Error("invalid_cli_engine_request");
  }

  const body = parseJsonObject(wire);
  if (body === null) throw new Error("invalid_cli_engine_request");

  const model = body.model;
  if (typeof model !== "string" || model.length === 0 || model.length > 200) {
    throw new Error("invalid_cli_engine_request");
  }

  if (body.stream === true) throw new Error("invalid_cli_engine_request");

  const effort = body.reasoning_effort;
  if (
    effort !== undefined &&
    (typeof effort !== "string" ||
      effort === "default" ||
      !EFFORT_PATTERN.test(effort))
  ) {
    throw new Error("invalid_cli_engine_request");
  }
  if (effort !== expected.reasoningEffort) {
    throw new Error("invalid_cli_engine_request");
  }

  const expectedAuthorization = `Bearer ${expected.bearer}`;
  // Domain callers may still supply their former API key. The primary-DB-pinned CLI source supplies its own auth.
  // Another CLI credential is a source mismatch and must never be silently replaced.
  if (authorization !== null && authorization !== expectedAuthorization && hasCliEngineAuthorization(authorization)) {
    throw new Error("invalid_cli_engine_request");
  }
  headers.set("authorization", expectedAuthorization);

  const existingRequestId = headers.get(CLI_ENGINE_REQUEST_HEADER);
  if (existingRequestId !== null && existingRequestId !== requestId) {
    throw new Error("invalid_cli_engine_request");
  }
  headers.set(CLI_ENGINE_REQUEST_HEADER, requestId);
  headers.set(CLI_ENGINE_ENDPOINT_HEADER, checkedEndpoint);

  return {
    endpoint: checkedEndpoint,
    wire,
    headers: headersToRecord(headers),
    expected,
    requestId,
  };
}

export async function verifyCliEngineResponse(
  context: CliEngineClientRequest,
  response: Awaited<ReturnType<typeof undiciFetch>>,
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  try {
    if (response.status !== 200) {
      throw new Error("invalid_cli_engine_response");
    }

    const bytes = await readBoundedResponseBody(response);
    const receiptHeader = response.headers.get(CLI_ENGINE_RECEIPT_HEADER);
    const signatureHeader = response.headers.get(CLI_ENGINE_SIGNATURE_HEADER);
    if (receiptHeader === null || signatureHeader === null) {
      throw new Error("invalid_cli_engine_response");
    }

    const receipt = decodeCliEngineReceipt(receiptHeader);
    if (receipt === null) throw new Error("invalid_cli_engine_response");

    const serialized = serializeCliEngineReceipt(receipt);
    if (
      !cliEngineSignatureMatches(
        serialized,
        context.expected.bearer,
        signatureHeader,
      )
    ) {
      throw new Error("invalid_cli_engine_response");
    }

    const requestBody = parseJsonObject(context.wire);
    if (requestBody === null) throw new Error("invalid_cli_engine_response");
    const requestModel = requestBody.model;
    if (
      typeof requestModel !== "string" ||
      receipt.model !== requestModel ||
      receipt.requestId !== context.requestId ||
      receipt.connectionId !== context.expected.connectionId ||
      receipt.bindingHash !== context.expected.bindingHash ||
      receipt.wireHash !== sha256Hex(context.wire) ||
      receipt.reasoningEffort !== context.expected.reasoningEffort
    ) {
      throw new Error("invalid_cli_engine_response");
    }

    const responseBytes = Buffer.from(bytes);
    const responseText = responseBytes.toString("utf8");
    if (!Buffer.from(responseText, "utf8").equals(responseBytes)) {
      throw new Error("invalid_cli_engine_response");
    }

    const body = parseJsonObject(responseText);
    if (body === null) throw new Error("invalid_cli_engine_response");

    if (
      body.id !== `cli-engine-${context.requestId}` ||
      body.object !== "chat.completion" ||
      typeof body.created !== "number" ||
      !Number.isSafeInteger(body.created) ||
      body.created < 0 ||
      body.model !== receipt.responseModel ||
      Object.prototype.hasOwnProperty.call(body, "usage") ||
      body.usage_provenance !== "missing_or_invalid" ||
      Object.prototype.hasOwnProperty.call(body, "error")
    ) {
      throw new Error("invalid_cli_engine_response");
    }

    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length !== 1) {
      throw new Error("invalid_cli_engine_response");
    }

    const choice = choices[0] as unknown;
    if (!isRecord(choice) || choice.index !== 0) {
      throw new Error("invalid_cli_engine_response");
    }

    const message = choice.message;
    if (
      !isRecord(message) ||
      message.role !== "assistant" ||
      typeof message.content !== "string"
    ) {
      throw new Error("invalid_cli_engine_response");
    }

    if (choice.finish_reason !== "stop") {
      throw new Error("invalid_cli_engine_response");
    }

    if (receipt.responseHash !== sha256Hex(bytes)) {
      throw new Error("invalid_cli_engine_response");
    }

    const headers = new UndiciHeaders(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");

    return new UndiciResponse(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    try {
      await response.body?.cancel();
    } catch {
      // Ignore cancellation errors; the sanitized error below is authoritative.
    }
    throw new Error("invalid_cli_engine_response");
  }
}
