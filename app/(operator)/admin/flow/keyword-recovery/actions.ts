"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from "@/lib/auth/admin";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { retryExhaustedKeywordGeneration } from "@/lib/operations/keyword-generation-recovery";
import { KEYWORD_GENERATION_RECOVERY_HREF } from "@/lib/operations/stage-panel-catalog";
import { assertJobControlCsrf } from "../../status/job-control-csrf";

export const retryKeywordGenerationAction = webWriteAction(async function retryKeywordGenerationAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) redirect("/admin/login");
  try {
    assertJobControlCsrf({ admin, secret: authSecret(), configuredOrigin: adminOrigin(), origin: (await headers()).get("origin"),
      token: form.get("csrfToken"), expiresAt: Number(form.get("csrfExpiresAt")),
      local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  } catch {
    redirect(`${KEYWORD_GENERATION_RECOVERY_HREF}?result=invalid`);
  }
  const productId = form.get("productId"), revision = form.get("sourceRevision");
  if (typeof productId !== "string" || !/^[1-9]\d{0,9}$/.test(productId) || Number(productId) > 2_147_483_647
    || typeof revision !== "string" || !/^\d{1,10}$/.test(revision) || Number(revision) > 2_147_483_647) {
    redirect(`${KEYWORD_GENERATION_RECOVERY_HREF}?result=invalid`);
  }
  const queued = await retryExhaustedKeywordGeneration({ productId: Number(productId), sourceRevision: Number(revision) }, admin.login);
  redirect(`${KEYWORD_GENERATION_RECOVERY_HREF}?result=${queued ? "queued" : "stale"}`);
});
