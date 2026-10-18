import { eq } from "drizzle-orm";
import { appJwt } from "@/lib/github/app-jwt";
import { db } from "@/lib/db";
import { githubCollectorApps, operationsAudit } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { seal, unseal } from "@/lib/operations/credential-vault";
import { collectorScope, collectorSecret, parseCoreQuota, type CoreQuota } from "./github-secret";

export { appJwt } from "@/lib/github/app-jwt";

/**
 * GitHub App 수집 자격(0064) — 개인 토큰은 계정마다 한도가 하나라 같은 계정의 토큰을 더해도 한도가 늘지 않는다.
 * App 은 설치(installation)마다 따로 한도가 있어 같은 계정에서도 한도를 더할 수 있다(2026-10-10 운영자 결정).
 *
 * 워커는 App 개인 키로 10분짜리 JWT 를 서명해 한 시간짜리 설치 토큰을 받고, 끝나기 5분 전까지 그 토큰을 프로세스 안에 들고 쓴다.
 * 공개 저장소를 읽는 데는 App 권한이 따로 필요 없다(기본 Metadata 읽기). 개인 키는 수집 비밀키로 암호화해 둔다 — 원문은 어디에도 남기지 않는다.
 */
const API_ORIGIN = "https://api.github.com";
const HEADERS = { Accept: "application/vnd.github+json", "user-agent": "NoMoreVibe/1.0" };
/** 설치 토큰을 이만큼 남았을 때 새로 받는다 */
const REFRESH_BEFORE_MS = 5 * 60_000;
/** 받기에 실패한 설치는 이만큼 쉬었다가 다시 받는다 — 요청마다 실패하며 GitHub 를 두드리지 않게 */
const FAILURE_BACKOFF_MS = 5 * 60_000;
/** 허용 목록의 설치가 꺼져 있다는 경보는 이 간격에 한 번 — 요청마다 불리므로 */
const SCOPE_ALERT_INTERVAL_MS = 60_000;

export type AppIdentity = { appId: number; appSlug: string; installationId: number; accountLogin: string; core: CoreQuota | null };

async function githubJson<T>(path: string, init: { token: string; method?: "GET" | "POST"; deadlineAt?: number; signal?: AbortSignal }): Promise<{ status: number; body: T | null }> {
  const remainingMs = init.deadlineAt === undefined ? Infinity : init.deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("github_request_deadline");
  init.signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(10_000, remainingMs)));
  const res = await fetch(`${API_ORIGIN}${path}`, { method: init.method ?? "GET", headers: { ...HEADERS, Authorization: `Bearer ${init.token}` },
    redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal, cache: "no-store" });
  if (init.signal?.aborted || (init.deadlineAt !== undefined && init.deadlineAt <= Date.now())) {
    void res.body?.cancel().catch(() => {});
    init.signal?.throwIfAborted();
    throw new Error("github_request_deadline");
  }
  const body = res.ok ? await res.json() as T : null;
  init.signal?.throwIfAborted();
  if (init.deadlineAt !== undefined && init.deadlineAt <= Date.now()) throw new Error("github_request_deadline");
  if (!res.ok) await res.body?.cancel().catch(() => {});
  init.signal?.throwIfAborted();
  if (init.deadlineAt !== undefined && init.deadlineAt <= Date.now()) throw new Error("github_request_deadline");
  return { status: res.status, body };
}

