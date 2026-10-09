/**
 * AI 제작 근거 단계 판정을 운영 DB 에 쓰지 않고 돌려 본다 — 잡(ai-level-refresh.ts)과 같은 판정 코드(processBatch).
 *
 *   tsx scripts/ai-level-check.ts --keys=keys.txt --scanned=scanned.json --out=result.jsonl
 *
 * keys.txt: 한 줄에 owner/name 하나. scanned.json: { "owner/name": AgentObservation[] } — 운영 DB 에서 읽기 전용으로 내보낸
 * 기존 근거 수집의 마지막 루트 조사(없으면 {}). DATABASE_URL 은 GitHub 대기 시각을 적을 로컬 DB 를, GITHUB_TOKEN 은 읽기용 토큰을 준다.
 * 지난 판정 없이 처음부터 판정한다. 결과는 한 줄에 저장소 하나(JSON).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { githubGraphql, githubRequest } from "@/lib/crawl/github";
import { agentObservationSchema } from "@/lib/domain/evidence/agents/types";
import { scanEvidence } from "@/lib/domain/evidence/ai-level";
import { AI_LEVEL_BATCH } from "@/lib/domain/evidence/ai-level-query";
import { processBatch, type AiLevelTick } from "@/lib/jobs/products/ai-level-refresh";

async function main() {
  const { values } = parseArgs({ options: { keys: { type: "string" }, scanned: { type: "string" }, out: { type: "string" }, rest: { type: "string" } } });
  if (!values.keys || !values.out) throw new Error("--keys 와 --out 이 필요합니다");
  const keys = readFileSync(values.keys, "utf8").split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean);
  const raw: Record<string, unknown[]> = values.scanned ? JSON.parse(readFileSync(values.scanned, "utf8")) : {};
  const scanned = new Map(Object.entries(raw).map(([key, list]) => [key.toLowerCase(),
    scanEvidence(list.flatMap((item) => { const parsed = agentObservationSchema.safeParse(item); return parsed.success ? [parsed.data] : []; }))]));
  const tick: AiLevelTick = {
    graphql: githubGraphql, request: githubRequest, restLeft: Number(values.rest ?? 3000),
    load: { previous: async () => new Map(), scanned: async (batch) => new Map(batch.flatMap((key) => scanned.has(key) ? [[key, scanned.get(key)!]] : [])) },
  };
  for (let start = 0; start < keys.length; start += AI_LEVEL_BATCH) {
    const result = await processBatch(tick, keys.slice(start, start + AI_LEVEL_BATCH));
    for (const item of result.judged) appendFileSync(values.out, JSON.stringify({ ...item, scanned: scanned.get(item.key) ?? null }) + "\n");
    for (const item of result.failed) appendFileSync(values.out, JSON.stringify(item) + "\n");
    if (result.rateLimitedUntil) throw new Error(`GitHub 한도 — ${result.rateLimitedUntil} 뒤에 이어서`);
    if ((start / AI_LEVEL_BATCH) % 10 === 0) console.log(`${Math.min(start + AI_LEVEL_BATCH, keys.length)}/${keys.length} · REST 남음 ${tick.restLeft}`);
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
