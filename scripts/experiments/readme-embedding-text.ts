const imageLink = /\[!\[[^\]\n]*\]\([^\n]*?\)\]\([^\n]*?\)|\[!\[[^\]\n]*\]\[[^\]\n]*\]\]\[[^\]\n]*\]/g;
const markdownImage = /!\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])?/g;
const markdownLink = /\[([^\]\n]+)\](?:\([^\n]*?\)|\[[^\]\n]*\])/g;
const commandLine = /^\s*(?:>[ \t]*)?(?:\$ |❯ |sudo\b|git (?:clone|checkout|submodule|pull)\b|(?:npm|pnpm|yarn|bun|pip3?|uv|poetry|gem|bundle|cargo|brew|choco|winget|apt(?:-get)?|pacman|go)\s+(?:i\b|install\b|add\b|run\b|get\b|build\b|dev\b|start\b|setup\b|update\b|sync\b|test\b)|(?:curl|wget|docker|docker-compose|kubectl|make|cmake|cd|chmod|mkdir|export|source|npx|bunx|uvx|python3?|node|bash|sh)\s+\S|\.[/\\]\S|(?:[A-Z_][A-Z0-9_]*=\S+))/u;

export const prefix = (text: string, limit: number): string => Array.from(text).slice(0, limit).join("");

/** Extract the opening prose from the exported README prefix, including partial final Markdown blocks. */
export function cleanReadme(raw: string): string {
  const withoutHtml = raw
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
    .replace(/<(picture|svg|script|style|pre|code|iframe|video|audio)(?:\s[^>]*|)>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
    .replace(/<[^<>\n]+>/g, " ");
  const lines: string[] = [];
  let fence: string | undefined;
  let tocLevel: number | undefined;
  for (const line of withoutHtml.split(/\r?\n/u)) {
    const marker = line.match(/^\s*(?:>\s*)?(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t)\S/u.test(line)) continue;
    const heading = line.match(/^\s*(#{1,6})\s+(.+)/u);
    if (heading && /^(?:table of contents|contents|목차|índice)(?:\s*#*)$/iu.test(heading[2].trim())) {
      tocLevel = heading[1].length;
      continue;
    }
    if (heading && tocLevel !== undefined && heading[1].length <= tocLevel) tocLevel = undefined;
    if (tocLevel !== undefined || /^\s*(?:\[\[?_?toc_?\]?\]|\[[^\]]+\]:|(?:[-*+]|\d+\.)?\s*\[[^\]]+\]\(#[^)]+\))\s*/iu.test(line)) continue;

    const text = line.replace(imageLink, " ").replace(markdownImage, " ")
      .replace(markdownLink, "$1")
      .replace(/(?:https?:\/\/|www\.)[^\s<>]+/giu, " ")
      .replace(/^\s*(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/u, "")
      .replace(/^`([^`]+)`$/u, "$1")
      .replace(/[`*_~|]/g, " ").replace(/\s+/gu, " ").trim();
    if (commandLine.test(line) || commandLine.test(text) || !/[\p{L}\p{N}]/u.test(text)) continue;
    lines.push(text);
  }
  return lines.join("\n");
}
