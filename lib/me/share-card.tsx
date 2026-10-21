import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { ImageResponse } from "next/og";
import type { Locale } from "@/lib/i18n/locales";
import { logger } from "@/lib/observability/logger";
import type { ShareCardData } from "./share";

/**
 * 공유 카드 그림(SNS 설계 T13·M5) — 1200×630, 어두운 잉크 카드. next/og ImageResponse(Satori)로 그린다.
 * 글꼴: 저장소에 둔 Noto Sans KR·SC·TC 부분집합(assets/fonts, WOFF, SIL OFL 1.1 — 만든 방법은 scripts/fonts/subset-share-card-fonts.py).
 * lib 밖에 두는 것은 글꼴을 쓰지 않는 워커 이미지·Oracle 릴리스(lib 를 통째로 복사한다)를 키우지 않으려는 것이다.
 * KR 은 한글 완성형·라틴·기호, SC 는 간체 GB2312(가나 포함), TC 는 번체 Big5 상용자를 담는다.
 *
 * 밖으로 나가지 않는다: next/og 는 글꼴에 없는 글자(이모지·태국어·베트남어 성조 글자 …)를 만나면 그 자리에서 Google Fonts·jsDelivr 로
 * 글꼴·그림을 받으러 가고(시간 제한 없음, 이모지 실패는 그림째 실패), 그 받기를 바꿀 길(loadAdditionalAsset)을 열어 두지 않는다.
 * 그래서 그리기 전에 실은 글꼴의 cmap 에 없는 글자를 글에서 뺀다 — 빠진 글자가 없으면 Satori 는 받으러 가지 않는다.
 * 글꼴은 카드 언어의 것을 먼저 싣고, 그 글꼴에 없는 글자(한 카드에 섞인 한글·한자·가나)를 담은 글꼴만 뒤에 더 싣는다.
 */
const INK = { card: "#10141c", fg: "#f0f3fa", fg2: "#98a2b8", chip: "rgba(255, 255, 255, 0.09)", tile: "#f2f2f7", tileFg: "#1d1d1f", accent: "#d63a40", hn: "#b4500f" };
type Script = "kr" | "sc" | "tc";
type Weight = 400 | 700;
type Face = { script: Script; weight: Weight; data: ArrayBuffer; covers: Set<number> };
const SCRIPTS: Record<Locale, Script> = { ko: "kr", en: "kr", "zh-Hans": "sc", "zh-Hant": "tc" };
/** standalone 빌드에 실리게 next.config 의 outputFileTracingIncludes 가 이 폴더를 넣는다 */
const FONT_DIR = path.join(process.cwd(), "assets/fonts");
/** 실은 글꼴(처음 쓸 때 읽어 프로세스에 둔다)과, 실을지 정할 때만 본 글꼴의 글자 목록 */
const faces = new Map<string, Promise<Face>>();
const coverages = new Map<Script, Promise<Set<number>>>();

/** WOFF(또는 TTF·OTF)에서 표 하나 */
function sfntTable(file: Buffer, tag: string): Buffer {
  const woff = file.toString("latin1", 0, 4) === "wOFF";
  const count = file.readUInt16BE(woff ? 12 : 4);
  for (let index = 0; index < count; index += 1) {
    const at = woff ? 44 + index * 20 : 12 + index * 16;
    if (file.toString("latin1", at, at + 4) !== tag) continue;
    if (!woff) return file.subarray(file.readUInt32BE(at + 8), file.readUInt32BE(at + 8) + file.readUInt32BE(at + 12));
    const offset = file.readUInt32BE(at + 4), stored = file.readUInt32BE(at + 8), length = file.readUInt32BE(at + 12);
    const raw = file.subarray(offset, offset + stored);
    return stored < length ? inflateSync(raw) : raw;
  }
  throw new Error(`font_table_missing:${tag}`);
}

/**
 * 글꼴이 글리프를 가진 코드 포인트 — cmap 의 유니코드 표(형식 12, 없으면 4)에서 글리프 0(없음)이 아닌 것.
 * Satori 가 쓰는 opentype.js 의 charToGlyphIndex 와 같은 판단이다
 */
