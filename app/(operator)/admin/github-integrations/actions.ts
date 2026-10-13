"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from "@/lib/auth/admin";
import { requestGithubIntegrationRequery, requestGithubIntegrationRetransmit } from "@/lib/domain/github-webhooks/admin";
import { assertAdminRecoveryCsrf } from "@/lib/domain/github-webhooks/admin-auth";

function field(form: FormData, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") throw new Error("github_recovery_invalid");
  return values[0];
}
async function authorized(form: FormData) {
  const admin = await currentAdmin();
  if (!admin) throw new Error("unauthorized");
  const configuredOrigin = adminOrigin();
  assertAdminRecoveryCsrf({ admin, secret: authSecret(), origin: (await headers()).get("origin"), configuredOrigin, token: field(form, "csrfToken"), expiresAt: Number(field(form, "csrfExpiresAt")), local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  return { requestId: field(form, "requestId"), outboxId: field(form, "outboxId"), expectedDispatchId: field(form, "expectedDispatchId"), reason: field(form, "reason"), adminLogin: admin.login };
}
export async function requeryGithubIntegrationAction(form: FormData): Promise<void> {
  await requestGithubIntegrationRequery(await authorized(form));
  revalidatePath("/admin/github-integrations");
}
export async function retransmitGithubIntegrationAction(form: FormData): Promise<void> {
  await requestGithubIntegrationRetransmit({ ...await authorized(form), expectedBindingRevision: Number(field(form, "expectedBindingRevision")), expectedPayloadHash: field(form, "expectedPayloadHash"), duplicateRiskAcknowledged: form.getAll("duplicateRiskAcknowledged").length === 1 && form.get("duplicateRiskAcknowledged") === "yes" });
  revalidatePath("/admin/github-integrations");
}
