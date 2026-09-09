export type ProviderId = 'codex' | 'claude' | (string & {});

export type SessionState = 'idle' | 'starting' | 'pending' | 'completing' | 'connected' | 'error';

export type CredentialKind = 'json' | 'token' | 'text';

export type Credential = {
  provider: ProviderId;
  kind: CredentialKind;
  value: string;
};

export type PublicConnectState = {
  provider?: ProviderId;
  state: SessionState;
  url?: string | null;
  code?: string | null;
  out?: string;
  detail?: string;
};

export type TicketClaims = {
  sessionId: string;
  subjectId: string;
  expiresAt?: number;
  meta?: Record<string, unknown>;
};

export type ChildSpec = {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdinEnd?: boolean;
};

export type ProviderSpawnContext = {
  tmpDir: string;
  env: NodeJS.ProcessEnv;
  meta?: Readonly<Record<string, unknown>>;
};

export type ProviderRuntimeContext = {
  tmpDir: string;
  meta?: Readonly<Record<string, unknown>>;
};

export type CaptureUpdate = {
  url?: string | null;
  code?: string | null;
  out?: string;
  credential?: Credential;
  detail?: string;
  error?: string;
};

export type ConnectProvider<State = unknown> = {
  id: ProviderId;
  displayName: string;
  tmpPrefix: string;
  acceptsInput: boolean;
  spawn(ctx: ProviderSpawnContext): ChildSpec;
  createState?(): State;
  onOutput?(chunk: Buffer, state: State, ctx: ProviderRuntimeContext): CaptureUpdate | null;
  onClose?(state: State, ctx: ProviderRuntimeContext): CaptureUpdate | null;
  readCredential?(state: State, ctx: ProviderRuntimeContext): Credential | null;
};

export type ConnectStorageEvent = {
  id: string;
  provider: ProviderId;
  credential: Credential;
  subjectId: string;
  sessionId: string;
  meta?: Record<string, unknown>;
  createdAt: string;
};

export type ConnectClientTicket = {
  ticket: string;
  connectBaseUrl: string;
  sessionId?: string;
};

export const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
export const DEFAULT_MAX_SESSIONS = 50;
export const DEFAULT_MAX_SESSIONS_PER_SUBJECT = 2;
export const DEFAULT_MAX_INPUT_LEN = 4096;
export const DEFAULT_MAX_DISPLAY_CHARS = 8000;

export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][AB0]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
