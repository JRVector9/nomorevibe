import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  OPENCODE_REVIEW_AGENT,
  opencodeReportedUsage,
  opencodeReviewArgs,
  opencodeReviewProfile,
  releaseOpencodeReviewProfile,
} from '@/lib/crawl/agent-review-opencode';
import { readOpenCodeCliCapabilities } from '@/lib/crawl/opencode-cli-capabilities';
import { cliEngineProofKey, cliEngineSign } from '@/lib/llm/cli-engine-auth';
import { observeCliProcess } from '@/lib/llm/cli-process-runner';

import { readCliHostCatalog } from './cli-host-catalog';
import type { CliHostCatalog } from './cli-host-protocol';
import {
  CLI_ENGINE_MAX_RESPONSE_BYTES,
  CLI_ENGINE_MAX_WIRE_BYTES,
  CLI_ENGINE_RECEIPT_HEADER,
  CLI_ENGINE_REQUEST_HEADER,
  CLI_ENGINE_SIGNATURE_HEADER,
  encodeCliEngineReceipt,
  serializeCliEngineReceipt,
  type CliEngineAuthorization,
  type CliEngineAuthorizationInput,
  type CliEngineReceipt,
} from './cli-engine-protocol';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_STDOUT_BYTES = CLI_ENGINE_MAX_WIRE_BYTES;
const MAX_STDERR_BYTES = CLI_ENGINE_MAX_RESPONSE_BYTES;
const MAX_IMAGE_BYTES = CLI_ENGINE_MAX_WIRE_BYTES;
const MAX_RECEIPT_HEADER_CHARS = 8 * 1024;
const MAX_OUTPUT_TOKENS = 32_768;

const textContentPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .strict();

const imageUrlSchema = z
  .object({
    url: z.string().min(1),
    detail: z.string().min(1).max(32).optional(),
  })
  .strict();

const imageContentPartSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: imageUrlSchema,
  })
  .strict();

const contentPartSchema = z.discriminatedUnion('type', [
  textContentPartSchema,
  imageContentPartSchema,
]);

const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.union([z.string(), z.array(contentPartSchema)]),
  })
  .strict();

const wireSchema = z
  .object({
    model: z.string().regex(MODEL_PATTERN),
    messages: z.array(messageSchema).min(1).max(32),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().max(MAX_OUTPUT_TOKENS).optional(),
    reasoning_effort: z
      .string()
      .regex(EFFORT_PATTERN)
      .refine(value => value !== 'default')
      .optional(),
    reasoningEffort: z
      .string()
      .regex(EFFORT_PATTERN)
      .refine(value => value !== 'default')
      .optional(),
    response_format: z.unknown().optional(),
  })
  .passthrough();

type ImageAttachment = {
  number: number;
  mime: 'image/jpeg' | 'image/png';
  bytes: Buffer;
  filePath?: string;
};

type ParsedPart =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'image_url'; image: ImageAttachment; detail?: string }>;

type ParsedMessage = Readonly<{
  role: 'system' | 'user' | 'assistant';
  content: string | readonly ParsedPart[];
}>;

type ParsedWire = Readonly<{
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  responseFormat?: unknown;
  messages: readonly ParsedMessage[];
  images: readonly ImageAttachment[];
  wireHash: string;
}>;

type ActiveRequest = Readonly<{
  controller: AbortController;
  done: Promise<void>;
  resolve: () => void;
}>;

export class CliEngineRuntime {
  readonly bootId: string;
  private readonly authorizeAndClaim: (
    input: CliEngineAuthorizationInput,
  ) => Promise<CliEngineAuthorization>;
  private readonly catalog: () => Promise<CliHostCatalog>;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly active = new Map<string, ActiveRequest>();

