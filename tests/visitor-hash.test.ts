import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { productVisitorHash } from "@/lib/domain/products/visitors";

const SECRET_A = "visitor-hash-secret-a-32-characters-minimum";
const SECRET_B = "visitor-hash-secret-b-32-characters-minimum";

const savedSecret = process.env.VISITOR_HASH_SECRET;

afterEach(() => {
  if (savedSecret === undefined) delete process.env.VISITOR_HASH_SECRET;
  else process.env.VISITOR_HASH_SECRET = savedSecret;
});

describe("productVisitorHash", () => {
  it("returns a deterministic SHA-256 HMAC without disclosing the visitor", () => {
    const visitor = "browser-1";
    const first = productVisitorHash("alpha", visitor, SECRET_A);
    const second = productVisitorHash("alpha", visitor, SECRET_A);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(first).not.toContain(visitor);
  });

  it("scopes the same visitor to each product", () => {
    expect(productVisitorHash("alpha", "browser-1", SECRET_A)).not.toBe(
      productVisitorHash("beta", "browser-1", SECRET_A),
    );
  });

  it("separates hashes made with distinct valid secrets", () => {
    expect(productVisitorHash("alpha", "browser-1", SECRET_A)).not.toBe(
      productVisitorHash("alpha", "browser-1", SECRET_B),
    );
  });

  it("rejects a short secret", () => {
    expect(productVisitorHash("alpha", "browser-1", "short-secret")).toBeNull();
  });

  it("rejects a missing secret", () => {
    delete process.env.VISITOR_HASH_SECRET;

    expect(productVisitorHash("alpha", "browser-1")).toBeNull();
  });
});

describe("visitor hash secret configuration", () => {
  it("leaves the example secret empty and requires it in compose", () => {
    const envExample = readFileSync(".env.example", "utf8");
    const compose = readFileSync("compose.yml", "utf8");

    expect(envExample).toMatch(/^VISITOR_HASH_SECRET=$/m);
    expect(compose).toContain("${VISITOR_HASH_SECRET:?");
  });
});
