/** Child process for tests/integration/agent-scan-consumer.test.ts. It runs as the Oracle agent-scan principal only (DATABASE_URL):
 * the consumer preflight, one claim abandoned with a retry backoff, then the real consumer loop through the real GitHub client
 * (App-only credentials) against a stubbed api.github.com, and finally each negative statement. Nothing leaves the process. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { abandonAgentRepositoryClaim, claimAgentRepository } from '@/lib/domain/evidence/agents/claims';
import { runAgentScanConsumer } from '@/lib/domain/evidence/agents/consumer';
import { readOracleConsumerPreflight } from '@/lib/runtime/oracle-consumer-preflight';

type Input = { installationId: number; repositories: Record<string, number>; negatives: string[] };
const input = JSON.parse(process.env.AGENT_SCAN_DRIVER_INPUT ?? '{}') as Input;
const failure = (error: unknown) => {
  for (let value = error, depth = 0; value && depth < 8; depth++) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    value = (value as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
};
const HEAD = 'a'.repeat(40), TREE = 'b'.repeat(40);
const paths: string[] = [];
/** api.github.com 대역. 설치 토큰 발급과 저장소 세 요청(메타·기본 가지·트리)만 답한다. 트리 응답이 core 를 다 쓴 것으로 알린다 */
globalThis.fetch = async (url: string | URL | Request) => {
  const { pathname } = new URL(String(url instanceof Request ? url.url : url));
  paths.push(pathname);
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const reply = (body: unknown, status = 200, remaining = 4990) => new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-used': String(5000 - remaining),
    'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' } });
  if (pathname === `/app/installations/${input.installationId}/access_tokens`)
    return reply({ token: `ghs_${'f'.repeat(36)}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
  const repository = Object.keys(input.repositories).find(key => pathname.startsWith(`/repos/${key}`));
  if (!repository) return reply({ message: 'Not Found' }, 404);
  if (pathname === `/repos/${repository}`) return reply({ id: input.repositories[repository], private: false, fork: false, default_branch: 'main' });
  if (pathname === `/repos/${repository}/commits/main`) return reply({ sha: HEAD, commit: { tree: { sha: TREE } } });
  if (pathname === `/repos/${repository}/git/trees/${TREE}`) return reply({ tree: [], truncated: false }, 200, 0);
  return reply({ message: 'Not Found' }, 404);
};

async function main() {
  const result: Record<string, unknown> = { principal: (await db.execute<{ user: string }>(sql`SELECT current_user AS user`))[0].user };
  result.preflight = await readOracleConsumerPreflight({ consumer: 'agent-scan' });
  const owner = { instanceId: process.env.SERVICE_INSTANCE_ID!, bootId: randomUUID() };
  const claim = await claimAgentRepository({ owner });
  result.abandoned = claim.kind === 'claimed'
    ? { repositoryKey: claim.lease.repositoryKey, released: await abandonAgentRepositoryClaim(claim.lease, { retryAfterMs: 15 * 60_000 }) } : claim;
  result.stats = await runAgentScanConsumer({ owner, once: true });
  result.paths = paths;
  const negatives: Record<string, string> = {};
  for (const statement of input.negatives) {
    try { await db.execute(sql.raw(statement)); negatives[statement] = 'allowed'; }
    catch (error) { negatives[statement] = failure(error); }
  }
  result.negatives = negatives;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().then(() => (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }),
  async error => {
    process.stdout.write(`${JSON.stringify({ error: failure(error), message: error instanceof Error ? error.message.slice(0, 300) : String(error) })}\n`);
    await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 });
    process.exitCode = 1;
  });
