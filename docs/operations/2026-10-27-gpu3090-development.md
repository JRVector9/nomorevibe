# GPU3090 development workspace

The workspace is `/home/ubuntu/projects/nomorevibe` on `ubuntu@gpu3090`. It uses the latest production source from main1147adbf plus the delivery handoff documentation. The original divergent branch and its local files are preserved separately; see CODEX_HANDOFF.md for backup references.

## Enter the environment

```sh
ssh ubuntu@gpu3090
nmv
node --version
codex -m gpt-6.1-sol -c model_reasoning_effort=xhigh
```

`nmv` selects Node24.18.0 and the project directory. `nomorevibe-dev COMMAND...` provides the same environment for a single command. Existing Codex, Claude, Grok and GitHub CLI authentication stays on the server. CLI discovery/version and existing configuration were checked; no model inference was requested.

## Installed resources

- Lockfile-matched dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund`.
- Next16.4.1 local documentation under `node_modules/next/dist/docs/`.
- Dedicated PostgreSQL17 with pgvector0.8.6 in Docker container `nomorevibe-dev-gpu3090-20261027`.
- PostgreSQL binds only to `127.0.0.1:55434`, with a separate persistent volume and random development credentials.
- Private `.env.local` supplies development DB/auth settings; it is ignored by Git. The development DB has schema migrations applied and no production data.

To start the development web intentionally:

```sh
npm run dev -- --hostname 127.0.0.1
```

No web, worker or scheduler was started during environment setup. Tests, lint, typecheck, compilation and builds were not run. Installation scripts were skipped explicitly.

## Production operations

Production remains on the existing M3/mini/Oracle fleet. The official release/recovery launchers require the Mac Keychain and some Mac absolute paths; use the existing Mac operator for those commands until a Linux credential adapter is implemented. Do not reuse the development DB as a production connection or start production worker roles from this developer workspace.

Shell configuration backups and setup logs are private under `~/.local/state/nomorevibe-dev-setup-20261027`. Original changed files are protected in `~/.local/state/nomorevibe-gpu3090-before-main-20261027-1431` and the preserved Git stash/ref documented in CODEX_HANDOFF.md.
