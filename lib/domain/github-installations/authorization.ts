import { githubRequest } from "@/lib/github/client";
import { githubRepositoryPath, isGithubNumericId, parseGithubRepository, parseGithubRepositoryResponse, type GithubRepository } from "@/lib/github/repositories";
import { feedbackAppConfig, GithubInstallationError, requireEligibleFeedbackRepository, verifyFeedbackInstallation } from "./credentials";
import { requirePublicAuthEnabled } from "@/lib/domain/accounts/request-auth";
import { productFeedbackEnabled } from "@/lib/domain/github-integration/flags";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { githubMakerAuthContexts, githubProductBindings } from "@/lib/db/github-binding-schema";
import { authorizeMaker } from "@/lib/domain/products/maker-auth";
import { consumeGithubAuthFlow, createGithubAuthFlow } from "@/lib/domain/github-user/repository";
import { hashSessionToken, isOpaqueToken } from "@/lib/domain/accounts/session";
import { completeProductGithubBinding, expireMakerGithubAuthorizations, failMakerGithubAuthorization, getProductGithubBinding } from "./bindings";
import { githubAuthFlows } from "@/lib/db/github-user-schema";
import { decryptGithubSecret, encryptGithubSecret, exchangeGithubAppCode } from "@/lib/domain/github-user/credentials";
import { randomBytes } from "node:crypto";

export function requireMakerGithubEnabled(): void {
  requirePublicAuthEnabled();
  if (!productFeedbackEnabled()) throw new GithubInstallationError(404, "github_feedback_disabled");
}

export async function startMakerGithubAuthorization(input: { actorUserId: number; slug: string; editToken: string; deliveryConsent: boolean; sessionTokenHash: string }): Promise<{ authorizeUrl: string; browserNonce: string }> {
  requireMakerGithubEnabled();
  if (input.deliveryConsent !== true) throw new GithubInstallationError(400, "github_feedback_consent_required");
  if (!isGithubNumericId(input.actorUserId) || !/^[a-f0-9]{64}$/.test(input.sessionTokenHash)) throw new GithubInstallationError(400, "github_invalid_request");
  const config = feedbackOAuthConfig();
  feedbackAppConfig();
  const product = await requireMakerEditPermission(input.slug, input.editToken);
  const parsed = parseGithubRepository(product.repoUrl ?? "");
  if (!parsed) throw new GithubInstallationError(409, "github_repository_invalid");
  const previous = await getProductGithubBinding(product.id);
  const expectedId = previous?.productRepoUrl === product.repoUrl ? previous.repositoryId : undefined;
  const metadata = await githubRequest<unknown>({ auth: "public", path: expectedId === undefined ? githubRepositoryPath(parsed) : `/repositories/${expectedId}` });
  if (metadata.outcome !== "confirmed_success") throw new GithubInstallationError(409, "github_repository_unavailable");
  const repository = requireEligibleFeedbackRepository(parseGithubRepositoryResponse(metadata.data, expectedId));
  const flow = await onPrimary(() => db.transaction(async tx => {
    const [current] = await tx.select().from(products).where(eq(products.id, product.id)).for("update");
    const [binding] = await tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, product.id)).for("update");
    if (!current || current.status === "banned" || current.repoUrl !== product.repoUrl || current.editTokenHash !== product.editTokenHash) throw new GithubInstallationError(409, "github_maker_authorization_changed");
    if ((binding?.revision ?? 0) !== (previous?.revision ?? 0)) throw new GithubInstallationError(409, "github_binding_revision_conflict");
    const flow = await createGithubAuthFlow({ purpose: "maker", actorUserId: input.actorUserId, productId: product.id, returnTo: `/p/${product.slug}/github` }, tx);
    await tx.insert(githubMakerAuthContexts).values({ flowId: flow.id, actorUserId: input.actorUserId, productId: product.id, repositoryId: repository.id, productRepoUrl: current.repoUrl!, editTokenHash: current.editTokenHash!, expectedRevision: binding?.revision ?? 0, browserNonceHash: hashSessionToken(flow.browserNonce), sessionTokenHash: input.sessionTokenHash, expiresAt: flow.expiresAt });
    return flow;
  }));
  const url = new URL("https://github.com/login/oauth/authorize");
  for (const [key, value] of Object.entries({ client_id: config.clientId, redirect_uri: config.callbackUrl, scope: "offline_access", state: flow.state, code_challenge: flow.codeChallenge, code_challenge_method: "S256" })) url.searchParams.set(key, value);
  return { authorizeUrl: url.toString(), browserNonce: flow.browserNonce };
}

export function feedbackOAuthConfig() {
  const clientId = process.env.GITHUB_FEEDBACK_APP_CLIENT_ID, clientSecret = process.env.GITHUB_FEEDBACK_APP_CLIENT_SECRET;
  try {
    if (!clientId || !clientSecret || clientId.length > 512 || clientSecret.length > 512 || /\s/.test(clientId + clientSecret)) throw new Error();
    const site = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    if (!["http:", "https:"].includes(site.protocol) || site.username || site.password) throw new Error();
    return { clientId, clientSecret, origin: site.origin, callbackUrl: `${site.origin}/api/auth/maker/github/callback` };
  } catch { throw new GithubInstallationError(503, "github_feedback_unconfigured"); }
}

