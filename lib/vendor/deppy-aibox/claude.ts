import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { CaptureUpdate, ConnectProvider, Credential, ProviderRuntimeContext, ProviderSpawnContext } from './core';
import { DEFAULT_MAX_DISPLAY_CHARS, stripAnsi } from './core';

export const CLAUDE_TOKEN_RE = /sk-ant-(?:at|oat)[0-9]{2}-[A-Za-z0-9_-]+/;
export const CLAUDE_TOKEN_MARK = 'sk-ant-';
export const CLAUDE_URL_RE = /https:\/\/(?:[a-z0-9-]+\.)?(?:claude\.(?:ai|com)|anthropic\.com)\/[^\s"'<>]+/g;
export const MIN_CLAUDE_TOKEN_LEN = 40;
export const CLAUDE_COLUMNS = '4096';
const DISP_HOLD = 12;

export type ClaudeProviderOptions = {
  command?: string;
  scriptCommand?: string;
  maxDisplayChars?: number;
};

export type ClaudeCaptureState = {
  buf: string;
  dispOut: string;
  dispTail: string;
  tokenSeen: boolean;
  decoder: StringDecoder;
};

export function createClaudeCaptureState(): ClaudeCaptureState {
  return {
    buf: '',
    dispOut: '',
    dispTail: '',
    tokenSeen: false,
    decoder: new StringDecoder('utf8'),
  };
}

export function redactClaudeToken(input: string): string {
  return input.replace(/sk-ant-[a-z]+[0-9]{2}-[A-Za-z0-9_-]+/g, '[REDACTED]');
}

function tokenRuns(line: string): string[] {
  return line.match(/[A-Za-z0-9_-]+/g) ?? [];
}

export function captureClaudeToken(buf: string, atEof: boolean): string | null {
  const norm = stripAnsi(buf).replace(/\r/g, '');
  const anchor = norm.match(CLAUDE_TOKEN_RE);
  if (!anchor || typeof anchor.index !== 'number') return null;

  const lines = norm.slice(anchor.index).split('\n');
  let token = tokenRuns(lines[0] ?? '')[0] ?? '';
  let done = atEof;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // setup-token's footer can be split at "Store" by Ink/PTY updates. It is never a token continuation.
    if (/^\s*Store(?:\s|$)/.test(line)) {
      if (i === lines.length - 1 && !atEof) return null;
      done = true;
      break;
    }
    const runs = tokenRuns(line);
    if (runs.length === 1) {
      token += runs[0]!;
      continue;
    }

    const lastIncomplete = i === lines.length - 1 && !atEof;
    if (runs.length >= 2) done = true;
    // Ink renders setup-token with gap:1: a completed blank line also terminates the token.
    else if (!lastIncomplete) done = true;
    break;
  }

  if (!done) return null;
  const match = token.match(CLAUDE_TOKEN_RE);
  return match && match[0].length >= MIN_CLAUDE_TOKEN_LEN ? match[0] : null;
}

export function extractClaudeAuthorizeUrl(buf: string): string | null {
  const clean = stripAnsi(buf);
  const authUrl = (clean.match(CLAUDE_URL_RE) ?? []).find((url) => url.includes('authorize') && url.includes('client_id='));
  if (!authUrl) return null;
  const end = clean.indexOf(authUrl) + authUrl.length;
  return end < clean.length ? authUrl : null;
}

function credential(value: string): Credential {
  return { provider: 'claude', kind: 'token', value };
}

export function handleClaudeOutput(
  chunk: Buffer,
  state: ClaudeCaptureState,
  options: { maxDisplayChars?: number } = {},
): CaptureUpdate {
  const maxDisplayChars = options.maxDisplayChars ?? DEFAULT_MAX_DISPLAY_CHARS;
  state.buf = (state.buf + chunk.toString('latin1')).slice(-60000);

  const update: CaptureUpdate = {};
  const authUrl = extractClaudeAuthorizeUrl(state.buf);
  if (authUrl) update.url = authUrl;

  if (!state.tokenSeen) {
    const combined = state.dispTail + stripAnsi(state.decoder.write(chunk));
    const mark = combined.indexOf(CLAUDE_TOKEN_MARK);
    if (mark >= 0) {
      state.tokenSeen = true;
      const safe = redactClaudeToken(combined.slice(0, mark));
      state.dispOut = (state.dispOut + safe + '\n[Token received - saving...]').slice(-maxDisplayChars);
      state.dispTail = '';
    } else {
      const emit = combined.length > DISP_HOLD ? combined.slice(0, -DISP_HOLD) : '';
      state.dispTail = combined.length > DISP_HOLD ? combined.slice(-DISP_HOLD) : combined;
      if (emit) state.dispOut = (state.dispOut + redactClaudeToken(emit)).slice(-maxDisplayChars);
    }
    update.out = state.dispOut;
  }

  const token = captureClaudeToken(state.buf, false);
  if (token) update.credential = credential(token);
  return update;
}

export function handleClaudeClose(state: ClaudeCaptureState): CaptureUpdate {
  const token = captureClaudeToken(state.buf, true);
  if (token) return { credential: credential(token), out: state.dispOut };
  return { error: 'claude setup-token exited before a token was captured' };
}

export function claudeProvider(options: ClaudeProviderOptions = {}): ConnectProvider<ClaudeCaptureState> {
  const command = options.command ?? 'claude';
  const scriptCommand = options.scriptCommand ?? 'script';
  return {
    id: 'claude',
    displayName: 'Claude',
    tmpPrefix: 'claude-connect-',
    acceptsInput: true,
    spawn(ctx: ProviderSpawnContext) {
      return {
        command: scriptCommand,
        args: ['-q', '-f', '-c', `stty cols ${CLAUDE_COLUMNS} rows 80; ${command} setup-token`, '/dev/null'],
        env: {
          ...ctx.env,
          HOME: ctx.tmpDir,
          CLAUDE_CONFIG_DIR: join(ctx.tmpDir, 'claude'),
          XDG_CONFIG_HOME: join(ctx.tmpDir, '.config'),
          COLUMNS: CLAUDE_COLUMNS,
          LINES: '50',
          TERM: 'xterm-256color',
        },
      };
    },
    createState: createClaudeCaptureState,
    onOutput(chunk: Buffer, state: ClaudeCaptureState) {
      return handleClaudeOutput(chunk, state, { maxDisplayChars: options.maxDisplayChars });
    },
    onClose(state: ClaudeCaptureState, _ctx: ProviderRuntimeContext) {
      return handleClaudeClose(state);
    },
  };
}
