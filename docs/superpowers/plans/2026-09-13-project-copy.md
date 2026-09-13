# Project presentation cleanup

Goal: repository-only fallback names, two-line listing descriptions, remove process narration, explain weekly visit/save behavior.
User supplied concrete design and authorized implementation. Execute inline; no new approval gate.

- [ ] Add pure displayProjectName(name, repoUrl): strip owner only when exact GitHub owner/repo identity, preserve custom slash names. Use public list/popular/detail view boundaries, leaving DB/search identity unchanged.
- [ ] Remove pending star narration and public product collection prose; retain concise provenance/error states and factual metric timestamps. Document exact removed/replaced strings. Preserve pre-existing Hero changes by staging an independently transformed HEAD version.
- [ ] Clamp card/popular descriptions to two lines; preserve full text in title/detail. Explain bookmark localStorage persistence, valid-visit icon semantics, weekly KST season rollover and rolling-window counts.
- [ ] Unit name cases, focused existing integration and browser tests; independent ak Codex review; commit own changes, push, deploy web2, verify real desktop/mobile and names/copy/two-line rendering.
- [ ] Update handoff, removal inventory/report and Obsidian journal.
