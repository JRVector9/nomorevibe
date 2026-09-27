# Launch and skill

Launch is the public maker onboarding page. `/skill.md` and `/install.sh` are the installable skill and installer the page tells the maker to fetch.

## Sub-features

- `launch-page` renders the `/nomorevibe` install story.
- `skill-md` serves the repo skill with the live site origin substituted.
- `install-sh` serves a shell installer that curls `/skill.md`.

## How to get to it (user POV)

- Choose `프로젝트 공개` in the header.
- Choose the home hero `/nomorevibe launch` control.
- Open `/launch` directly.
- Run `curl -fsSL <SITE>/install.sh` as printed on the launch page.
- Fetch `<SITE>/skill.md` as the installer does.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- `NEXT_PUBLIC_SITE_URL` matches `$SITE` so the launch snippet does not print an internal origin.

- **Open launch.** Go to `/launch`. The heading is `AI로 만들었나요? 명령 한 번으로 등록하세요.` The page contains `curl -fsSL` and `$SITE/install.sh` (or the configured public origin).
- **Skill document.** Run `curl -sS "$SITE/skill.md"`. HTTP 200. The body starts with YAML frontmatter `name: nomorevibe` and contains `/nomorevibe verify`.
- **Installer.** Run `curl -sS "$SITE/install.sh"`. HTTP 200. The body contains `curl -fsSL "$SITE/skill.md"` (or the same origin) and writes Claude/Codex skill paths.
- **Header entry.** From `/`, choose `프로젝트 공개`. The location is `/launch`.
- **Proof.** Save `curl -sS "$SITE/skill.md" | head` to `/tmp/nomorevibe-verify-$RUN_ID/evidence/launch-and-skill/skill.head.txt`. Screenshot `/launch` to `launch.png`.

## Gotchas

- If `NEXT_PUBLIC_SITE_URL` is unset, register/install URLs can leak an internal origin. Treat that as a launch misconfiguration, not a skill-file bug.
- Do not pipe `install.sh` into `sh` on the verification host unless you intend to write `~/.claude/skills`. Fetching the script is enough proof.
- `/skill.md` is served from `skill/SKILL.md` at runtime, not from this verify skill.