  constructor(options: {
    bootId?: string;
    authorizeAndClaim: (
      input: CliEngineAuthorizationInput,
    ) => Promise<CliEngineAuthorization>;
    catalog?: () => Promise<CliHostCatalog>;
  }) {
    if (!options || typeof options !== 'object') {
      throw new Error('invalid_cli_engine_runtime_options');
    }

    const bootId = options.bootId ?? randomUUID();
    if (!UUID_PATTERN.test(bootId)) {
      throw new Error('invalid_cli_engine_boot_id');
    }

    if (typeof options.authorizeAndClaim !== 'function') {
      throw new Error('missing_cli_engine_authority');
    }
    if (options.catalog !== undefined && typeof options.catalog !== 'function') {
      throw new Error('invalid_cli_engine_catalog');
    }

    this.bootId = bootId;
    this.authorizeAndClaim = options.authorizeAndClaim;
    this.catalog = options.catalog ?? (() => readCliHostCatalog(bootId));
  }

  async complete(input: {
    requestId: string;
    endpoint: string;
    bearer: string;
    wire: string;
    signal?: AbortSignal;
  }): Promise<{
    status: 200;
    body: string;
    headers: Record<string, string>;
  }> {
    const startedAt = Date.now();

    if (this.closing) throw new Error('cli_engine_closing');
    if (!input || typeof input !== 'object') {
      throw new Error('invalid_cli_engine_request');
    }
    if (
      typeof input.requestId !== 'string' ||
      !UUID_PATTERN.test(input.requestId)
    ) {
      throw new Error('invalid_cli_engine_request_id');
    }
    assertEndpoint(input.endpoint);
    if (typeof input.bearer !== 'string') {
      throw new Error('invalid_cli_engine_auth');
    }
    cliEngineProofKey(input.bearer);
    if (typeof input.wire !== 'string') {
      throw new Error('invalid_cli_engine_wire');
    }
    if (Buffer.byteLength(input.wire, 'utf8') > CLI_ENGINE_MAX_WIRE_BYTES) {
      throw new Error('cli_engine_wire_too_large');
    }
    if (input.signal?.aborted) throw new Error('cli_engine_aborted');
    if (this.active.has(input.requestId)) {
      throw new Error('cli_engine_request_already_active');
    }

    const parsed = parseWire(input.wire);
    if (this.closing) throw new Error('cli_engine_closing');

    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => {
      resolveDone = resolve;
    });
    const activeEntry: ActiveRequest = {
      controller,
      done,
      resolve: resolveDone,
    };
    this.active.set(input.requestId, activeEntry);

    let directory: string | null = null;

    try {
      this.assertLive(controller, input.signal);

      directory = await mkdtemp(path.join(os.tmpdir(), 'nmv-cli-engine-'));
      this.assertLive(controller, input.signal);

      const profile = await opencodeReviewProfile(directory);
      this.assertLive(controller, input.signal);

      const capabilities = await readOpenCodeCliCapabilities(
        profile.command,
        directory,
        profile.env,
      );
      this.assertLive(controller, input.signal);

      if (parsed.images.length > 0 && capabilities.files !== true) {
        throw new Error('cli_engine_files_unsupported');
      }

      const catalog = await this.catalog();
      this.assertLive(controller, input.signal);
      assertCatalogSelection(
        catalog,
        this.bootId,
        parsed.model,
        parsed.reasoningEffort,
      );

      if (parsed.images.length > 0 && catalog.models.find(entry => entry.id === parsed.model)?.vision !== true) {
        throw new Error('cli_engine_vision_unverified');
      }

      await materializeImages(directory, parsed.images);
      this.assertLive(controller, input.signal);

      const args = opencodeReviewArgs(
        parsed.model,
        parsed.reasoningEffort,
        capabilities,
      );
      if (parsed.images.length > 0) {
        for (const image of parsed.images) {
          if (!image.filePath) {
            throw new Error('cli_engine_attachment_missing');
          }
          args.push('--file', image.filePath);
        }
      }

      const env = buildChildEnv(
        profile.env,
        buildAgentPrompt(parsed.messages, parsed.responseFormat),
        parsed.maxTokens,
      );
      const userPrompt = buildUserPrompt(parsed.messages);

      const authorityInput: CliEngineAuthorizationInput = {
        requestId: input.requestId,
        endpoint: input.endpoint,
        bearer: input.bearer,
        wire: input.wire,
        wireHash: parsed.wireHash,
        model: parsed.model,
        ...(parsed.reasoningEffort !== undefined
          ? { reasoningEffort: parsed.reasoningEffort }
          : {}),
      };

      const authority = await this.authorizeAndClaim(authorityInput);
      this.assertLive(controller, input.signal);
      assertAuthority(authority, parsed.model, parsed.reasoningEffort);

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = authority.timeoutMs - elapsedMs;
      if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
        throw new Error('cli_engine_deadline_exceeded');
      }

