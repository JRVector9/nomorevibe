const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const REVISION_PATTERN =
  /^cli-engine-v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(default|[a-z0-9][a-z0-9_-]{0,31})$/;

export type CliEngineSource = Readonly<{
  connectionId: string;
  reasoningEffort?: string;
}>;

export const CLI_ENGINE_AUTH_PREFIX = 'nmv-cli-engine.';

export const OPENCODE_NATIVE_TASK_ROUTES: readonly string[] = Object.freeze(["product-intro-check", "product-audit"]);

export const CLI_ENGINE_TASKS = [
  'crawl-tagline',
  'reason-translate',
  'product-translate',
  'product-tagline-ko',
  'search-query-translate',
  'product-search-profile',
  'product-search-verify',
  'human-review',
  'split-confirm',
  'split-tiebreak',
  'held-review-retry',
  'audit-review',
  'audit-second-opinion',
  'published-filter',
  'screen-review',
  'assist-review',
  'assist-audit',
  'publish-classify',
] as const;

export function cliEngineRevision(source: CliEngineSource): string {
  if (
    source === null ||
    typeof source !== 'object' ||
    typeof source.connectionId !== 'string' ||
    source.connectionId.trim() !== source.connectionId ||
    !UUID_PATTERN.test(source.connectionId)
  ) {
    throw new Error('invalid_cli_engine_source');
  }

  const effort = source.reasoningEffort;
  if (
    effort !== undefined &&
    (typeof effort !== 'string' ||
      effort.trim() !== effort ||
      effort === 'default' ||
      !EFFORT_PATTERN.test(effort))
  ) {
    throw new Error('invalid_cli_engine_source');
  }

  return `cli-engine-v1:${source.connectionId}:${effort ?? 'default'}`;
}

export function parseCliEngineRevision(
  value: unknown,
): CliEngineSource | null {
  if (typeof value !== 'string' || value.trim() !== value) return null;

  const match = REVISION_PATTERN.exec(value);
  if (!match) return null;

  const [, connectionId, effort] = match;
  if (!connectionId || !effort) return null;

  if (effort === 'default') return { connectionId };
  return { connectionId, reasoningEffort: effort };
}

export function isCliEngineConnection(connection: {
  kind?: unknown;
  cliTool?: unknown;
}): boolean {
  if (!connection) return false;
  return connection.kind === 'cli' && connection.cliTool === 'opencode';
}

export function isCliEngineTask(taskId: string): boolean {
  return (CLI_ENGINE_TASKS as readonly string[]).includes(taskId);
}

export function aiTaskUsesCliEngine(
  taskId: string,
  connection: { kind?: unknown; cliTool?: unknown },
): boolean {
  return isCliEngineTask(taskId) && isCliEngineConnection(connection);
}

export function cliEngineEndpoint(baseUrl: string): string {
  if (typeof baseUrl !== 'string') {
    throw new Error('invalid_cli_engine_endpoint');
  }

  const lowerBaseUrl = baseUrl.toLowerCase();
  if (
    baseUrl.length === 0 ||
    (!lowerBaseUrl.startsWith('http://') &&
      !lowerBaseUrl.startsWith('https://')) ||
    /\s/.test(baseUrl) ||
    baseUrl.includes('@') ||
    baseUrl.includes('?') ||
    baseUrl.includes('#')
  ) {
    throw new Error('invalid_cli_engine_endpoint');
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('invalid_cli_engine_endpoint');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '/v1' && url.pathname !== '/v1/')
  ) {
    throw new Error('invalid_cli_engine_endpoint');
  }

  return `${url.origin}/v1/chat/completions`;
}
