import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, textTranslations } from "@/lib/db/schema";
import { multilingualQueryTranslationTarget } from "@/lib/domain/products/search-translation";
import { ensureSchema, resetTables } from "../integration/setup-database";

const japanese = "音声を認識するツール";
const searchPath = `/?q=${encodeURIComponent(japanese)}`;
const cacheKey = multilingualQueryTranslationTarget(japanese)!.cacheKey;

test.beforeAll(async () => {
  ensureSchema();
  await resetTables();
  await db.delete(textTranslations).where(and(eq(textTranslations.sourceHash, cacheKey), eq(textTranslations.targetLang, "en")));
  await db.insert(products).values({
    slug: "speech-recognition-fixture", name: "Speech Recognition Fixture", url: "https://speech-recognition-fixture.example",
    tagline: "A speech recognition app", description: "Speech recognition for audio files",
    category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
  });
});

test("public relevance search applies cached Japanese terms after the first response", async ({ page }) => {
  const enabled = ["lexical", "full"].includes(process.env.SEARCH_MULTILINGUAL_MODE ?? "");
  await page.goto(searchPath);
  await expect(page.getByRole("heading", { level: 1, name: /音声を認識するツール/ })).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);

  await db.insert(textTranslations).values({
    sourceHash: cacheKey,
    targetLang: "en", status: "done", translated: "speech recognition", model: "browser-fixture",
  });
  await page.reload();
  if (enabled) {
    await expect(page.locator(".project-title")).toHaveText("Speech Recognition Fixture");
  } else {
    await expect(page.locator(".project-card")).toHaveCount(0);
  }
  await page.goto(`${searchPath}&sort=recent`);
  await expect(page.getByRole("heading", { level: 1, name: /音声を認識するツール/ })).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);
});
