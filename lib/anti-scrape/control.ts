import { eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { runtimeSettings } from "@/lib/db/operations-schema";
import { resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { logger } from "@/lib/observability/logger";

/** Both web apps read the existing shared settings row; no deployment or new env switch needed. */
export async function publicApiMode(): Promise<"observe" | "enforce"> {
  try {
    const [row] = await onPrimary(() => db.select({ values: runtimeSettings.values }).from(runtimeSettings).where(eq(runtimeSettings.id, 1)));
    return resolveRuntimeSettings(row?.values ?? {}).settings.publicApi.mode;
  } catch {
    logger.warn("anti_scrape.session_control_unavailable");
    throw new Error("session_control_unavailable");
  }
}
