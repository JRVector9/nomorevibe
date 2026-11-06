import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OPENCODE_REVIEW_AGENT, opencodeReviewArgs, opencodeReviewProfile, releaseOpencodeReviewProfile } from '@/lib/crawl/agent-review-opencode';
import { readOpenCodeCliCapabilities } from '@/lib/crawl/opencode-cli-capabilities';
import { setCliHostObservedVersion } from '@/lib/llm/cli-serving-contract';
import type { CliHostResponseProbeError } from './cli-host-protocol';

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const TIMEOUT_MS = 30_000;
const PROMPT = 'Connection diagnostic. Reply with OK only.';

export type CliHostResponseProbeOutcome = { ok: boolean; ms: number; error?: CliHostResponseProbeError };

type Event = Record<string, unknown> & { part?: Record<string, unknown> };

async function cleanup(directory: string): Promise<void> {
  await releaseOpencodeReviewProfile(directory).catch(() => {});
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

function successfulResponse(stdout: string): boolean {
  try {
    const events = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_opencode_event');
      return value as Event;
    });
    if (!events.length) return false;
    if (events.some(event => event.type === 'error' || event.type === 'tool_use' || event.type === 'tool')) return false;
    const finishAt = events.findLastIndex(event => event.type === 'step_finish');
    const part = events[finishAt]?.part;
    if (!part || part.reason !== 'stop' || typeof part.messageID !== 'string' || !part.messageID) return false;
    const messageID = part.messageID;
    if (events.slice(finishAt + 1).some(event => ['step_start', 'text', 'reasoning'].includes(String(event.type)) && event.part?.messageID !== messageID))
      return false;
    const text = events.filter(event => event.type === 'text' && event.part?.messageID === messageID)
      .map(event => typeof event.part?.text === 'string' ? event.part.text : '').join('').trim();
    return text.length > 0;
  } catch { return false; }
}

export async function runCliHostResponseProbe(input: { model: string; reasoningEffort?: string }): Promise<CliHostResponseProbeOutcome> {
  const started = Date.now();
  let directory: string;
  try { directory = await mkdtemp(path.join(tmpdir(), 'nmv-opencode-probe-')); }
  catch { return { ok: false, ms: Date.now() - started, error: 'unavailable' }; }
  let profile: Awaited<ReturnType<typeof opencodeReviewProfile>>;
  try { profile = await opencodeReviewProfile(directory); }
  catch { await cleanup(directory); return { ok: false, ms: Date.now() - started, error: 'cli_error' }; }
  let capabilities: Awaited<ReturnType<typeof readOpenCodeCliCapabilities>>;
  try {
    capabilities = await readOpenCodeCliCapabilities(profile.command, directory, profile.env);
    setCliHostObservedVersion(capabilities.version);
  } catch { await cleanup(directory); return { ok: false, ms: Date.now() - started, error: 'cli_error' }; }
  try {
    // Keep the isolated deny-all profile; only the fixed diagnostic instruction changes.
    const config = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}') as { agent: Record<string, { prompt?: string }> };
    config.agent[OPENCODE_REVIEW_AGENT].prompt = 'This is a model connection diagnostic. Reply with OK only. Do not use tools.';
    const env = { ...profile.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '1024' };
    return await new Promise<CliHostResponseProbeOutcome>(resolve => {
      let spawned: ChildProcess | null = null;
      let timedOut = false, overflow = false, settled = false;
      const stop = () => { try { spawned?.kill('SIGKILL'); } catch { /* sanitized below */ } };
      const timer = setTimeout(() => { timedOut = true; stop(); }, TIMEOUT_MS);
      const stdout: Buffer[] = [];
      let stdoutBytes = 0, stderrBytes = 0;
      const finish = (error?: CliHostResponseProbeError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ms = Date.now() - started;
        void cleanup(directory).then(() => resolve({ ok: error === undefined, ms, ...(error === undefined ? {} : { error }) }));
      };
      try {
        spawned = spawn(capabilities.command, [...opencodeReviewArgs(input.model, input.reasoningEffort, capabilities), PROMPT], {
          cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { finish('cli_error'); return; }
      if (!spawned) { finish('cli_error'); return; }
      const child = spawned;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (overflow) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) { overflow = true; stop(); return; }
        stdout.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (overflow) return;
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) { overflow = true; stop(); }
      });
      child.stdin?.on('error', () => stop());
      child.stdin?.end();
      child.on('error', () => { /* close settles; no raw error is exposed */ });
      child.on('close', code => {
        if (timedOut) finish('timeout');
        else if (overflow) finish('output_too_large');
        else if (code !== 0) finish('cli_error');
        else if (!successfulResponse(Buffer.concat(stdout).toString('utf8'))) finish('invalid_output');
        else finish();
      });
    });
  } catch {
    await cleanup(directory);
    return { ok: false, ms: Date.now() - started, error: 'unavailable' };
  }
}
