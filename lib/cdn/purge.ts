/**
 * CDN 캐시 지우기 — 내려간 제품의 상세(모든 `?_rsc=` 갈래)·썸네일·목록 화면을 태그로 지운다.
 *
 * 태그는 원 서버가 붙인다(next.config.ts 의 html·lists·p-<slug>, 썸네일의 og-<slug>). 주소로 지우면
 * 화면 이동용 사본의 `_rsc` 주소를 알 수 없어 남는다.
 * - Cloudflare: 태그 지우기는 Free 요금제에서 계정 전체 분당 5회라 한 요청에 모아 보낸다(요청 하나에 태그 100개까지).
 * - CloudFront(2026-10-07 서울 거점 앞단): 태그 무효화(`#<tag>`), 태그 하나가 경로 하나 — 월 1,000개까지 무료.
 * 옮기는 동안과 되돌릴 때를 위해 설정된 곳은 모두 지운다.
 */
import { CloudFrontClient, CreateInvalidationCommand } from "@aws-sdk/client-cloudfront";

const API = "https://api.cloudflare.com/client/v4";
/** 제품마다 태그 둘(p-, og-)에 목록 태그 하나 — 100개 안에 든다 */
export const PURGE_BATCH = 45;

export type PurgeConfig = { zoneId: string; token: string };
export type PurgeResult = { ok: true } | { ok: false; status: number; error: string };
export type PurgeTarget = { name: string; purge: (tags: string[]) => Promise<PurgeResult> };

/** 토큰은 지우기 권한 하나만 가진 것을 발행 워커 환경변수로만 받는다 */
export function purgeConfig(env: Record<string, string | undefined> = process.env): PurgeConfig | null {
  const zoneId = env.CLOUDFLARE_ZONE_ID?.trim();
  const token = env.CLOUDFLARE_PURGE_TOKEN?.trim();
  return zoneId && token ? { zoneId, token } : null;
}

export function purgeTags(slugs: string[]): string[] {
  return [...new Set(slugs.flatMap((slug) => [`p-${slug}`, `og-${slug}`])), "lists"];
}

export async function purgeByTags(config: PurgeConfig, tags: string[], fetchImpl: typeof fetch = fetch): Promise<PurgeResult> {
  try {
    const response = await fetchImpl(`${API}/zones/${config.zoneId}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null) as { success?: boolean; errors?: { message?: string }[] } | null;
    if (response.ok && body?.success) return { ok: true };
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ") || `http ${response.status}`;
    return { ok: false, status: response.status, error: message.slice(0, 300) };
  } catch (error) {
    return { ok: false, status: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

type InvalidationClient = Pick<CloudFrontClient, "send">;

/** CloudFront 태그 무효화 — 무효화 권한 하나만 가진 IAM 키(AWS_ACCESS_KEY_ID·AWS_SECRET_ACCESS_KEY)를 SDK 가 환경변수에서 읽는다 */
export async function invalidateCloudFront(distributionId: string, tags: string[], client: InvalidationClient): Promise<PurgeResult> {
  try {
    await client.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: {
        CallerReference: `nmv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        Paths: { Quantity: tags.length, Items: tags.map((tag) => `#${tag}`) },
      },
    }));
    return { ok: true };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
    return { ok: false, status, error: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300) };
  }
}

/** 설정된 지우기 대상 — 없으면 빈 목록(지울 목록에 쌓아만 둔다) */
export function purgeTargets(
  env: Record<string, string | undefined> = process.env,
  deps: { fetch?: typeof fetch; cloudfront?: InvalidationClient } = {},
): PurgeTarget[] {
  const targets: PurgeTarget[] = [];
  const cloudflare = purgeConfig(env);
  if (cloudflare) targets.push({ name: "cloudflare", purge: (tags) => purgeByTags(cloudflare, tags, deps.fetch) });
  const distributionId = env.CLOUDFRONT_DISTRIBUTION_ID?.trim();
  if (distributionId && (deps.cloudfront || (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY))) {
    const client = deps.cloudfront ?? new CloudFrontClient({ region: "us-east-1", maxAttempts: 2 });
    targets.push({ name: "cloudfront", purge: (tags) => invalidateCloudFront(distributionId, tags, client) });
  }
  return targets;
}