      const combinedSignal = AbortSignal.any([
        controller.signal,
        ...(input.signal ? [input.signal] : []),
      ]);
      if (combinedSignal.aborted) throw new Error('cli_engine_aborted');

      const observed = await observeCliProcess(
        {
          command: capabilities.command,
          args,
          cwd: directory,
          env,
          stdin: userPrompt,
          timeoutMs: remainingMs,
          maxStdoutBytes: MAX_STDOUT_BYTES,
          maxStderrBytes: MAX_STDERR_BYTES,
        },
        combinedSignal,
      );

      this.assertLive(controller, input.signal);

      if (observed.ending !== 'exited') {
        throw new Error('cli_engine_process_not_exited');
      }
      if (observed.killReason !== null) {
        throw new Error('cli_engine_process_killed');
      }
      if (observed.result.kind !== 'exit') {
        throw new Error('cli_engine_process_failed');
      }
      if (
        observed.exit.code !== 0 ||
        observed.result.code !== 0 ||
        observed.exit.signal !== null
      ) {
        throw new Error('cli_engine_process_failed');
      }
      if (
        observed.stdout.length > MAX_STDOUT_BYTES ||
        observed.stderr.length > MAX_STDERR_BYTES
      ) {
        throw new Error('cli_engine_process_output_too_large');
      }

      const stdoutText = observed.stdout.toString('utf8');
      const actualFinalText = parseOpenCodeFinalText(stdoutText);
      const actualUsage = readActualUsage(
        stdoutText,
        authority.totalTokenBound,
      );

