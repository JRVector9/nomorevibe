import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuilderBadge, StatusBadge } from "@/components/TrustBadges";

describe("trust badge typography", () => {
  it("keeps every trust badge at 13px or larger", () => {
    const html = [
      renderToStaticMarkup(createElement(StatusBadge, {
        status: "verified",
        unclaimed: false,
      })),
      renderToStaticMarkup(createElement(StatusBadge, {
        size: "md",
        status: "seeded",
        unclaimed: true,
      })),
      renderToStaticMarkup(createElement(BuilderBadge, {
        builder: "Codex",
        claim: "guessed",
      })),
    ].join("");
    const source = readFileSync("components/TrustBadges.tsx", "utf8");
    const undersized = [...source.matchAll(/text-\[([0-9.]+)px\]/g)]
      .map((match) => Number(match[1]))
      .filter((size) => size < 13);

    expect(html).toContain("text-[13px]");
    expect(undersized).toEqual([]);
  });
});
