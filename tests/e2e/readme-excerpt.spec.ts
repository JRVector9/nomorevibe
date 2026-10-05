import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { PRODUCT_DETAIL_FIXTURES, seedProductDetailFixtures } from "./fixtures/product-detail";

test("README excerpt decodes quoted CJK prose as literal text in the detail page", async ({ page }) => {
  await seedProductDetailFixtures();
  const text = '这是一款帮助团队整理工作记录和项目进展的协作工具，支持搜索讨论内容 & 决策依据。<script>alert("fixture")</script>';
  const readme = '> 这是一款帮助团队整理工作记录和项目进展的协作工具，支持搜索讨论内容 &amp; 决策依据。&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt;';
  await db.update(products).set({ searchReadme: readme }).where(eq(products.slug, PRODUCT_DETAIL_FIXTURES.collecting));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/p/${PRODUCT_DETAIL_FIXTURES.collecting}`);
  const excerpt = page.getByRole("region", { name: "README에서", exact: true });
  await expect(excerpt.locator("blockquote")).toHaveText(text);
  await expect(excerpt.locator("script")).toHaveCount(0);
  expect(errors).toEqual([]);
});
