import { expect, it } from "vitest";
import { completedThumbnailIds } from "@/lib/domain/products/thumbnails/receipt";
it("apply resumes previews, failures and CAS conflicts", () => {
 const receipt = ["preview", "skipped", "failed", "applied", "preexisting"].map((status,id)=>JSON.stringify({id,status})).join("\n");
 expect([...completedThumbnailIds(receipt)]).toEqual([3,4]);
});
