"""공유 카드(lib/me/share-card.tsx) 글꼴 lib/me/fonts/*.woff 를 다시 만든다 — 한글 완성형 전부, 간체 GB2312, 번체 Big5 상용자, 라틴·기호.

원본: Google Fonts 의 Noto Sans KR·SC·TC 정적 TTF(400·700). css2 API 를 woff2 를 모르는 옛 브라우저 이름으로 부르면 TTF 주소를 준다.
  <src_dir>/noto-{kr,sc,tc}-{400,700}.ttf 로 받아 두고:
  python3 -m venv .venv && .venv/bin/pip install fonttools==4.60.1
  .venv/bin/python scripts/fonts/subset-share-card-fonts.py <src_dir> lib/me/fonts
글꼴 라이선스는 SIL OFL 1.1(lib/me/fonts/OFL.txt).
"""
import sys
from pathlib import Path
from fontTools import subset

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

def span(a, b):
    return set(range(a, b + 1))

COMMON = (span(0x20, 0x7E) | span(0xA0, 0x17F) | span(0x2000, 0x206F) | span(0x20A0, 0x20BF) | span(0x2100, 0x21FF)
          | span(0x2200, 0x22FF) | span(0x2460, 0x24FF) | span(0x25A0, 0x25FF) | span(0x2600, 0x26FF) | span(0x3000, 0x303F)
          | span(0xFF00, 0xFFEF))
HANGUL = span(0x1100, 0x11FF) | span(0x3130, 0x318F) | span(0xAC00, 0xD7A3)

def decoded(encoding, lead, trail):
    chars = set()
    for hi in lead:
        for lo in trail:
            try:
                chars.add(ord(bytes([hi, lo]).decode(encoding)))
            except (UnicodeDecodeError, TypeError):
                pass
    return chars

GB2312 = decoded("gb2312", range(0xA1, 0xF8), range(0xA1, 0xFF))
# Big5 1단계(상용 5,401자, A440–C67E)와 기호 구역(A140–A3FE)
BIG5 = {c for c in decoded("big5", range(0xA1, 0xC7), list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)))}

SETS = {"kr": COMMON | HANGUL, "sc": COMMON | GB2312, "tc": COMMON | BIG5}

for short, unicodes in SETS.items():
    for weight in (400, 700):
        options = subset.Options()
        options.flavor = "woff"
        options.hinting = False
        options.desubroutinize = True
        options.layout_features = ["kern", "liga", "calt", "locl", "ccmp", "vert"]
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.notdef_outline = True
        font = subset.load_font(str(src / f"noto-{short}-{weight}.ttf"), options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=sorted(unicodes))
        subsetter.subset(font)
        target = out / f"noto-sans-{short}-{weight}.woff"
        subset.save_font(font, str(target), options)
        print(f"{target.name}: {len(unicodes)} codepoints → {target.stat().st_size / 1024:.0f} KB")
