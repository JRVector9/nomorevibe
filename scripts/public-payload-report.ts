/**
 * 공개 화면 HTML 에 실린 데이터 재기(2026-11-14 공개 HTML 줄이기).
 *
 * 띄워 둔 next start(시험 DB)에 브라우저 머리로 화면을 받아, HTML 바이트·RSC 데이터(self.__next_f) 바이트·
 * RSC 안의 제품 객체(slug 와 name 을 함께 가진 객체) 수와 그 객체에 남은 칸, 금지 칸 이름이 RSC 에 있는지,
 * 상세 README 발췌 길이와 전문(README 원문의 뒷부분 표지 글)이 HTML·RSC 에 있는지를 JSON 으로 낸다.
 *
 *   npx tsx scripts/public-payload-report.ts http://localhost:3911 /,/popular,/c/dev,/?q=fixture,/p/ggml [readme-marker]
 *
 * 읽기만 한다 — 운영 주소에 쓰지 않는다(공개 화면 한 번씩만 받는다).
 */

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** 공개 화면 RSC 데이터에 실리면 안 되는 운영·식별 칸 */
export const FORBIDDEN_FIELDS = [
  "id", "repoUrl", "status", "builderClaim", "taglineSource", "starsPreviousAt", "starsPrevious", "starsAt", "listedAt",
  "makerName", "unclaimed", "pushedAt", "repoRenamedTo", "source", "createdAt", "claimedAt", "verifiedAt",
] as const;

/** HTML 안 self.__next_f.push([1,"…"]) 조각들을 이어 RSC 데이터 글로 */
export function extractFlight(html: string): string {
  const chunks: string[] = [];
  const pattern = /self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]) as unknown[];
      if (value[0] === 1 && typeof value[1] === "string") chunks.push(value[1]);
    } catch { /* 형식이 다른 조각은 건너뛴다 */ }
  }
  return chunks.join("");
}

/** RSC 데이터 줄들을 값으로 — `id:JSON`, `id:I[…]`, `id:T길이,글` 모양 */
export function parseFlightRows(flight: string): unknown[] {
  const rows: unknown[] = [];
  const bytes = Buffer.from(flight, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const colon = bytes.indexOf(0x3a, offset);
    if (colon < 0) break;
    let cursor = colon + 1;
    const tagMatch = /^[A-Z]*/.exec(bytes.subarray(cursor, cursor + 4).toString("latin1"))![0];
    if (tagMatch === "T") {
      const comma = bytes.indexOf(0x2c, cursor);
      const length = parseInt(bytes.subarray(cursor + 1, comma).toString("latin1"), 16);
      rows.push(bytes.subarray(comma + 1, comma + 1 + length).toString("utf8"));
      offset = comma + 1 + length;
      continue;
    }
    cursor += tagMatch.length;
    const end = bytes.indexOf(0x0a, cursor);
    const text = bytes.subarray(cursor, end < 0 ? bytes.length : end).toString("utf8");
    try { rows.push(JSON.parse(text)); } catch { rows.push(text); }
    offset = end < 0 ? bytes.length : end + 1;
  }
  return rows;
}

/** slug 와 name 을 함께 가진 객체 — 제품 데이터가 JSON 으로 실린 것 */
export function productObjects(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const item of value) productObjects(item, found);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.slug === "string" && typeof record.name === "string") found.push(record);
    for (const item of Object.values(record)) productObjects(item, found);
  }
  return found;
}

/** RSC 데이터에 금지 칸 이름이 JSON 키로 나오는지 */
export function forbiddenKeysIn(flight: string, fields: readonly string[] = FORBIDDEN_FIELDS): string[] {
  return fields.filter((field) => flight.includes(`"${field}":`));
}

function visibleText(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function measurePage(html: string, readmeMarker?: string) {
  const flight = extractFlight(html);
  const rows = parseFlightRows(flight);
  const products = productObjects(rows);
  const fields = [...new Set(products.flatMap((item) => Object.keys(item)))].sort();
  const excerpt = /data-readme-excerpt[^>]*>([\s\S]*?)<\/blockquote>/.exec(html)?.[1]?.replace(/<[^>]+>/g, "");
  return {
    htmlBytes: Buffer.byteLength(html),
    rscBytes: Buffer.byteLength(flight),
    visibleTextBytes: Buffer.byteLength(visibleText(html)),
    productObjects: products.length,
    productFields: fields,
    forbiddenKeysInRsc: forbiddenKeysIn(flight),
    ...(readmeMarker === undefined ? {} : {
      readmeExcerptChars: excerpt === undefined ? null : decodeEntities(excerpt).length,
      readmeFullInHtml: visibleText(html.replace(/self\.__next_f[\s\S]*?<\/script>/g, "")).includes(readmeMarker),
      readmeFullInRsc: flight.includes(readmeMarker),
    }),
  };
}

function decodeEntities(text: string): string {
  return text.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

async function main() {
  const [origin, paths = "/", readmeMarker] = process.argv.slice(2);
  if (!origin) throw new Error("usage: public-payload-report.ts <origin> <paths,comma> [readme-marker]");
  const report: Record<string, unknown> = {};
  for (const path of paths.split(",")) {
    const response = await fetch(new URL(path, origin), { headers: { "user-agent": BROWSER_UA, accept: "text/html" } });
    const html = await response.text();
    report[path] = { status: response.status, ...measurePage(html, path.startsWith("/p/") ? readmeMarker ?? "" : undefined) };
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && /public-payload-report\.ts$/.test(process.argv[1])) main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