/** 설치 토큰 하나 — App JWT 로 받는다. 실패하면 사유 코드를 던진다(값은 남기지 않는다) */
export async function mintInstallationToken(appId: number, installationId: number, privateKeyPem: string,
  options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<{ token: string; expiresAt: number }> {
  const result = await githubJson<{ token?: unknown; expires_at?: unknown }>(`/app/installations/${installationId}/access_tokens`,
    { token: appJwt(appId, privateKeyPem), method: "POST", deadlineAt: options.deadlineAt, signal: options.signal });
  if (result.status === 401) throw new Error("github_app_invalid");
  if (result.status === 404) throw new Error("github_app_installation_missing");
  const token = result.body?.token;
  const expiresAt = typeof result.body?.expires_at === "string" ? Date.parse(result.body.expires_at) : NaN;
  if (result.status !== 201 || typeof token !== "string" || token.length < 20 || !Number.isFinite(expiresAt)) throw new Error("github_identity_unavailable");
  return { token, expiresAt };
}

/** 등록 전 확인 — App 과 설치가 실제로 있는지, 설치 토큰이 받아지는지, 지금 한도가 얼마인지. 넣은 값은 믿지 않고 GitHub 의 답을 쓴다 */
export async function inspectGitHubApp(appId: number, installationId: number, privateKeyPem: string): Promise<AppIdentity> {
  if (!Number.isSafeInteger(appId) || appId <= 0 || !Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("github_app_invalid");
  let jwt: string;
  try { jwt = appJwt(appId, privateKeyPem); } catch { throw new Error("github_app_key_invalid"); }
  try {
    const app = await githubJson<{ id?: unknown; slug?: unknown }>("/app", { token: jwt });
    if (app.status === 401) throw new Error("github_app_invalid");
    if (app.status !== 200 || app.body?.id !== appId || typeof app.body?.slug !== "string") throw new Error("github_identity_unavailable");
    const installation = await githubJson<{ id?: unknown; account?: { login?: unknown } }>(`/app/installations/${installationId}`, { token: jwt });
    if (installation.status === 404) throw new Error("github_app_installation_missing");
    const login = installation.body?.account?.login;
    if (installation.status !== 200 || installation.body?.id !== installationId || typeof login !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(login)) {
      throw new Error("github_identity_unavailable");
    }
    const { token } = await mintInstallationToken(appId, installationId, privateKeyPem);
    const rate = await githubJson<{ resources?: { core?: unknown } }>("/rate_limit", { token });
    return { appId, appSlug: app.body.slug.slice(0, 100), installationId, accountLogin: login, core: parseCoreQuota(rate.body?.resources?.core) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("github_")) throw error;
    throw new Error("github_identity_unavailable");
  }
}

/** 같은 설치는 바꿔 끼운다(개인 키 교체) — 작업 로그(지울 수 없다)에 누가·어느 설치를 남긴다 */
export async function saveGitHubCollectorApp(input: { appId: number; installationId: number; privateKeyPem: string }, actor: string): Promise<AppIdentity> {
  const secret = collectorSecret();
  const identity = await inspectGitHubApp(input.appId, input.installationId, input.privateKeyPem);
  const encryptedPrivateKey = seal(input.privateKeyPem, secret);
  await db.transaction(async (tx) => {
    const values = { appId: identity.appId, appSlug: identity.appSlug, accountLogin: identity.accountLogin, encryptedPrivateKey, enabled: true,
      coreQuota: identity.core, quotaObservedAt: new Date(), updatedAt: new Date() };
    await tx.insert(githubCollectorApps).values({ installationId: identity.installationId, ...values })
      .onConflictDoUpdate({ target: githubCollectorApps.installationId, set: values });
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "github-collector-app-save", target: String(identity.installationId),
      detail: { appId: identity.appId, appSlug: identity.appSlug, accountLogin: identity.accountLogin } }));
  });
  cache.delete(identity.installationId);
  return identity;
}

export async function setGitHubCollectorAppEnabled(installationId: number, enabled: boolean, actor: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx.update(githubCollectorApps).set({ enabled, updatedAt: new Date() })
      .where(eq(githubCollectorApps.installationId, installationId)).returning({ installationId: githubCollectorApps.installationId });
    if (!changed.length) return false;
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: enabled ? "github-collector-app-enable" : "github-collector-app-disable", target: String(installationId) }));
    return true;
  });
}

export async function listGitHubCollectorApps() {
  return db.select({ installationId: githubCollectorApps.installationId, appId: githubCollectorApps.appId, appSlug: githubCollectorApps.appSlug,
    accountLogin: githubCollectorApps.accountLogin, enabled: githubCollectorApps.enabled, coreQuota: githubCollectorApps.coreQuota,
    quotaObservedAt: githubCollectorApps.quotaObservedAt, updatedAt: githubCollectorApps.updatedAt })
    .from(githubCollectorApps).orderBy(githubCollectorApps.installationId);
}

/** 프로세스 안의 설치 토큰 — 설치마다 하나. failedUntil 이면 그때까지 받지 않는다 */
const cache = new Map<number, { token: string; expiresAt: number } | { failedUntil: number }>();
let scopeAlertAt = 0;

