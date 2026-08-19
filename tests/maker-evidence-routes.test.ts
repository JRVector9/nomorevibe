import { describe, expect, it } from "vitest";
import {
  makerUpdateCreateSchema,
  makerUpdatePatchSchema,
  readBoundedJson,
} from "@/lib/domain/evidence/maker";

describe("maker evidence route contracts", () => {
  it("rejects oversized declared and streamed JSON bodies before parsing", async () => {
    const declared = new Request("https://nomorevibe.test/api", {
      method: "PUT",
      headers: { "content-length": String(70 * 1024) },
      body: "{}",
    });
    await expect(readBoundedJson(declared)).rejects.toThrow(/too large/);

    const chunk = new Uint8Array(40 * 1024).fill(97);
    const streamed = new Request("https://nomorevibe.test/api", {
      method: "PUT",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedJson(streamed)).rejects.toThrow(/too large/);
  });

  it("validates maker updates without accepting automatic-source fields", () => {
    expect(makerUpdateCreateSchema.safeParse({
      title: "새 기능 공개",
      summary: "메이커가 직접 작성한 업데이트입니다.",
      sourceKind: "github_release",
    }).success).toBe(false);
    expect(makerUpdateCreateSchema.parse({
      title: "새 기능 공개",
      summary: "메이커가 직접 작성한 업데이트입니다.",
      canonicalUrl: "https://example.com/updates/1",
      publishedAt: "2026-08-20T00:00:00.000Z",
    })).toMatchObject({ title: "새 기능 공개" });
    expect(makerUpdatePatchSchema.safeParse({ title: "" }).success).toBe(false);
    expect(makerUpdatePatchSchema.safeParse({ observedAt: new Date() }).success).toBe(false);
  });
});
