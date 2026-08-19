import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("application typography", () => {
  it("does not define text below 13px in rendered app components", () => {
    const violations = componentFiles("app")
      .concat(componentFiles("components"))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        const explicit = [...source.matchAll(/text-\[([0-9.]+)(px|rem)\]/g)]
          .map((match) => ({
            file,
            size: match[2] === "rem" ? Number(match[1]) * 16 : Number(match[1]),
            token: match[0],
          }))
          .filter(({ size }) => size < 13);
        const tailwindXs = [...source.matchAll(/\btext-xs\b/g)]
          .map(() => ({ file, size: 12, token: "text-xs" }));
        return explicit.concat(tailwindXs);
      });

    expect(violations).toEqual([]);
  });
});