export async function requireMakerEditPermission(slug: string, editToken: string | null | undefined) {
  if (!editToken || editToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(editToken)) throw new GithubInstallationError(401, "maker_edit_token_required");
  const result = await onPrimary(() => authorizeMaker(slug, { editToken }));
  if (!result.ok) throw new GithubInstallationError(result.error.kind === "not_found" ? 404 : 403, "maker_edit_token_invalid");
  return result.value;
}

type MakerCallbackInput = { state: string; browserNonce: string; actorUserId: number; sessionTokenHash: string };
type MakerContext = typeof githubMakerAuthContexts.$inferSelect;
function validateCallbackInput(input: MakerCallbackInput) {
  if (!isOpaqueToken(input.state) || !isOpaqueToken(input.browserNonce) || !isGithubNumericId(input.actorUserId) || !/^[a-f0-9]{64}$/.test(input.sessionTokenHash)) throw new GithubInstallationError(400, "invalid_github_flow");
}
async function currentContextProduct(context: MakerContext) {
  const [product] = await onPrimary(() => db.select().from(products).where(eq(products.id, context.productId)));
  if (!product || product.status === "banned" || product.repoUrl !== context.productRepoUrl || product.editTokenHash !== context.editTokenHash) throw new GithubInstallationError(409, "github_maker_authorization_changed");
  return product;
}

export async function finishMakerGithubAuthorization(input: MakerCallbackInput & { code: string; declined?: boolean }): Promise<{ installUrl: string; slug: string }> {
  requireMakerGithubEnabled();
  validateCallbackInput(input);
  if (!input.declined && (!input.code || input.code.length > 512 || /[\s\u0000-\u001f\u007f]/.test(input.code))) throw new GithubInstallationError(400, "invalid_github_code");
  const config = feedbackOAuthConfig(), app = feedbackAppConfig();
  await expireMakerGithubAuthorizations();
  const claimed = await onPrimary(() => db.transaction(async tx => {
    const [selected] = await tx.select({ context: githubMakerAuthContexts }).from(githubMakerAuthContexts).innerJoin(githubAuthFlows, eq(githubAuthFlows.id, githubMakerAuthContexts.flowId)).where(and(
      eq(githubAuthFlows.stateHash, hashSessionToken(input.state)), eq(githubAuthFlows.purpose, "maker"), eq(githubMakerAuthContexts.actorUserId, input.actorUserId),
      eq(githubMakerAuthContexts.browserNonceHash, hashSessionToken(input.browserNonce)), eq(githubMakerAuthContexts.sessionTokenHash, input.sessionTokenHash), eq(githubMakerAuthContexts.state, "authorizing"), gt(githubMakerAuthContexts.expiresAt, sql`clock_timestamp()`)));
    if (!selected) throw new GithubInstallationError(400, "invalid_github_flow");
    const flow = await consumeGithubAuthFlow({ ...input, purpose: "maker" }, tx);
    if (flow.productId !== selected.context.productId) throw new GithubInstallationError(400, "invalid_github_flow");
    const [context] = await tx.update(githubMakerAuthContexts).set({ state: "verifying" }).where(and(eq(githubMakerAuthContexts.flowId, flow.id), eq(githubMakerAuthContexts.state, "authorizing"))).returning();
    if (!context) throw new GithubInstallationError(400, "invalid_github_flow");
    return { context, verifier: flow.pkceVerifier };
  }));
  try {
    if (input.declined) throw new GithubInstallationError(400, "github_authorization_declined");
    const product = await currentContextProduct(claimed.context);
    const exchange = await exchangeGithubAppCode({ code: input.code, verifier: claimed.verifier, ...config });
    if (exchange.outcome !== "confirmed_success") throw new GithubInstallationError(400, "github_authorization_failed");
    await verifyMakerGithubRepository(exchange.tokens.accessToken, claimed.context.productRepoUrl, claimed.context.repositoryId);
    const identity = await githubRequest<{ id?: unknown }>({ path: "/user", token: exchange.tokens.accessToken, auth: "user" });
    if (identity.outcome !== "confirmed_success" || !isGithubNumericId(identity.data?.id)) throw new GithubInstallationError(409, "github_user_identity_invalid");
    const githubUserId = identity.data.id;
    const setupState = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Math.min(claimed.context.expiresAt.getTime(), exchange.tokens.accessExpiresAt.getTime()));
    const changed = await onPrimary(() => db.update(githubMakerAuthContexts).set({ state: "awaiting_setup", githubUserId, encryptedUserToken: encryptGithubSecret(exchange.tokens.accessToken), setupStateHash: hashSessionToken(setupState), expiresAt }).where(and(eq(githubMakerAuthContexts.flowId, claimed.context.flowId), eq(githubMakerAuthContexts.state, "verifying"), gt(githubMakerAuthContexts.expiresAt, sql`clock_timestamp()`))).returning({ id: githubMakerAuthContexts.flowId }));
    if (changed.length !== 1) throw new GithubInstallationError(400, "invalid_github_flow");
    const url = new URL(`https://github.com/apps/${app.slug}/installations/new`);
    url.searchParams.set("state", setupState);
    return { installUrl: url.toString(), slug: product.slug };
  } catch (error) { await failMakerGithubAuthorization(claimed.context.flowId); throw error; }
}