export function fontCoverage(file: Buffer): Set<number> {
  const cmap = sfntTable(file, "cmap");
  let format4 = -1, format12 = -1;
  for (let index = 0; index < cmap.readUInt16BE(2); index += 1) {
    const at = 4 + index * 8;
    const platform = cmap.readUInt16BE(at), encoding = cmap.readUInt16BE(at + 2), offset = cmap.readUInt32BE(at + 4);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const format = cmap.readUInt16BE(offset);
    if (format === 12 && format12 < 0) format12 = offset;
    if (format === 4 && format4 < 0) format4 = offset;
  }
  const covers = new Set<number>();
  if (format12 >= 0) {
    for (let group = 0; group < cmap.readUInt32BE(format12 + 12); group += 1) {
      const at = format12 + 16 + group * 12;
      const start = cmap.readUInt32BE(at), end = cmap.readUInt32BE(at + 4), glyph = cmap.readUInt32BE(at + 8);
      for (let code = start; code <= end; code += 1) if (glyph + code - start !== 0) covers.add(code);
    }
    return covers;
  }
  if (format4 < 0) throw new Error("font_cmap_unsupported");
  const segments = cmap.readUInt16BE(format4 + 6);
  const ends = format4 + 14, starts = ends + segments + 2, deltas = starts + segments, ranges = deltas + segments;
  for (let segment = 0; segment < segments; segment += 2) {
    const end = cmap.readUInt16BE(ends + segment), start = cmap.readUInt16BE(starts + segment);
    const delta = cmap.readInt16BE(deltas + segment), range = cmap.readUInt16BE(ranges + segment);
    for (let code = start; code <= end && code !== 0xffff; code += 1) {
      const raw = range === 0 ? code : cmap.readUInt16BE(ranges + segment + range + (code - start) * 2);
      if (raw !== 0 && ((raw + delta) & 0xffff) !== 0) covers.add(code);
    }
  }
  return covers;
}

const fileName = (script: Script, weight: Weight) => `noto-sans-${script}-${weight}.woff`;

function face(script: Script, weight: Weight): Promise<Face> {
  const name = fileName(script, weight);
  let loaded = faces.get(name);
  if (!loaded) {
    loaded = readFile(path.join(FONT_DIR, name)).then((buffer) => ({ script, weight, covers: fontCoverage(buffer),
      data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer }));
    // 못 읽었으면 다음 요청에서 다시 읽는다
    loaded.catch(() => faces.delete(name));
    faces.set(name, loaded);
  }
  return loaded;
}

/** 실을지 정하는 데 쓰는 글자 목록(400) — 이미 실은 글꼴이면 그것을, 아니면 파일을 읽어 목록만 남긴다 */
function coverage(script: Script): Promise<Set<number>> {
  const loaded = faces.get(fileName(script, 400));
  if (loaded) return loaded.then((item) => item.covers);
  let covers = coverages.get(script);
  if (!covers) {
    covers = readFile(path.join(FONT_DIR, fileName(script, 400))).then(fontCoverage);
    covers.catch(() => coverages.delete(script));
    coverages.set(script, covers);
  }
  return covers;
}

export function cardFontOrder(locale: Locale): Script[] {
  const first = SCRIPTS[locale];
  return [first, ...(["kr", "sc", "tc"] as const).filter((script) => script !== first)];
}

const codePoints = (text: string) => new Set(Array.from(text.normalize("NFC"), (char) => char.codePointAt(0)!));

/** 카드 언어의 글꼴과, 그 글꼴에 없는 글자를 담은 다른 글꼴만 — 한국어·영어 카드에 한자가 없으면 SC·TC 는 읽지 않는다 */
export async function cardScripts(locale: Locale, text: string): Promise<Script[]> {
  const [first, ...rest] = cardFontOrder(locale);
  const picked: Script[] = [first];
  const missing = codePoints(text);
  const covered = async (script: Script) => {
    try { return await coverage(script); } catch { return new Set<number>(); }
  };
  for (const code of await covered(first)) missing.delete(code);
  for (const script of rest) {
    if (!missing.size) break;
    const covers = await covered(script);
    const helps = [...missing].filter((code) => covers.has(code));
    if (!helps.length) continue;
    picked.push(script);
    for (const code of helps) missing.delete(code);
  }
  return picked;
}

async function cardFonts(scripts: Script[]): Promise<Face[]> {
  const loaded = await Promise.all(scripts.flatMap((script) => ([400, 700] as const).map(async (weight) => {
    try {
      return await face(script, weight);
    } catch (error) {
      logger.warn("me.share_card_font_unavailable", { script, weight, error: error instanceof Error ? error.message : "unknown" });
      return null;
    }
  })));
  return loaded.filter((item) => item !== null);
}

