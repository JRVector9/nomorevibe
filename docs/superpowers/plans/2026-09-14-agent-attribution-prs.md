# Agent attribution implementation PRs

Goal: strengthen inspectable contribution claims without claiming AI execution or overwriting maker reports.

## PR 1 — feat/agent-evidence-policy (base main)
- [x] Model configs, instructions and committer-only attribution cannot satisfy the development evidence rule.
- [x] Bump REVIEW_RULES_VERSION to invalidate reused approvals.
- [x] Unit89/integration11, typegen+TSC/lint. Read-only independent review before PR.

## PR 2 — feat/agent-commit-evidence (base PR 1)
- [x] Store bounded commit change evidence and attribution basis; accept Aider author vs committer metadata with distinct roles.
- [x] Verify actual changed paths in requested scope and branch ancestry; do not promote missing/truncated evidence or copied fork ancestry. Existing discovery budget retained; no full-history expansion.
- [x] Version detector, regression fixtures for files absent, unrelated scope, docs-only, Aider roles, fork and malformed response; persistence roundtrip.

## PR 3 — feat/agent-attribution-audit (base PR 2)
- [x] Read-only paginated audit of published products; latest scan, fresh/partial/missing, source-bound claims, separate maker declaration.
- [x] Deterministic counts and original URLs; settings excluded from contribution counts, no execution certainty or made-up accuracy.
- [x] Fixture integration tests and documented invocation/output; no automatic production mutation or public-column restoration.

All three PRs are stacked and must be reviewed/merged in order. Request scope is implementation and PR creation, not merge/deploy. Preserve original main worktree Hero/design changes. No live DB/schema/settings changes. Source docs: docs/operations/2026-09-14-release-evidence.md; official Aider git attribution documentation linked there.

Created: [#110](https://github.com/JRVector9/nomorevibe/pull/110) → [#111](https://github.com/JRVector9/nomorevibe/pull/111) → [#112](https://github.com/JRVector9/nomorevibe/pull/112). Independent reviews CLEAN after fixes. See operations report for actual executed tests and limitations.
