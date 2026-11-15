import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { runtimeSettings, operationsAudit } from "@/lib/db/operations-schema";
import { publicApiMode } from "@/lib/anti-scrape/control";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { readRuntimeSettingsRow, saveRuntimeSettings } from "@/lib/operations/runtime-settings";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
afterEach(() => vi.unstubAllEnvs());
describe("두 웹 앱이 공유하는 실시간 세션 정책", () => {
  it("기록 기본값에서 감사·revision을 거쳐 차단/기록으로 바뀌고 재배포 없이 다음 읽기에 반영", async () => {
    const before = await readRuntimeSettingsRow();
    const original = before.values;
    try {
      vi.stubEnv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
      vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
      vi.stubEnv("PUBLIC_API_SESSION_SECRET", "test-only-signing-secret");
      vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
      const request = new Request("https://nomorevibe.test/api/product-cards", { headers: { "user-agent": "Mozilla/5.0 Chrome/131.0 Safari/537.36" } });
      const observe = await saveRuntimeSettings({ publicApi: { mode: "observe" } }, "test:api-session", { group: "publicApi", expectedRevision: before.revision });
      expect(observe.ok).toBe(true); expect(await publicApiMode()).toBe("observe");
      expect(await guardPublicApiRead(request, "products.cards")).toBeNull();
      const row = await readRuntimeSettingsRow();
      const enforce = await saveRuntimeSettings({ publicApi: { mode: "enforce" } }, "test:api-session", { group: "publicApi", expectedRevision: row.revision });
      expect(enforce.ok).toBe(true); expect(await publicApiMode()).toBe("enforce");
      expect((await guardPublicApiRead(request, "products.cards"))?.status).toBe(401);
      const stale = await saveRuntimeSettings({ publicApi: { mode: "observe" } }, "test:api-session", { group: "publicApi", expectedRevision: row.revision });
      expect(stale).toMatchObject({ ok: false, issues: ["stale_form"] });
      const [audit] = await db.select().from(operationsAudit).where(eq(operationsAudit.target, "runtime_settings:publicApi")).orderBy(sql`id desc`).limit(1);
      expect(audit.action).toBe("runtime-settings-save");
    } finally {
      // Restore the exact original sparse document, including the original absence of this new group.
      await db.update(runtimeSettings).set({ values: original as Record<string, unknown> }).where(eq(runtimeSettings.id, 1));
    }
  });
});
