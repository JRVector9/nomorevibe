import "server-only";
import { ImageResponse } from "next/og";
import { createMemo } from "@/lib/cache/memo";
import type { Locale } from "@/lib/i18n/locales";
import { logger } from "@/lib/observability/logger";
import type { ShareCardData } from "./share";

/**
 * 공유 카드 그림(SNS 설계 T13·M5) — 1200×630, 어두운 잉크 카드. next/og ImageResponse(Satori)로 그린다.
 * 글꼴: 저장소에 한글 글꼴 파일이 없어 카드에 쓰인 글자만 Google Fonts 에서 받아 쓴다(text= 부분집합, 수십 KB).
 * next/og 의 기본 동적 글꼴은 글자열마다 프로세스 안에 끝없이 담으므로, 여기서 받은 것을 크기 제한 있는 캐시에 둔다.
 * 받지 못하면 기본 글꼴(Geist)로 그린다 — 라틴 글자는 보이고 한글은 빠질 수 있다.
 */
const INK = { card: "#10141c", fg: "#f0f3fa", fg2: "#98a2b8", chip: "rgba(255, 255, 255, 0.09)", tile: "#f2f2f7", tileFg: "#1d1d1f", accent: "#d63a40", hn: "#b4500f" };
const FAMILY: Record<Locale, string> = { ko: "Noto Sans KR", en: "Noto Sans KR", "zh-Hans": "Noto Sans SC", "zh-Hant": "Noto Sans TC" };
/** TTF 를 돌려받는 옛 브라우저 이름 — 요즘 이름이면 woff2 를 주는데 Satori 는 읽지 못한다 */
const TTF_AGENT = "Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10_6_8; de-at) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1";
const fonts = createMemo<ArrayBuffer>({ ttlMs: 6 * 3_600_000, max: 48 });

async function googleFont(family: string, weight: 400 | 700, text: string): Promise<ArrayBuffer> {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent(text)}`, {
    headers: { "User-Agent": TTF_AGENT }, redirect: "error", signal: AbortSignal.timeout(4_000),
  });
  const url = /src: url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\) format\('(?:truetype|opentype)'\)/.exec(css.ok ? await css.text() : "")?.[1];
  if (!url) throw new Error("share_card_font_missing");
  const font = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(4_000) });
  if (!font.ok) throw new Error("share_card_font_missing");
  return font.arrayBuffer();
}

async function cardFonts(locale: Locale, text: string) {
  const glyphs = [...new Set(Array.from(text.replace(/\s+/g, "")))].sort().join("");
  const family = FAMILY[locale];
  const loaded = await Promise.all(([400, 700] as const).map(async (weight) => {
    try {
      return { name: "Card", data: await fonts.get(`${family}|${weight}|${glyphs}`, () => googleFont(family, weight, glyphs)), weight, style: "normal" as const };
    } catch (error) {
      logger.warn("me.share_card_font_unavailable", { weight, error: error instanceof Error ? error.message : "unknown" });
      return null;
    }
  }));
  const usable = loaded.filter((font) => font !== null);
  return usable.length ? usable : undefined;
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
  const text = ["nomorevibe", data.brandLine, initial, name, tagline, ...data.chips.map((chip) => chip.text), data.url, data.date, "…"].join("");
  const element = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", background: INK.card, color: INK.fg, fontFamily: "Card" }}>
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
  return new ImageResponse(element, { width: 1200, height: 630, fonts: await cardFonts(locale, text) }).arrayBuffer();
}
