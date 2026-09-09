import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OUTPUT_SCHEMA, type CliRun, type CliResult } from '@/lib/crawl/classify';

export function validateClaudeCredential(value: string): string {
  if (!/^sk-ant-(?:at|oat)[0-9]{2}-[A-Za-z0-9_-]+$/.test(value) || value.length < 40 || value.length > 8192) throw new Error('invalid_claude_credential');
  return value;
}
export function killProcessGroup(pid: number | undefined) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already closed */ }
}
export function isolatedClaudeEnv(home: string): NodeJS.ProcessEnv {
  // Do not inherit API proxies, ambient API keys, login tokens or customization paths.
  return { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, SHELL: '/bin/sh', LANG: process.env.LANG ?? 'C.UTF-8', HOME: home,
    CLAUDE_CONFIG_DIR: join(home, 'claude'), XDG_CONFIG_HOME: join(home, '.config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4000' };
}
export const runClaude = (token: string): CliRun => async (codexArgs, stdin, timeoutMs) => {
  const home = mkdtempSync(join(tmpdir(), 'nomorevibe-claude-run-'));
  try {
    return await new Promise<CliResult>(resolve => {
      const model = codexArgs[codexArgs.indexOf('-m') + 1];
      const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(OUTPUT_SCHEMA),
        '--model', model, '--effort', 'high', '--tools', '', '--max-turns', '1', '--no-session-persistence',
        '--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-chrome'];
      const child = spawn(process.env.CLAUDE_CLI ?? 'claude', args, { cwd: home,
        env: { ...isolatedClaudeEnv(home), CLAUDE_CODE_OAUTH_TOKEN: token }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0, stopped: CliResult | null = null;
      const stop = (kind: 'timeout' | 'output_too_large' | 'cli_error') => { stopped ??= { kind }; killProcessGroup(child.pid); };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const collect = (chunk: Buffer, error: boolean) => {
        bytes += chunk.length;
        if (bytes > 96 * 1024) { stop('output_too_large'); return; }
        if (error) stderr += chunk.toString(); else stdout += chunk.toString();
      };
      child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true));
      child.stdin.on('error', () => stop('cli_error'));
      child.on('error', (error: NodeJS.ErrnoException) => { stopped ??= { kind: error.code === 'ENOENT' ? 'missing' : 'cli_error' }; });
      child.on('close', code => {
        clearTimeout(timer); killProcessGroup(child.pid);
        if (stopped) { resolve(stopped); return; }
        try {
          const envelope = JSON.parse(stdout);
          if (envelope.is_error) code = 1;
          else if (envelope.structured_output) stdout = JSON.stringify(envelope.structured_output);
          else stdout = ''; // Only structured output is accepted.
        } catch { stdout = ''; }
        resolve({ kind: 'exit', code, stdout, stderr });
      });
      child.stdin.end(stdin);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
};
