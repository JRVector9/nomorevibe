/** 소유 프로세스가 사라진 dispatched 장부 행을 indeterminate 로 옮기고(mark), 그 뒤 사람 검토로 닫는(close-review) 운영자 도구.
 * 모든 쓰기 명령은 기본 dry-run(같은 TX 를 실제로 실행한 뒤 ROLLBACK)이며 --apply 가 있어야 commit 한다. 대상은 --request 로 명시한 id 뿐이다(최대 20건).
 * DB URL 은 --database-url-stdin 으로 stdin 한 줄만 받는다(argv/env/로그에 쓰지 않음). 판정 규칙은 lib/operations/dr/owner-gone.ts. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { identity } from '@/lib/operations/dr/epoch';
import { OWNER_GONE_MAX_REQUESTS, OWNER_GONE_QUIET_MS } from '@/lib/operations/dr/owner-gone-contract';
import { parseDatabaseUrl } from './dr/promotion';

export type OwnerGoneCliCommand =
  | { command: 'mark'; apply: boolean; requestIds: string[]; operator: string; quietMs: number }
  | { command: 'close-review'; apply: boolean; requestIds: string[]; operator: string; note: string };

const ALLOWED: Record<OwnerGoneCliCommand['command'], readonly string[]> = {
  mark: ['request', 'operator', 'quiet-minutes', 'apply'],
  'close-review': ['request', 'operator', 'note', 'apply'],
};
const fail = (code: string): never => { throw new Error(code); };

/** --key=value 형식만. 모르는/중복 옵션, URL 인자는 거절한다. --request 만 여러 번 쓸 수 있다. */
export function parseOwnerGoneCliArgs(args: readonly string[]): OwnerGoneCliCommand {
  const [command, ...rest] = args;
  if (!command || !Object.hasOwn(ALLOWED, command)) return fail('owner_gone_cli_unknown_command');
  const name = command as OwnerGoneCliCommand['command'], options = new Map<string, string[]>();
  let stdin = false;
  for (const arg of rest) {
    if (arg === '--database-url-stdin') { if (stdin) fail('owner_gone_cli_duplicate_option'); stdin = true; continue; }
    const match = /^--([a-z-]+)(?:=([^\n]*))?$/.exec(arg);
    if (!match || !ALLOWED[name].includes(match[1])) return fail('owner_gone_cli_unknown_option');
    if (match[1] === 'apply' ? match[2] !== undefined : match[2] === undefined || match[2] === '') fail('owner_gone_cli_invalid_option');
    if (options.has(match[1]) && match[1] !== 'request') fail('owner_gone_cli_duplicate_option');
    options.set(match[1], [...options.get(match[1]) ?? [], match[2] ?? '']);
  }
  if (!stdin) fail('owner_gone_cli_database_url_stdin_required');
  const one = (key: string) => options.get(key)?.[0] ?? fail(`owner_gone_cli_missing_${key.replace(/-/g, '_')}`);
  const requests = options.get('request') ?? fail('owner_gone_cli_missing_request');
  const parsedIds = z.array(z.uuid()).min(1).max(OWNER_GONE_MAX_REQUESTS).safeParse(requests);
  if (!parsedIds.success) fail('owner_gone_cli_invalid_request');
  const requestIds = parsedIds.data!.map(id => id.toLowerCase());
  if (new Set(requestIds).size !== requestIds.length) fail('owner_gone_cli_duplicate_request');
  const operator = identity(120).safeParse(one('operator'));
  if (!operator.success) fail('owner_gone_cli_invalid_operator');
  const apply = options.has('apply');
  if (name === 'mark') {
    const minutes = options.has('quiet-minutes') ? Number(one('quiet-minutes')) : OWNER_GONE_QUIET_MS.default / 60_000;
    const quietMs = minutes * 60_000;
    if (!Number.isSafeInteger(minutes) || quietMs < OWNER_GONE_QUIET_MS.min || quietMs > OWNER_GONE_QUIET_MS.max) fail('owner_gone_cli_invalid_quiet_minutes');
    return { command: name, apply, requestIds, operator: operator.data!, quietMs };
  }
  const note = z.string().trim().min(1).max(400).safeParse(one('note'));
  if (!note.success) fail('owner_gone_cli_invalid_note');
  return { command: name, apply, requestIds, operator: operator.data!, note: note.data! };
}

type Io = { stdin: () => Promise<string>; stdout: (line: string) => void };
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 4096) fail('dr_cli_invalid_database_url'); }
  return Buffer.concat(chunks).toString('utf8');
}

/** 종료 코드: 0 = 모든 대상이 바뀜(또는 dry-run 에서 바뀔 것), 3 = 하나라도 바뀌지 않음(거절·이미 다른 상태), 1 = 오류. */
export async function ownerGoneCliMain(args: readonly string[], io: Io = { stdin: readStdin, stdout: line => process.stdout.write(line) }): Promise<number> {
  const command = parseOwnerGoneCliArgs(args);
  if ((globalThis as { db?: unknown }).db || (globalThis as { pgClient?: unknown }).pgClient) fail('dr_cli_database_already_open');
  process.env.DATABASE_URL = parseDatabaseUrl(await io.stdin());
  delete process.env.READ_DATABASE_URL;
  try {
    const out = (result: unknown, blocked: boolean) => {
      io.stdout(`${JSON.stringify({ command: command.command, dryRun: !command.apply, blocked, result })}\n`);
      return blocked ? 3 : 0;
    };
    if (command.command === 'mark') {
      const { markOwnerGoneIndeterminate } = await import('@/lib/operations/dr/owner-gone');
      const result = await markOwnerGoneIndeterminate(command, command.apply);
      return out(result, result.rows.some(row => row.status !== 'marked'));
    }
    const { closeOwnerGoneReviews } = await import('@/lib/operations/dr/owner-gone');
    const result = await closeOwnerGoneReviews(command, command.apply);
    return out(result, result.rows.some(row => row.result !== 'reviewed' && row.result !== 'would_review'));
  } finally {
    await (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void ownerGoneCliMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    // 고정 code 만 출력한다. URL/SQL/stack 은 쓰지 않는다.
    const message = error instanceof Error && /^[a-z][a-z0-9_:]{2,120}$/.test(error.message) ? error.message : 'owner_gone_cli_failed';
    process.stderr.write(`${JSON.stringify({ code: message })}\n`); process.exitCode = 1;
  });
}