export async function completeMakerGithubInstallation(input: MakerCallbackInput & { installationId?: number; setupAction?: string }) {
  requireMakerGithubEnabled();
  validateCallbackInput(input);
  await expireMakerGithubAuthorizations();
  const [context] = await onPrimary(() => db.update(githubMakerAuthContexts).set({ state: "verifying", setupStateHash: null }).where(and(
    eq(githubMakerAuthContexts.setupStateHash, hashSessionToken(input.state)), eq(githubMakerAuthContexts.actorUserId, input.actorUserId), eq(githubMakerAuthContexts.browserNonceHash, hashSessionToken(input.browserNonce)),
    eq(githubMakerAuthContexts.sessionTokenHash, input.sessionTokenHash), eq(githubMakerAuthContexts.state, "awaiting_setup"), gt(githubMakerAuthContexts.expiresAt, sql`clock_timestamp()`))).returning());
  if (!context) throw new GithubInstallationError(400, "invalid_github_flow");
  try {
    if (input.setupAction === "request") {
      await failMakerGithubAuthorization(context.flowId);
      const [product] = await onPrimary(() => db.select({ slug: products.slug }).from(products).where(eq(products.id, context.productId)));
      if (!product) throw new GithubInstallationError(404, "product_not_found");
      return { status: "pending" as const, slug: product.slug };
    }
    if (input.setupAction !== undefined && !["install", "update"].includes(input.setupAction)) throw new GithubInstallationError(400, "github_invalid_request");
    if (!isGithubNumericId(input.installationId) || !context.encryptedUserToken) throw new GithubInstallationError(400, "github_invalid_request");
    const product = await currentContextProduct(context);
    const token = decryptGithubSecret(context.encryptedUserToken);
    await verifyMakerGithubRepository(token, context.productRepoUrl, context.repositoryId);
    await verifyMakerInstallationAccess(token, input.installationId, context.repositoryId);
    const verified = await verifyFeedbackInstallation({ installationId: input.installationId, repositoryId: context.repositoryId });
    const binding = await completeProductGithubBinding({ flowId: context.flowId, actorUserId: input.actorUserId, installationId: input.installationId, repository: verified.repository });
    return { status: "connected" as const, binding, slug: product.slug };
  } catch (error) { await failMakerGithubAuthorization(context.flowId); throw error; }
}
export async function verifyMakerGithubRepository(token: string, repositoryUrl: string, expectedId?: number): Promise<GithubRepository> {
  const parsed = parseGithubRepository(repositoryUrl);
  if (!parsed || (expectedId !== undefined && !isGithubNumericId(expectedId))) throw new GithubInstallationError(400, "github_repository_invalid");
  const result = await githubRequest<unknown>({ path: expectedId === undefined ? githubRepositoryPath(parsed) : `/repositories/${expectedId}`, token });
  if (result.outcome !== "confirmed_success") throw new GithubInstallationError(409, "github_repository_unavailable");
  const repository = requireEligibleFeedbackRepository(parseGithubRepositoryResponse(result.data, expectedId));
  if (!repository.permissions?.admin) throw new GithubInstallationError(403, "github_repository_admin_required");
  return repository;
}

async function findOnPages(token: string, path: string, key: "installations" | "repositories", predicate: (value: Record<string, unknown>) => boolean): Promise<boolean> {
  for (let page = 1; page <= 20; page++) {
    const result = await githubRequest<Record<string, unknown>>({ path: `${path}?per_page=100&page=${page}`, token });
    if (result.outcome !== "confirmed_success" || !result.data || !Array.isArray(result.data[key])) throw new GithubInstallationError(503, "github_installation_unknown");
    const entries = result.data[key] as unknown[];
    if (entries.some(value => !!value && typeof value === "object" && !Array.isArray(value) && predicate(value as Record<string, unknown>))) return true;
    const total = result.data.total_count;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new GithubInstallationError(503, "github_installation_unknown");
    if (page * 100 >= total) return false;
    if (entries.length !== 100) throw new GithubInstallationError(503, "github_installation_unknown");
  }
  throw new GithubInstallationError(503, "github_installation_unknown");
}

export async function verifyMakerInstallationAccess(token: string, installationId: number, repositoryId: number): Promise<void> {
  if (!isGithubNumericId(installationId) || !isGithubNumericId(repositoryId)) throw new GithubInstallationError(400, "github_invalid_request");
  const config = feedbackAppConfig();
  if (!await findOnPages(token, "/user/installations", "installations", value => value.id === installationId && value.app_id === config.id)) {
    throw new GithubInstallationError(403, "github_installation_access_denied");
  }
  if (!await findOnPages(token, `/user/installations/${installationId}/repositories`, "repositories", value => value.id === repositoryId)) {
    throw new GithubInstallationError(403, "github_installation_repository_missing");
  }
}
