import "server-only";
import { headers } from "next/headers";
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from "@/lib/auth/admin";
import { assertAdminRequestCsrf, type RequestScope } from "./admin-requests-csrf";

export async function authorizeAdminRequest(scope: RequestScope, form: FormData): Promise<string> {
  const admin = await currentAdmin();
  if (!admin) throw new Error("unauthorized");
  assertAdminRequestCsrf({ scope, admin, secret: authSecret(), configuredOrigin: adminOrigin(), origin: (await headers()).get("origin"),
    token: form.get("csrfToken"), expiresAt: Number(form.get("csrfExpiresAt")), local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  return admin.login;
}
