import { getPublicSession, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, readLoginJson, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { GithubInstallationError } from "@/lib/domain/github-installations/credentials";
import { requireMakerEditPermission, requireMakerGithubEnabled } from "@/lib/domain/github-installations/authorization";
import { disableProductGithubBinding, getProductGithubBinding } from "@/lib/domain/github-installations/bindings";
import type { GithubProductBinding } from "@/lib/db/github-binding-schema";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

type Context = { params: Promise<{ slug: string }> };
function view(binding: GithubProductBinding | null) {
  return binding ? { repositoryId: binding.repositoryId, repositoryFullName: binding.repositoryFullName, repositoryUrl: binding.repositoryUrl, installationId: binding.installationId, revision: binding.revision, enabled: binding.enabled, blockedReason: binding.blockedReason, lastVerifiedAt: binding.lastVerifiedAt } : null;
}

export async function GET(request: Request, context: Context) {
  try {
    requireMakerGithubEnabled();
    if (!await getPublicSession(request)) throw new GithubInstallationError(401, "login_required");
    if (new URL(request.url).search) throw new GithubInstallationError(400, "github_invalid_request");
    const { slug } = await context.params;
    const product = await requireMakerEditPermission(slug, request.headers.get("x-edit-token"));
    return Response.json({ binding: view(await getProductGithubBinding(product.id)) }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}

export const PUT = webWriteRoute(async (request: Request, context: Context) => {
  try {
    requireMakerGithubEnabled();
    await requirePublicMutation(request);
    if (new URL(request.url).search) throw new GithubInstallationError(400, "github_invalid_request");
    const { slug } = await context.params;
    const product = await requireMakerEditPermission(slug, request.headers.get("x-edit-token"));
    const input = await readLoginJson(request);
    if (Object.keys(input).some(key => !["enabled", "expectedRevision"].includes(key)) || input.enabled !== false || typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new GithubInstallationError(400, "github_invalid_request");
    return Response.json({ binding: view(await disableProductGithubBinding(product.id, "maker_disabled", input.expectedRevision, { editTokenHash: product.editTokenHash, productRepoUrl: product.repoUrl })) }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return publicAuthErrorResponse(error); }
}, publicAuthErrorResponse);
