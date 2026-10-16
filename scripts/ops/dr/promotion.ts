/** 수동 DR 승격 도구. 자동 승격·양방향 merge·옛 DB unfence 명령은 없다.
 * 모든 쓰기 명령은 기본 dry-run(같은 TX를 실제로 실행한 뒤 ROLLBACK)이며 --apply가 있어야 commit한다.
 * DB URL은 --database-url-stdin으로 stdin 한 줄만 받는다(argv/env/로그에 쓰지 않음). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { dbIdentitySchema, identity, positiveEpoch, type DbIdentity } from '@/lib/operations/dr/epoch';
import { EVIDENCE_KINDS, promotionPlanSchema, type EvidenceKind, type PromotionPlan } from '@/lib/operations/dr/promotion';
import type { ReclaimPolicy } from '@/lib/operations/dr/call-drain';
import type { ReclaimPolicyWithReference } from '@/lib/operations/dr/reclaim';

export type PromotionCliCommand =
  | { command: 'identity' }
  | { command: 'fence-old'; apply: boolean; operator: string; lineageId: string; writerEpoch: number; db: DbIdentity }
  | { command: 'seal'; apply: boolean; plan: PromotionPlan }
  | { command: 'record-evidence'; apply: boolean; promotionId: string; kind: EvidenceKind; subject: string; payload: unknown; operator: string }
  | { command: 'status'; promotionId: string }
  | { command: 'promote'; apply: boolean; promotionId: string; operator: string }
  | { command: 'open-permits'; apply: boolean; promotionId: string; target: 'http' | 'model'; operator: string }
  | { command: 'process-reclaim-report'; instanceId: string; bootId: string; policies: Map<string, ReclaimPolicy> }
  | { command: 'process-reclaim'; apply: boolean; instanceId: string; bootId: string; operator: string; policies: Map<string, ReclaimPolicyWithReference> }
  | { command: 'release-drained'; apply: boolean; promotionId: string; operator: string };

const ALLOWED: Record<PromotionCliCommand['command'], readonly string[]> = {
  identity: [], 'fence-old': ['expect-lineage', 'expect-epoch', 'expect-db', 'operator', 'apply'], seal: ['plan', 'apply'],
  'record-evidence': ['promotion', 'kind', 'subject', 'payload', 'operator', 'apply'], status: ['promotion'],
  promote: ['promotion', 'operator', 'apply'], 'open-permits': ['promotion', 'target', 'operator', 'apply'],
  'process-reclaim-report': ['instance', 'boot', 'deadline', 'client-bound', 'skew-ms'],
  'process-reclaim': ['instance', 'boot', 'deadline', 'client-bound', 'skew-ms', 'reference', 'operator', 'apply'],
  'release-drained': ['promotion', 'operator', 'apply'],
};
const REPEATABLE = new Set(['deadline', 'client-bound']);
const fail = (code: string): never => { throw new Error(code); };

/** --key=value 형식만. 모르는/중복 옵션, URL 인자는 거절한다. */
export function parsePromotionCliArgs(args: readonly string[], readFile: (path: string) => string = path => readFileSync(path, 'utf8')): PromotionCliCommand {
  const [command, ...rest] = args;
  if (!command || !Object.hasOwn(ALLOWED, command)) return fail('dr_cli_unknown_command');
  const name = command as PromotionCliCommand['command'], options = new Map<string, string[]>();
  let stdin = false;
  for (const arg of rest) {
    if (arg === '--database-url-stdin') { if (stdin) fail('dr_cli_duplicate_option'); stdin = true; continue; }
    const match = /^--([a-z-]+)(?:=([^\n]*))?$/.exec(arg);
    if (!match || !ALLOWED[name].includes(match[1])) return fail('dr_cli_unknown_option');
    if (match[1] === 'apply' ? match[2] !== undefined : match[2] === undefined || match[2] === '') fail('dr_cli_invalid_option');
    if (options.has(match[1]) && !REPEATABLE.has(match[1])) fail('dr_cli_duplicate_option');
    options.set(match[1], [...options.get(match[1]) ?? [], match[2] ?? '']);
  }
  if (!stdin) fail('dr_cli_database_url_stdin_required');
  const one = (key: string) => options.get(key)?.[0] ?? fail(`dr_cli_missing_${key.replace(/-/g, '_')}`);
  const apply = options.has('apply'), json = (key: string) => {
    try { return JSON.parse(readFile(one(key))) as unknown; } catch { return fail(`dr_cli_invalid_${key}_file`); }
  };
  const operator = () => identity(120).parse(one('operator')), promotionId = () => z.uuid().parse(one('promotion'));
  const reclaimPolicies = () => {
    const skewBoundMs = options.has('skew-ms') ? z.number().int().min(1).max(600_000).parse(Number(one('skew-ms'))) : 1_000;
    const policies = new Map<string, ReclaimPolicy>();
    for (const value of options.get('deadline') ?? []) {
      const at = value.lastIndexOf(':');
      if (at < 1) fail('dr_cli_invalid_deadline');
      const budget = identity(120).parse(value.slice(0, at)), ms = z.number().int().min(1).max(86_400_000).parse(Number(value.slice(at + 1)));
      if (policies.has(budget)) fail('dr_cli_invalid_deadline');
      policies.set(budget, { termination: 'provider_bound', hardDeadlineMs: ms, skewBoundMs });
    }
    for (const value of options.get('client-bound') ?? []) {
      const budget = identity(120).parse(value);
      if (policies.has(budget)) fail('dr_cli_invalid_deadline');
      policies.set(budget, { termination: 'client_bound', hardDeadlineMs: null, skewBoundMs });
    }
    return policies;
  };
  switch (name) {
    case 'identity': return { command: name };
    case 'fence-old': {
      const parts = one('expect-db').split(':');
      if (parts.length !== 3) fail('dr_cli_invalid_expect_db');
      const db = dbIdentitySchema.parse({ systemIdentifier: parts[0], databaseOid: parts[1], databaseName: parts[2] });
      return { command: name, apply, operator: operator(), lineageId: z.uuid().parse(one('expect-lineage')),
        writerEpoch: positiveEpoch.parse(Number(one('expect-epoch'))), db };
    }
    case 'seal': return { command: name, apply, plan: promotionPlanSchema.parse(json('plan')) };
    case 'record-evidence': return { command: name, apply, promotionId: promotionId(), kind: z.enum(EVIDENCE_KINDS).parse(one('kind')),
      subject: identity(200).parse(one('subject')), payload: json('payload'), operator: operator() };
    case 'status': return { command: name, promotionId: promotionId() };
    case 'promote': return { command: name, apply, promotionId: promotionId(), operator: operator() };
    case 'open-permits': return { command: name, apply, promotionId: promotionId(), target: z.enum(['http', 'model']).parse(one('target')), operator: operator() };
    case 'process-reclaim-report':
      return { command: name, instanceId: identity(120).parse(one('instance')), bootId: z.uuid().parse(one('boot')), policies: reclaimPolicies() };
    case 'process-reclaim': {
      // 회수는 장부를 바꾸므로 정책 출처(reference)와 운영자를 근거에 남긴다. 기본 dry-run.
      const reference = identity(400).parse(one('reference'));
      const policies = new Map([...reclaimPolicies()].map(([budget, policy]) => [budget, { ...policy, reference }]));
      return { command: name, apply, instanceId: identity(120).parse(one('instance')), bootId: z.uuid().parse(one('boot')), operator: operator(), policies };
    }
    case 'release-drained': return { command: name, apply, promotionId: promotionId(), operator: operator() };
  }
}

