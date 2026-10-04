import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function filesUnder(directory: string, extension: string): string[] {
  const root = join(ROOT, directory);
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith(extension)) files.push(child);
    }
  };
  visit(root);
  return files;
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("global light UI contract", () => {
  it("contains no visible Tailwind font utility below 13px", () => {
    const violations: string[] = [];
    for (const file of [...filesUnder("app", ".tsx"), ...filesUnder("components", ".tsx")]) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/text-\[([0-9]+(?:\.[0-9]+)?)px\]|text-xs/g)) {
        const size = match[0] === "text-xs" ? 12 : Number(match[1]);
        if (size < 13) violations.push(`${relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses light tokens unconditionally and retains only an explicit future dark override", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(root).toContain("color-scheme: light");
    expect(root).toContain("--bg: #ffffff");
    expect(root).toContain("--bg-card: #ffffff");
    expect(root).toContain("--accent: #d63a40");
    expect(css).not.toContain("@media (prefers-color-scheme: light)");
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{[\s\S]*color-scheme:\s*dark/);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps 13px muted text AA-readable on every light surface", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const token = (name: string) => root.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1] ?? "";
    const muted = token("text-3");
    expect(muted).toMatch(/^#[0-9a-f]{6}$/i);
    for (const surface of [token("bg"), token("bg-soft"), token("bg-card")]) {
      expect(contrastRatio(muted, surface), `${muted} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reduces ordinary 14px section radii while preserving the detail hero exception", () => {
    const violations: string[] = [];
    for (const file of [...filesUnder("app", ".tsx"), ...filesUnder("components", ".tsx")]) {
      const name = relative(ROOT, file);
      if (name === "components/product-detail/ProductHero.tsx") continue;
      const source = readFileSync(file, "utf8");
      if (source.includes("rounded-[14px]")) violations.push(name);
    }
    expect(violations).toEqual([]);
    expect(readFileSync(join(ROOT, "components/Panel.tsx"), "utf8")).toContain("rounded-[12px]");
  });

  it("uses the approved detail prose hierarchy", () => {
    const introduction = readFileSync(join(ROOT, "components/product-detail/IntroSection.tsx"), "utf8");
    const updates = readFileSync(join(ROOT, "components/product-detail/UpdateTimeline.tsx"), "utf8");
    expect(introduction).toContain('text-[17px] leading-[1.6] text-fg');
    expect(introduction).toContain('text-[15px] leading-[1.6]');
    expect(updates).toContain('text-[13px] text-fg');
  });
});
