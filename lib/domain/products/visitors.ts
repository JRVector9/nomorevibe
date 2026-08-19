import { createHmac } from "node:crypto";

export function productVisitorHash(
  slug: string,
  visitor: string,
  secret = process.env.VISITOR_HASH_SECRET,
): string | null {
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(slug).update("\0").update(visitor).digest("hex");
}