/** 단일 host·명시 port·DB 이름의 postgres URL 한 줄. query는 sslmode 하나만. */
export function parseDatabaseUrl(text: string): string {
  const value = text.replace(/\r?\n$/, '');
  if (!value || /[\s]/.test(value)) return fail('dr_cli_invalid_database_url');
  let url: URL;
  try { url = new URL(value); } catch { return fail('dr_cli_invalid_database_url'); }
  const authority = value.slice(value.indexOf('://') + 3).split(/[?/]/)[0];
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || authority.slice(authority.indexOf('@') + 1) !== url.host || !url.port
    || !url.username || !/^\/[A-Za-z0-9_]+$/.test(url.pathname) || url.hash || url.host.includes(',')
    || [...url.searchParams.keys()].some(key => key !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1
    || (url.searchParams.has('sslmode') && !['disable', 'require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')!))) fail('dr_cli_invalid_database_url');
  return value;
}

type Io = { stdin: () => Promise<string>; stdout: (line: string) => void };
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 4096) fail('dr_cli_invalid_database_url'); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function promotionCliMain(args: readonly string[], io: Io = { stdin: readStdin, stdout: line => process.stdout.write(line) }): Promise<number> {
  const command = parsePromotionCliArgs(args);
  if ((globalThis as { db?: unknown }).db || (globalThis as { pgClient?: unknown }).pgClient) fail('dr_cli_database_already_open');
  process.env.DATABASE_URL = parseDatabaseUrl(await io.stdin());
  delete process.env.READ_DATABASE_URL;
  try {
    const repository = await import('@/lib/operations/dr/repository');
    const out = (result: unknown, blocked = false) => { io.stdout(`${JSON.stringify({ command: command.command, dryRun: 'apply' in command ? !command.apply : true, blocked, result })}\n`); return blocked ? 3 : 0; };
    switch (command.command) {
      case 'identity': {
        const { readDatabaseIdentity, lockWriterFence } = await import('@/lib/operations/dr/epoch');
        return out(await repository.drTransactionMaybeDry(false, async tx => ({ db: await readDatabaseIdentity(tx), fence: await lockWriterFence(tx, 'share') })));
      }
      case 'fence-old': {
        const { fenceWriterSite } = await import('@/lib/operations/dr/epoch');
        return out(await repository.drTransactionMaybeDry(command.apply, tx => fenceWriterSite(tx, { lineageId: command.lineageId,
          writerEpoch: command.writerEpoch, db: command.db, operator: command.operator })));
      }
      case 'seal': return out(await repository.sealRestoredDatabase(command.plan, command.apply));
      case 'record-evidence': return out(await repository.recordPromotionEvidence(command, command.apply));
      case 'status': { const status = await repository.readPromotionStatus(command.promotionId); return out(status, !status.evaluation.ready); }
      case 'promote': { const result = await repository.promoteSealedDatabase(command, command.apply); return out(result, result.kind === 'blocked'); }
      case 'open-permits': {
        const permits = await import('@/lib/operations/dr/permits');
        const result = command.target === 'http' ? await permits.openHttpPermitsAfterDrain(command, command.apply)
          : await permits.openModelCapacityAfterDrain(command, command.apply);
        return out(result, result.kind === 'blocked');
      }
      case 'process-reclaim-report': return out(await repository.readProcessReclaimReport({ instanceId: command.instanceId, bootId: command.bootId }, command.policies));
      case 'process-reclaim': {
        const { releaseProcessExitedDispatches } = await import('@/lib/operations/dr/reclaim');
        const result = await releaseProcessExitedDispatches({ owner: { instanceId: command.instanceId, bootId: command.bootId },
          policies: command.policies, operator: command.operator }, command.apply);
        return out(result, result.rows.some(row => !row.released));
      }
      case 'release-drained': {
        const { releaseDrainedDispatches } = await import('@/lib/operations/dr/reclaim');
        const result = await releaseDrainedDispatches(command, command.apply);
        return out(result, result.rows.some(row => !row.released));
      }
      default: return fail('dr_cli_unknown_command');
    }
  } finally {
    await (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void promotionCliMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    // 고정 code만 출력한다. URL/SQL/stack은 쓰지 않는다.
    const message = error instanceof Error && /^[a-z][a-z0-9_:]{2,120}$/.test(error.message) ? error.message : 'dr_promotion_cli_failed';
    process.stderr.write(`${JSON.stringify({ code: message })}\n`); process.exitCode = 1;
  });
}