/**
 * 실은 글꼴로 그릴 수 있는 글자만 남긴다(NFC 로 모은 뒤 코드 포인트마다). 굵기마다 Satori 가 고를 글꼴(그 굵기, 없으면 다른 굵기)을 본다.
 * 글꼴을 하나도 못 읽었으면 next/og 기본 글꼴(라틴)로 그리므로 ASCII 만 남긴다
 */
export function drawableText(text: string, fonts: readonly Face[], weight: Weight): string {
  const scripts = [...new Set(fonts.map((item) => item.script))];
  const used = scripts.flatMap((script) => {
    const chosen = fonts.find((item) => item.script === script && item.weight === weight) ?? fonts.find((item) => item.script === script);
    return chosen ? [chosen.covers] : [];
  });
  return Array.from(text.normalize("NFC")).filter((char) => used.length
    ? used.some((covers) => covers.has(char.codePointAt(0)!)) : /^[\x20-\x7e]$/.test(char)).join("");
}

/** 두 줄 남짓에서 자른다 — 한글·한자는 한 칸, 라틴은 반 칸 남짓 */
export function clampCardText(text: string, units: number): string {
  let used = 0;
  let out = "";
  for (const char of Array.from(text.replace(/\s+/g, " ").trim())) {
    used += /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char) ? 1 : 0.56;
    if (used > units) return `${out.trimEnd()}…`;
    out += char;
  }
  return out;
}

export async function shareCardPng(data: ShareCardData, locale: Locale): Promise<ArrayBuffer> {
  const chips = data.chips.map((chip) => chip.text);
  const scripts = await cardScripts(locale, [data.name, data.tagline, data.brandLine, data.url, data.date, ...chips].join(" "));
  const fonts = await cardFonts(scripts);
  const bold = (text: string) => drawableText(text.replace(/\s+/g, " "), fonts, 700).replace(/ {2,}/g, " ").trim();
  const regular = (text: string) => drawableText(text.replace(/\s+/g, " "), fonts, 400).replace(/ {2,}/g, " ").trim();
  // 이름이 그릴 수 없는 글자뿐이면(이모지만) 주소의 slug 를 쓴다
  const name = clampCardText(bold(data.name), 22) || data.url.slice(data.url.lastIndexOf("/") + 1);
  const tagline = clampCardText(regular(data.tagline), 46);
  const initial = (Array.from(name)[0] ?? "n").toUpperCase();
  const nameSize = name.length > 18 ? 62 : name.length > 12 ? 74 : 86;
  const family = [...new Set(fonts.map((item) => `"Card ${item.script}"`))].join(", ") || undefined;
  const element = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", background: INK.card, color: INK.fg, fontFamily: family }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em" }}>nomorevibe</span>
        <span style={{ width: 12, height: 12, borderRadius: 6, background: INK.accent, marginLeft: 4, marginTop: 14 }} />
        <span style={{ fontSize: 26, color: INK.fg2, marginLeft: 22 }}>{regular(data.brandLine)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div style={{ width: 156, height: 156, borderRadius: 36, background: INK.tile, color: INK.tileFg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 76, fontWeight: 700, flexShrink: 0 }}>{initial}</div>
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 42, flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", fontSize: nameSize, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.08 }}>{name}</div>
          {tagline ? <div style={{ display: "flex", fontSize: 34, color: INK.fg2, marginTop: 18, lineHeight: 1.38 }}>{tagline}</div> : null}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexWrap: "wrap", flex: 1 }}>
          {data.chips.map((chip) => (
            <span key={chip.text} style={{ display: "flex", fontSize: 26, padding: "10px 20px", borderRadius: 14, background: INK.chip, marginRight: 14, marginTop: 10, ...(chip.hn ? { borderLeft: `6px solid ${INK.hn}` } : {}) }}>{regular(chip.text)}</span>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginLeft: 24, color: INK.fg2 }}>
          <span style={{ fontSize: 26 }}>{regular(data.url)}</span>
          <span style={{ fontSize: 20, marginTop: 6 }}>{regular(data.date)}</span>
        </div>
      </div>
    </div>
  );
  const satoriFonts = fonts.length ? fonts.map((item) => ({ name: `Card ${item.script}`, data: item.data, weight: item.weight, style: "normal" as const })) : undefined;
  return new ImageResponse(element, { width: 1200, height: 630, fonts: satoriFonts }).arrayBuffer();
}
