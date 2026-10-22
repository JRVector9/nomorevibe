import type { TrackElement } from "@/lib/analytics/dom";

/**
 * 시험 전용 — renderToStaticMarkup 결과를 클릭 분류기(lib/analytics/dom.ts)가 읽는 작은 나무로 바꾼다.
 * 단위 시험은 DOM 없이(node) 돌므로, 실제 화면 HTML 을 그대로 써서 "그리고 → 누르면 → 무엇을 보내나"를 본다.
 */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export type MarkupNode = Omit<TrackElement, "querySelectorAll" | "parentElement"> & {
  tagName: string;
  attributes: Map<string, string>;
  children: MarkupNode[];
  parentElement: MarkupNode | null;
  querySelectorAll(selector: string): MarkupNode[];
};

function decode(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** "a[href]"·"[data-track-view]"·"button"·"[data-track=\"x\"]" 정도만 */
function matcher(selector: string): (node: MarkupNode) => boolean {
  const match = /^([a-z0-9-]*)(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/i.exec(selector.trim());
  if (!match) throw new Error(`unsupported selector ${selector}`);
  const [, tag, attribute, value] = match;
  return (node) => (!tag || node.tagName === tag.toUpperCase())
    && (!attribute || (node.attributes.has(attribute) && (value === undefined || node.attributes.get(attribute) === value)));
}

function element(tagName: string, parent: MarkupNode | null): MarkupNode {
  const node: MarkupNode = {
    tagName: tagName.toUpperCase(),
    attributes: new Map(),
    children: [],
    parentElement: parent,
    getAttribute: (name) => node.attributes.get(name) ?? null,
    querySelectorAll: (selector) => descendants(node).filter(matcher(selector)),
  };
  return node;
}

function descendants(node: MarkupNode): MarkupNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

export function parseMarkup(html: string): MarkupNode {
  const root = element("root", null);
  let current = root;
  const tags = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=/>]+(?:="[^"]*"|='[^']*')?)*)\s*(\/?)>/g;
  for (const match of html.matchAll(tags)) {
    const [, closing, opening, attributeText, selfClosing] = match;
    if (closing) {
      for (let node: MarkupNode | null = current; node; node = node.parentElement) {
        if (node.tagName === closing.toUpperCase()) { current = node.parentElement ?? root; break; }
      }
      continue;
    }
    if (!opening) continue;
    const node = element(opening, current);
    for (const attribute of (attributeText ?? "").matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)')?/g)) {
      node.attributes.set(attribute[1], decode(attribute[2] ?? attribute[3] ?? ""));
    }
    current.children.push(node);
    if (!selfClosing && !VOID.has(opening.toLowerCase())) current = node;
  }
  return root;
}

/** 조건에 맞는 첫 요소 — 없으면 시험이 바로 실패하게 던진다 */
export function find(root: MarkupNode, predicate: (node: MarkupNode) => boolean, label = "element"): MarkupNode {
  const found = root.querySelectorAll("").find(predicate);
  if (!found) throw new Error(`${label} not found`);
  return found;
}

export const byHref = (href: string) => (node: MarkupNode) => node.tagName === "A" && node.attributes.get("href") === href;
export const byAttribute = (name: string, value?: string) => (node: MarkupNode) =>
  node.attributes.has(name) && (value === undefined || node.attributes.get(name) === value);

/** 렌더한 HTML 의 모든 data-track·data-track-view 매개변수 — 금지 키 검사용 */
export function trackedParams(root: MarkupNode): Array<{ name: string; params: Record<string, unknown> }> {
  return root.querySelectorAll("").flatMap((node) => {
    const name = node.attributes.get("data-track") ?? node.attributes.get("data-track-view");
    if (!name) return [];
    return [{ name, params: JSON.parse(node.attributes.get("data-track-params") ?? "{}") as Record<string, unknown> }];
  });
}
