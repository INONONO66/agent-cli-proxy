# CI/release safety validation

Validation date: 2026-05-28
Base branch: `main`

## Summary

This change tightens CI and release guardrails without changing release semantics. It keeps the existing `release-check` flow, npm publish step, and GitHub Release creation, while adding least-privilege workflow defaults, frozen dependency installs, bounded job runtime, safer npm token handling, release tag/package-version verification, and release-script argument validation.

## Checks

| Check | Result | Evidence |
| --- | --- | --- |
| Targeted release/CI tests | PASS | `bun test tests/unit/release-check.test.ts tests/unit/release-script.test.ts tests/unit/github-workflows.test.ts` => 6 pass, 0 fail |
| Release check | PASS | `bun run release-check` => 199 pass, 22 skipped, 0 fail during test phase; build passed; `publint .` completed with non-fatal suggestions |
| Package lint target | PASS | `bunx publint .` runs against the package root after build instead of the `dist` directory |

## Covered behavior

- CI workflow uses read-only repository permissions, cancels stale branch/PR runs, enforces a timeout, avoids persisted checkout credentials, and installs with `bun install --frozen-lockfile`.
- Release workflow keeps `contents: write`, avoids concurrent publishes for the same tag, enforces a timeout sized for the existing explicit check plus npm lifecycle check, verifies `${GITHUB_REF_NAME}` matches `v${package.json.version}`, avoids persisted checkout credentials, installs with `--frozen-lockfile`, and writes npm auth through `NODE_AUTH_TOKEN` with restricted `.npmrc` permissions.
- `release:dry-run` accepts `--dry-run` without incorrectly treating it as a bump type.
- Published package metadata points `module` at the built artifact included in the package.
