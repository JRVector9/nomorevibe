"use server";

import { createHmac, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminLocalLoginEnabled, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from "@/lib/auth/admin";
import { reviewFeedback } from "@/lib/domain/feedback/review";

export async function reviewFeedbackAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) throw new Error("unauthorized");
  const secret = authSecret();
  const origin = (await headers()).get("origin");
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL ? new URL(process.env.NEXT_PUBLIC_SITE_URL).origin : null;
  if (!secret || !configuredOrigin || origin !== configuredOrigin) throw new Error("forbidden");
  const nonce = form.get("csrfToken");
  const expiresAt = Number(form.get("csrfExpiresAt"));
  const now = Math.floor(Date.now() / 1000);
  const local = adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || (local ? expiresAt > now + 12 * 3600 : expiresAt !== admin.exp)) throw new Error("forbidden");
  const expected = createHmac("sha256", secret).update(`feedback-admin:${admin.login}:${expiresAt}`).digest("hex");
  if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) || !timingSafeEqual(Buffer.from(nonce, "hex"), Buffer.from(expected, "hex"))) throw new Error("forbidden");
  const id = form.get("id"), decision = form.get("decision"), reason = form.get("reason");
  if (typeof id !== "string" || (decision !== "accepted" && decision !== "rejected") || typeof reason !== "string") throw new Error("feedback_invalid");
  await reviewFeedback({ id, decision, reason, adminLogin: admin.login });
  revalidatePath("/admin/feedback");
  revalidatePath(`/feedback/${id}`);
}
