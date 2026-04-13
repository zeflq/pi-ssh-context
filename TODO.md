# TODO

## Refactor `loadProjectContextFiles` (single responsibility)

- [x] Extract the walk-up logic into a new `walkUpContextFiles(fs, cwd)` — no `agentDir` param, just walks cwd → root collecting `AGENTS.md`/`CLAUDE.md`
- [x] Keep `loadProjectContextFiles(fs, cwd, agentDir)` as a thin composer: global agentDir check + `walkUpContextFiles(fs, cwd)`

## Fix `context-graph`

- [x] Replace `findAgentsDir` + `findRootFile` + `loadRootFile` calls with `walkUpContextFiles(fs, cwd)` — gets all files, uppercase, with correct search order (dir → `.pi` → `.claude` → `.agents`), no global fallback
- [x] Update link-following loop to iterate over **all** collected files (not just a single root), following markdown links from each
- [x] Delete the `findAgentsDir` / `findRootFile` imports from context-graph (dead after above)

## Cleanup

- [x] Check if `findAgentsDir` and `findRootFile` are used anywhere else; if not, remove them from `loader.ts` — kept: both are exported and tested
- [x] Check if `ROOT_FILE_LOWER = "agents.md"` and its case-insensitive matching logic in `loader.ts` becomes dead code — kept: still used by `findAgentsDir` / `findRootFile`
- [x] Fix stale test: `.agent` → `.agents` to match `CONFIG_DIR_NAMES`
