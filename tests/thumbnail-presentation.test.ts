import { expect, it } from "vitest";
import { thumbnailPresentation } from "@/lib/domain/products/thumbnails/presentation";
it("contains repository logos while preserving landscape screenshots", () => {
 expect(thumbnailPresentation("/api/og-cache/x?thumbnail=repository_image&w=400&h=400").identity).toBe(true);
 expect(thumbnailPresentation("/api/og-cache/x?thumbnail=repository_image&w=180&h=96").identity).toBe(true);
 expect(thumbnailPresentation("/api/og-cache/x?thumbnail=repository_image&w=1200&h=630").identity).toBe(false);
});
it('contains wide repository wordmarks without shrinking full-size screenshots to icons',()=>{
 const wide=thumbnailPresentation('/api/og-cache/x?thumbnail=repository_image&w=512&h=128');
 expect(wide).toMatchObject({contain:true,identity:false,width:512,height:128});
 expect(thumbnailPresentation('/api/og-cache/x?thumbnail=og&w=1200&h=630').contain).toBe(false);
});
