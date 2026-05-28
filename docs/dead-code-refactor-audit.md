# Dead Code Refactor Audit

This note records the evidence for the internal cleanup in this change.

## Removed internal modules

The following source files had no inbound references from `src/`, `tests/`, `scripts/`, or public docs and are not part of the published package entry points:

- `src/provider/anthropic/adapter.ts`
- `src/provider/openai/adapter.ts`
- `src/server/log-usage.ts`
- `src/server/request-context.ts`

The placeholder `pi` agent plugin was also removed because its matcher always returned `false` and no supported tool documentation referenced it:

- `src/agent-plugins/pi.ts`

## Refactor-only cleanup

TypeScript unused-symbol checks identified dashboard-only unused imports/variables. These were removed without changing runtime behavior.

## Validation

- `rg` reference checks for removed symbols and files
- `bunx tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false`
- Targeted agent-plugin, lifecycle, and readiness tests
