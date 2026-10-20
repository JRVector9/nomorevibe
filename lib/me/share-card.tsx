import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import type { Locale } from "@/lib/i18n/locales";
import { logger } from "@/lib/observability/logger";
import type { ShareCardData } from "./share";

/**
 * 공유 카드 그림(SNS 설계 T13·M5) — 1200×630, 어두운 잉크 카드. next/og ImageResponse(Satori)로 그린다.
 * 글꼴: 저장소에 둔 Noto Sans KR·SC·TC 부분집합(lib/me/fonts, WOFF, SIL OFL 1.1 — 만든 방법은 scripts/fonts/subset-share-card-fonts.py).
 * 한글 완성형 전부·간체 GB2312·번체 Big5 상용자·라틴·기호가 들어 있다. 처음 그릴 때 한 번 읽어 프로세스에 둔다 — 밖으로 나가지 않는다.
 * 카드 언어의 글꼴을 앞에 두고 나머지 둘을 뒤에 둬, 한 카드에 섞인 한글·한자도 그린다. 부분집합에 없는 드문 글자는 빠질 수 있다.
 */
const INK = { card: "#10141c", fg: "#f0f3fa", fg2: "#98a2b8", chip: "rgba(255, 255, 255, 0.09)", tile: "#f2f2f7", tileFg: "#1d1d1f", accent: "#d63a40", hn: "#b4500f" };
type Script = "kr" | "sc" | "tc";
const SCRIPTS: Record<Locale, Script> = { ko: "kr", en: "kr", "zh-Hans": "sc", "zh-Hant": "tc" };
/** standalone 빌드에도 실리게 next.config 의 outputFileTracingIncludes 가 이 폴더를 넣는다 */
const FONT_DIR = path.join(process.cwd(), "lib/me/fonts");
const files = new Map<string, Promise<ArrayBuffer>>();

function fontFile(script: Script, weight: 400 | 700): Promise<ArrayBuffer> {
  const name = `noto-sans-${script}-${weight}.woff`;
  let file = files.get(name);
  if (!file) {
    file = readFile(path.join(FONT_DIR, name)).then((buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
    // 못 읽었으면 다음 요청에서 다시 읽는다
    file.catch(() => files.delete(name));
    files.set(name, file);
  }
  return file;
}

export function cardFontOrder(locale: Locale): Script[] {
  const first = SCRIPTS[locale];
  return [first, ...(["kr", "sc", "tc"] as const).filter((script) => script !== first)];
}

async function cardFonts(locale: Locale) {
  const order = cardFontOrder(locale);
  const loaded = await Promise.all(order.flatMap((script) => ([400, 700] as const).map(async (weight) => {
    try {
      return { name: `Card ${script}`, data: await fontFile(script, weight), weight, style: "normal" as const };
    } catch (error) {
      logger.warn("me.share_card_font_unavailable", { script, weight, error: error instanceof Error ? error.message : "unknown" });
      return null;
    }
  })));
  const usable = loaded.filter((font) => font !== null);
  return { fonts: usable.length ? usable : undefined, family: order.map((script) => `"Card ${script}"`).join(", ") };
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
  const name = clampCardText(data.name, 22);
  const tagline = clampCardText(data.tagline, 46);
  const initial = (Array.from(data.name.trim())[0] ?? "n").toUpperCase();
  const nameSize = name.length > 18 ? 62 : name.length > 12 ? 74 : 86;
  const { fonts, family } = await cardFonts(locale);
  const element = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", background: INK.card, color: INK.fg, fontFamily: family }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.02em" }}>nomorevibe</span>
        <span style={{ width: 12, height: 12, borderRadius: 6, background: INK.accent, marginLeft: 4, marginTop: 14 }} />
        <span style={{ fontSize: 26, color: INK.fg2, marginLeft: 22 }}>{data.brandLine}</span>
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
            <span key={chip.text} style={{ display: "flex", fontSize: 26, padding: "10px 20px", borderRadius: 14, background: INK.chip, marginRight: 14, marginTop: 10, ...(chip.hn ? { borderLeft: `6px solid ${INK.hn}` } : {}) }}>{chip.text}</span>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", marginLeft: 24, color: INK.fg2 }}>
          <span style={{ fontSize: 26 }}>{data.url}</span>
          <span style={{ fontSize: 20, marginTop: 6 }}>{data.date}</span>
        </div>
      </div>
    </div>
  );
  return new ImageResponse(element, { width: 1200, height: 630, fonts }).arrayBuffer();
}
