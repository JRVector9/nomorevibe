import "./avatar.css";

/** 이니셜 아바타 — 사진은 올리지 않는다. 바탕은 카드 타일 색 중 하나를 계정 id 로 고른다(같은 사람은 늘 같은 색) */
const TILES = ["hue", "day", "note", "form", "invoice", "paper"] as const;

export function initialOf(name: string): string {
  return ([...name.trim()][0] ?? "?").toLocaleUpperCase();
}

export function MeAvatar({ name, seed, size = "s" }: { name: string; seed: number; size?: "s" | "m" | "l" }) {
  return <span className={`me-ava me-ava-${size}`} style={{ background: `var(--tile-${TILES[Math.abs(seed) % TILES.length]})` }} aria-hidden="true">{initialOf(name)}</span>;
}