      const body = JSON.stringify({
        id: `cli-engine-${input.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: authority.responseModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: actualFinalText,
            },
            finish_reason: 'stop',
          },
        ],
        usage_provenance: 'missing_or_invalid',
      });
      if (Buffer.byteLength(body, 'utf8') > CLI_ENGINE_MAX_RESPONSE_BYTES) {
        throw new Error('cli_engine_response_too_large');
      }

      const receipt: CliEngineReceipt = {
        version: 1,
        kind: 'cli_engine_terminal',
        requestId: input.requestId,
        connectionId: authority.connectionId,
        bindingHash: authority.bindingHash,
        wireHash: parsed.wireHash,
        responseHash: sha256(body),
        model: authority.model,
        responseModel: authority.responseModel,
        ...(authority.reasoningEffort !== undefined
          ? { reasoningEffort: authority.reasoningEffort }
          : {}),
        bootId: this.bootId,
        ending: 'exited',
        exitCode: 0,
        closed: true,
        finishReason: 'stop',
        stdoutHash: sha256(observed.stdout),
        stderrHash: sha256(observed.stderr),
        stdoutBytes: observed.stdout.length,
        stderrBytes: observed.stderr.length,
        actualUsage,
        totalTokenBound: authority.totalTokenBound,
        cliVersion: capabilities.version,
      };

      const canonicalReceipt = serializeCliEngineReceipt(receipt);
      const signature = cliEngineSign(canonicalReceipt, input.bearer);
      const receiptHeader = encodeCliEngineReceipt(receipt);
      if (receiptHeader.length > MAX_RECEIPT_HEADER_CHARS) {
        throw new Error('cli_engine_receipt_too_large');
      }

      return {
        status: 200,
        body,
        headers: {
          'Content-Type': 'application/json',
          [CLI_ENGINE_REQUEST_HEADER]: input.requestId,
          [CLI_ENGINE_RECEIPT_HEADER]: receiptHeader,
          [CLI_ENGINE_SIGNATURE_HEADER]: signature,
        },
      };
    } finally {
      try {
        if (directory !== null) {
          try {
            await releaseOpencodeReviewProfile(directory);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      } finally {
        this.active.delete(input.requestId);
        activeEntry.resolve();
      }
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;

    this.closing = true;
    const active = Array.from(this.active.values());
    for (const request of active) request.controller.abort();

    const closePromise = Promise.all(
      active.map(request => request.done),
    ).then(() => undefined);
    this.closePromise = closePromise;
    return closePromise;
  }

  private assertLive(
    controller: AbortController,
    signal?: AbortSignal,
  ): void {
    if (this.closing || controller.signal.aborted || signal?.aborted) {
      throw new Error('cli_engine_aborted');
    }
  }
}

function parseWire(wire: string): ParsedWire {
  if (typeof wire !== 'string') {
    throw new Error('invalid_cli_engine_wire');
  }
  if (Buffer.byteLength(wire, 'utf8') > CLI_ENGINE_MAX_WIRE_BYTES) {
    throw new Error('cli_engine_wire_too_large');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(wire);
  } catch {
    throw new Error('invalid_cli_engine_wire');
  }
  if (!isPlainObject(raw)) throw new Error('invalid_cli_engine_wire');

  for (const key of [
    'tools',
    'tool_choice',
    'function_calls',
    'functions',
    'function_call',
  ]) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error('cli_engine_tools_unsupported');
    }
  }

  const parsed = wireSchema.parse(raw);
  if (parsed.stream === true) {
    throw new Error('cli_engine_stream_unsupported');
  }

  if (
    parsed.reasoning_effort !== undefined &&
    parsed.reasoningEffort !== undefined &&
    parsed.reasoning_effort !== parsed.reasoningEffort
  ) {
    throw new Error('invalid_cli_engine_reasoning_effort');
  }
  const reasoningEffort =
    parsed.reasoning_effort ?? parsed.reasoningEffort;

  if (
    parsed.response_format !== undefined &&
    !isPlainObject(parsed.response_format)
  ) {
    throw new Error('invalid_cli_engine_response_format');
  }

  const images: ImageAttachment[] = [];
  let totalImageBytes = 0;
  const messages: ParsedMessage[] = parsed.messages.map(
    (message): ParsedMessage => {
      if (typeof message.content === 'string') {
        return { role: message.role, content: message.content };
      }

      const content: ParsedPart[] = message.content.map(
        (part): ParsedPart => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
          }

          const decoded = decodeImageDataUrl(part.image_url.url);
          totalImageBytes += decoded.bytes.length;
          if (totalImageBytes > MAX_IMAGE_BYTES) {
            throw new Error('cli_engine_attachment_too_large');
          }

          const image: ImageAttachment = {
            number: images.length + 1,
            mime: decoded.mime,
            bytes: decoded.bytes,
          };
          images.push(image);

          return {
            type: 'image_url',
            image,
            ...(part.image_url.detail !== undefined
              ? { detail: part.image_url.detail }
              : {}),
          };
        },
      );

      return { role: message.role, content };
    },
  );

  let seenNonSystem = false;
  for (const message of messages) {
    if (message.role === 'system') {
      if (seenNonSystem) {
        throw new Error('invalid_cli_engine_message_order');
      }
    } else {
      seenNonSystem = true;
    }
  }

  return {
    model: parsed.model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(parsed.max_tokens !== undefined
      ? { maxTokens: parsed.max_tokens }
      : {}),
    ...(parsed.response_format !== undefined
      ? { responseFormat: parsed.response_format }
      : {}),
    messages,
    images,
    wireHash: sha256(wire),
  };
}

function assertEndpoint(endpoint: string): void {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    endpoint.length > 2048 ||
    endpoint.trim() !== endpoint ||
    CONTROL_CHARACTER_PATTERN.test(endpoint)
  ) {
    throw new Error('invalid_cli_engine_endpoint');
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('invalid_cli_engine_endpoint');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('invalid_cli_engine_endpoint');
  }
}

async function materializeImages(
  directory: string,
  images: readonly ImageAttachment[],
): Promise<void> {
  for (const image of images) {
    const extension = image.mime === 'image/jpeg' ? 'jpg' : 'png';
    const filePath = path.join(
      directory,
      `attachment-${image.number}-${randomUUID()}.${extension}`,
    );
    await writeFile(filePath, image.bytes, { flag: 'wx', mode: 0o600 });
    image.filePath = filePath;
  }
}

function decodeImageDataUrl(value: string): {
  mime: 'image/jpeg' | 'image/png';
  bytes: Buffer;
} {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IMAGE_BYTES
  ) {
    throw new Error('invalid_cli_engine_image');
  }

  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    value,
  );
  if (!match) throw new Error('invalid_cli_engine_image');

  const mime = match[1];
  const encoded = match[2];
  if (mime !== 'image/jpeg' && mime !== 'image/png') {
    throw new Error('invalid_cli_engine_image');
  }
  if (!encoded || encoded.length % 4 !== 0) {
    throw new Error('invalid_cli_engine_image');
  }

  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString('base64') !== encoded
  ) {
    throw new Error('invalid_cli_engine_image');
  }

  if (mime === 'image/jpeg') {
    if (
      bytes.length < 3 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff
    ) {
      throw new Error('invalid_cli_engine_image');
    }
  } else if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    throw new Error('invalid_cli_engine_image');
  }

  return { mime, bytes };
}

function buildAgentPrompt(
  messages: readonly ParsedMessage[],
  responseFormat: unknown,
): string {
  const systemParts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'system') continue;
    systemParts.push(systemMessageText(message));
  }
  const systemText = systemParts.join('\n\n');
  const outputContract =
    responseFormat === undefined
      ? ''
      : `Output contract (response_format):\n${JSON.stringify(responseFormat)}`;

  if (outputContract.length === 0) return systemText;
  if (systemText.length === 0) return outputContract;
  return `${systemText}\n\n${outputContract}`;
}

function systemMessageText(message: ParsedMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map(part =>
      part.type === 'text'
        ? part.text
        : `[attachment ${part.image.number}]`,
    )
    .join('');
}

function buildUserPrompt(messages: readonly ParsedMessage[]): string {
  const nonSystem = messages.filter(message => message.role !== 'system');
  if (nonSystem.length === 1) {
    const only = nonSystem[0];
    if (only && only.role === 'user' && typeof only.content === 'string') {
      return only.content;
    }
  }
  if (nonSystem.length === 0) return '';

  const conversation = nonSystem.map(message => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(part =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : {
                  type: 'image_url',
                  image_url: {
                    url: `nmv-cli-engine-attachment:${part.image.number}`,
                    ...(part.detail !== undefined
                      ? { detail: part.detail }
                      : {}),
                  },
                },
          ),
  }));

  return (
    'The following is the ordered JSON conversation. Roles and content are exact. ' +
    'Image attachments, when present, are supplied separately with --file in the same order as their image_url parts.\n\n' +
    JSON.stringify(conversation)
  );
}

function buildChildEnv(
  source: NodeJS.ProcessEnv,
  agentPrompt: string,
  maxTokens: number | undefined,
): NodeJS.ProcessEnv {
  const configContent = source.OPENCODE_CONFIG_CONTENT;
  if (typeof configContent !== 'string') {
    throw new Error('invalid_cli_engine_profile');
  }

  let config: unknown;
  try {
    config = JSON.parse(configContent);
  } catch {
    throw new Error('invalid_cli_engine_profile');
  }
  if (!isPlainObject(config)) {
    throw new Error('invalid_cli_engine_profile');
  }

  const agents = config.agent;
  if (!isPlainObject(agents)) {
    throw new Error('invalid_cli_engine_profile');
  }
  const reviewAgent = agents[OPENCODE_REVIEW_AGENT];
  if (!isPlainObject(reviewAgent)) {
    throw new Error('invalid_cli_engine_profile');
  }

  if (
    maxTokens !== undefined &&
    (!Number.isSafeInteger(maxTokens) ||
      maxTokens <= 0 ||
      maxTokens > MAX_OUTPUT_TOKENS)
  ) {
    throw new Error('invalid_cli_engine_max_tokens');
  }

  const nextConfig = {
    ...config,
    agent: {
      ...agents,
      [OPENCODE_REVIEW_AGENT]: {
        ...reviewAgent,
        prompt: agentPrompt,
      },
    },
  };

  const env: NodeJS.ProcessEnv = {
    ...source,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(nextConfig),
  };
  if (maxTokens === undefined) {
    delete env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX;
  } else {
    env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(maxTokens);
  }
  return env;
}

function assertCatalogSelection(
  catalog: CliHostCatalog,
  bootId: string,
  model: string,
  reasoningEffort: string | undefined,
): void {
  if (!catalog || typeof catalog !== 'object') {
    throw new Error('invalid_cli_engine_catalog');
  }
  if (catalog.version !== 1 || catalog.bootId !== bootId) {
    throw new Error('invalid_cli_engine_catalog');
  }
  if (
    typeof catalog.cliVersion !== 'string' ||
    catalog.cliVersion.length === 0 ||
    catalog.cliVersion.length > 80
  ) {
    throw new Error('invalid_cli_engine_catalog');
  }
  if (!Array.isArray(catalog.models)) {
    throw new Error('invalid_cli_engine_catalog');
  }

  const selected = catalog.models.find(entry => entry.id === model);
  if (!selected) throw new Error('cli_engine_model_unavailable');

  if (reasoningEffort !== undefined) {
    if (
      !Array.isArray(selected.variants) ||
      !selected.variants.includes(reasoningEffort)
    ) {
      throw new Error('cli_engine_variant_unavailable');
    }
  }
}

function assertAuthority(
  authority: CliEngineAuthorization,
  model: string,
  reasoningEffort: string | undefined,
): void {
  if (!authority || typeof authority !== 'object') {
    throw new Error('invalid_cli_engine_authority');
  }
  if (
    typeof authority.connectionId !== 'string' ||
    !UUID_PATTERN.test(authority.connectionId)
  ) {
    throw new Error('invalid_cli_engine_authority');
  }
  if (authority.model !== model) {
    throw new Error('cli_engine_model_mismatch');
  }
  if (authority.reasoningEffort !== reasoningEffort) {
    throw new Error('cli_engine_effort_mismatch');
  }
  if (
    typeof authority.responseModel !== 'string' ||
    authority.responseModel.length === 0 ||
    authority.responseModel.length > 200
  ) {
    throw new Error('invalid_cli_engine_authority');
  }
  if (
    !Number.isSafeInteger(authority.totalTokenBound) ||
    authority.totalTokenBound <= 0
  ) {
    throw new Error('invalid_cli_engine_authority');
  }
  if (
    !Number.isSafeInteger(authority.timeoutMs) ||
    authority.timeoutMs <= 0
  ) {
    throw new Error('invalid_cli_engine_authority');
  }
  if (
    typeof authority.bindingHash !== 'string' ||
    !SHA256_HEX_PATTERN.test(authority.bindingHash)
  ) {
    throw new Error('invalid_cli_engine_authority');
  }
  if (authority.reasoningEffort !== undefined) {
    if (
      !EFFORT_PATTERN.test(authority.reasoningEffort) ||
      authority.reasoningEffort === 'default'
    ) {
      throw new Error('invalid_cli_engine_authority');
    }
  }
}

function parseOpenCodeFinalText(stdout: string): string {
  const lines = stdout.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    throw new Error('cli_engine_output_empty');
  }

  const events: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      throw new Error('invalid_cli_engine_output');
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('invalid_cli_engine_output');
    }
    if (!isPlainObject(value)) {
      throw new Error('invalid_cli_engine_output');
    }
    assertSafeEvent(value);
    events.push(value);
  }

  let finalIndex = -1;
  let finalMessageId: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) throw new Error('invalid_cli_engine_output');
    const type = event.type;
    if (type === 'step_finish' || type === 'step-finish') {
      finalIndex = index;
      finalMessageId = readMessageId(event);
    }
  }

  if (finalIndex < 0) {
    throw new Error('cli_engine_missing_step_finish');
  }
  const finalEvent = events[finalIndex];
  if (!finalEvent) throw new Error('invalid_cli_engine_output');
  const finalPart = isPlainObject(finalEvent.part)
    ? finalEvent.part
    : null;
  const finishReason = finalPart?.reason ?? finalEvent.reason;
  if (finishReason !== 'stop') {
    throw new Error('cli_engine_finish_not_stop');
  }
  if (finalMessageId === null) {
    throw new Error('cli_engine_missing_final_message');
  }

  for (let index = finalIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (!event) throw new Error('invalid_cli_engine_output');
    const type = event.type;
    if (
      type === 'step_start' ||
      type === 'step_finish' ||
      type === 'step-finish' ||
      type === 'error'
    ) {
      throw new Error('invalid_cli_engine_output');
    }
    if (type === 'text' || type === 'message' || type === 'reasoning') {
      const messageId = readMessageId(event);
      if (messageId !== finalMessageId) {
        throw new Error('cli_engine_post_final_message');
      }
    }
  }

  const finalMap = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'text') continue;
    if (readMessageId(event) !== finalMessageId) continue;

    const part = event.part;
    if (!isPlainObject(part)) {
      throw new Error('invalid_cli_engine_output');
    }
    const partId = part.id;
    if (typeof partId !== 'string' || partId.length === 0) {
      throw new Error('invalid_cli_engine_output');
    }
    if (typeof part.text !== 'string') {
      throw new Error('invalid_cli_engine_output');
    }
    finalMap.set(partId, part.text);
  }

  if (finalMap.size === 0) {
    throw new Error('cli_engine_missing_final_text');
  }
  return Array.from(finalMap.values()).join('');
}

function assertSafeEvent(event: Record<string, unknown>): void {
  const type = event.type;
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('invalid_cli_engine_output');
  }
  if (type === 'error' || isToolEventName(type)) {
    throw new Error('cli_engine_process_error_event');
  }

  const part = event.part;
  if (part !== undefined) {
    if (!isPlainObject(part)) {
      throw new Error('invalid_cli_engine_output');
    }
    if (part.type === 'error' || isToolEventName(part.type)) {
      throw new Error('cli_engine_process_error_event');
    }
  }

  if (event.error !== undefined && event.error !== null) {
    throw new Error('cli_engine_process_error_event');
  }
}

function readMessageId(event: Record<string, unknown>): string | null {
  const part = event.part;
  if (isPlainObject(part)) {
    const id = part.messageID ?? part.messageId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const id = event.messageID ?? event.messageId;
  if (typeof id === 'string' && id.length > 0) return id;
  return null;
}

function isToolEventName(value: unknown): boolean {
  return (
    value === 'tool' ||
    value === 'tool_use' ||
    value === 'tool_result' ||
    value === 'tool_call'
  );
}

function readActualUsage(
  stdout: string,
  totalTokenBound: number,
): CliEngineReceipt['actualUsage'] {
  const reported = opencodeReportedUsage(stdout);
  if (reported === null) return null;

  const inputTokens = reported.inputTokens;
  const outputTokens = reported.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw new Error('invalid_cli_engine_usage');
  }

  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw new Error('invalid_cli_engine_usage');
  }
  if (totalTokens > totalTokenBound) {
    throw new Error('cli_engine_usage_exceeds_bound');
  }

  return { inputTokens, outputTokens, totalTokens };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