/**
 * 켜 둔 App 마다 쓸 수 있는 설치 토큰 — github-accounts.ts collectorTokens 가 개인 토큰 뒤에 붙인다. 받지 못한 설치는 빼고 돌려준다.
 * 이 서버의 설치 허용·제외 목록(collectorScope)이 있으면 그 안의 설치만 받는다 — 밖의 설치는 토큰도 만들지 않는다.
 */
export async function appCollectorTokens(secret: string, now = Date.now(), options: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<{ token: string; installationId: number; login: string }[]> {
  if (options.signal?.aborted || (options.deadlineAt !== undefined && options.deadlineAt <= Date.now())) return [];
  const scope = collectorScope();
  // Optional token minting must leave time for the caller's GraphQL dispatch.
  const mintDeadline = options.deadlineAt === undefined ? undefined : options.deadlineAt - 5_000;
  const enabled = await db.select({ installationId: githubCollectorApps.installationId, appId: githubCollectorApps.appId, appSlug: githubCollectorApps.appSlug,
    encryptedPrivateKey: githubCollectorApps.encryptedPrivateKey }).from(githubCollectorApps).where(eq(githubCollectorApps.enabled, true));
  if (options.signal?.aborted || (options.deadlineAt !== undefined && options.deadlineAt <= Date.now())) return [];
  const rows = enabled.filter(row => (!scope?.onlyInstallations || scope.onlyInstallations.includes(row.installationId))
    && !scope?.excludedInstallations?.includes(row.installationId));
  // 허용 목록에 넣었는데 켜져 있지 않은(등록 안 됐거나 '수집에서 제외'한) 설치는 조용히 빠지지 않게 남긴다
  const missing = scope?.onlyInstallations?.filter(id => !rows.some(row => row.installationId === id)) ?? [];
  if (missing.length > 0 && now - scopeAlertAt >= SCOPE_ALERT_INTERVAL_MS) {
    scopeAlertAt = now;
    (rows.length === 0 ? logger.error : logger.warn)("github.app_scope_installation_disabled", { installationIds: missing, usable: rows.length });
  }
  const tokens: { token: string; installationId: number; login: string }[] = [];
  for (const row of rows) {
    if (options.signal?.aborted || (options.deadlineAt !== undefined && options.deadlineAt <= Date.now())) break;
    const cached = cache.get(row.installationId);
    if (cached && "failedUntil" in cached && cached.failedUntil > now) continue;
    if (cached && "token" in cached && cached.expiresAt - REFRESH_BEFORE_MS > now) {
      tokens.push({ token: cached.token, installationId: row.installationId, login: `${row.appSlug} (앱)` });
      continue;
    }
    if (mintDeadline !== undefined && mintDeadline <= Date.now()) continue;
    try {
      const minted = await mintInstallationToken(row.appId, row.installationId, unseal(row.encryptedPrivateKey, secret),
        mintDeadline === undefined ? options : { ...options, deadlineAt: mintDeadline });
      if (options.signal?.aborted || (options.deadlineAt !== undefined && options.deadlineAt <= Date.now())) break;
      cache.set(row.installationId, minted);
      tokens.push({ token: minted.token, installationId: row.installationId, login: `${row.appSlug} (앱)` });
    } catch (error) {
      // A caller's exhausted collection budget is not a broken shared credential.
      if (options.signal?.aborted || (options.deadlineAt !== undefined && options.deadlineAt <= Date.now())) break;
      if (mintDeadline !== undefined && error instanceof Error && (error.message === "github_request_deadline"
        || mintDeadline <= Date.now() && (error.name === "TimeoutError" || error.name === "AbortError"))) continue;
      cache.set(row.installationId, { failedUntil: now + FAILURE_BACKOFF_MS });
      // 5분 쉬는 동안 이 설치 몫이 빠진다 — 사유 코드만 남긴다(키·토큰·응답 원문은 남기지 않는다)
      logger.warn("github.app_token_unavailable", { installationId: row.installationId,
        reason: error instanceof Error && error.message.startsWith("github_") ? error.message : error instanceof Error ? error.name : "unknown",
        retryAt: new Date(now + FAILURE_BACKOFF_MS).toISOString() });
    }
  }
  return tokens;
}

/** 테스트용 — 프로세스 안의 설치 토큰을 비운다 */
export function clearAppTokenCache() { cache.clear(); scopeAlertAt = 0; }
