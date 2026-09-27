# Home discovery

Home discovery is the public catalogue: hero, weekly pulse, popular tiers, sort tabs, project cards, in-browser save, and the methodology dialog. Unverified maker registrations do not appear here.

Verification (2026-09-27 local drive): HTTP/HTML proved for hero, empty catalogue, recent list, and post-verify listing. Browser save and methodology dialog need a headed session.

## Sub-features

- `home-hero` shows the public heading and the `/nomorevibe` launch control.
- `home-nav` reaches Discover, AI news, tools, and launch from the header.
- `home-empty` explains an empty catalogue on the default weekly sort.
- `home-recent` lists verified (and seeded) products on the 최신 tab.
- `home-save` bookmarks a card in this browser only.
- `home-methodology` opens the 숫자의 기준 dialog from a pulse metric.

## How to get to it (user POV)

- Open `/` in the browser.
- Choose `nomorevibe 홈` or `발견하기`.
- Choose `프로젝트 공개` to leave home for `/launch`.
- Choose a sort tab (`추천`, `최신`, `관심 많은 순`, `저장소 있음`).

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- For `home-recent` and `home-save`, a verified product already exists (complete maker-register + maker-verify first).
- For `home-empty`, either use a fresh database or accept that a populated catalogue skips that empty heading.

- **Open home.** Go to `/`. Run `curl -sS "$SITE/"`. The HTML contains `AI로 만든 것들, 세상에 나오다.` and `발견할 가치가 있는 프로젝트`.
- **Hero launch control.** Choose `/nomorevibe launch`. In the browser, activate the link whose accessible name or text includes `/nomorevibe`. The location becomes `$SITE/launch`.
- **Empty catalogue.** On a database with no listed products, `/` shows `아직 등록된 제품이 없습니다` once ranking has fallen back to recent (no active season) or you open `/?sort=recent`. After a season exists but has no ranked rows, `/?sort=weekly` shows `아직 순위에 오른 제품이 없습니다`.
- **Recent list.** Open `/?sort=recent`. A region `프로젝트 목록` contains a heading with the verified product name and a link `{name} 상세 보기` whose `href` is `/p/{slug}`.
- **Save card.** Choose `{name} 저장`. The same card's button accessible name becomes `{name} 저장 취소` and `aria-pressed` is `true`.
- **Saved filter.** Choose `저장한 프로젝트`. The URL contains `saved=1` and the page shows `이 브라우저에 저장한 프로젝트`.
- **Methodology.** From home (not a search-results layout), choose a pulse control such as `태어난 프로젝트` or `분야 순위 집계 기준`. A dialog `숫자의 기준` appears. Press Escape or choose `닫기`. The dialog hides and the URL has no `metric=` parameter.
- **Proof.** Screenshot `$SITE/?sort=recent` to `/tmp/nomorevibe-verify-$RUN_ID/evidence/home-discovery/recent.png`. The image shows the nomorevibe header and the verified product card.

## Gotchas

- Default sort is `추천` only when an active season exists. With no season, home falls back to recent and the empty copy is `아직 등록된 제품이 없습니다`, not the ranking empty state.
- Search results hide the hero and popular block. Re-open `/` before proving pulse or methodology.
- Save state is localStorage, not the server. A new browser profile starts unsaved.
- `주인을 기다리는 제품` is the seeded/unclaimed board. Do not treat it as maker-verified.
- Do not seed the home list with SQL. Register and verify through the maker APIs.
