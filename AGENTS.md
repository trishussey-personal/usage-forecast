# CLAUDE.md

Project-level instructions for Claude Code, loaded at the start of every session in this folder. Four sections, four jobs: a compressed map of the workspace, the conventions Claude follows here, what Claude can already do here, and a log of what has been tried.

## Workspace map

A Claude Code mod (plugin) that draws three usage gauges: context window, 5-hour limit and weekly limit. Each gauge has filling boxes, a percentage, a green/yellow/red color, and a forecast of where usage will be at the next reset. It is TypeScript/TSX run by Claude Code's mod runtime, with no `package.json` and no build step.

- `.claude-plugin/plugin.json` — manifest, version, and `userConfig` settings (thresholds, glyphs, band, alerts). `marketplace.json` sets this repo up as its own marketplace.
- `hooks/hooks.json` — loads `hooks/register.tsx`.
- `hooks/register.tsx` — the hooks (`session.start`, `session.measure`, `ui.render` Pane and AbovePrompt) and the stored atoms. Change an atom's `shape` tag whenever its stored fields change.
- `hooks/gauge.ts` — the pure math: levels, pace, turns left, boxes, durations.
- `hooks/register.test.tsx` — tests, run with `claude plugin test .`.
- `types/index.d.ts` — the plugin's public types. `.claude-plugin/types/` is generated and ignored by git.
- `README.md` — the user-facing docs, including the settings table.

Fixed locations:
- `active/` — everything generated: scratch scripts, exports, intermediate output. Subfolders per task. Short-lived files go in `active/.tmp/`.
- `.env` — every key and credential. Referenced by variable name only.
- `.claude/` — project-local skills, agents, and settings.
- `AGENTS.md` — same content as this file, for non-Claude agents.

## Preferences & conventions

- Never write to the project root. Generated files, one-off scripts, and scratch output go in `active/` or a subfolder of it.
- Run commands yourself rather than handing them back to be pasted. The only exception is a command that needs credentials only the user holds.
- Never read, print, or echo the contents of `.env`. Refer to secrets by variable name. Never commit `.env`.
- Before installing a package you have not used in this project before, confirm it exists, is the intended package (not a near-miss name), and has a real history.
- After finishing any development pass, spawn a fresh QA reviewer with no project context (`tickety-boo:qa-reviewer`) before reporting done. Fix its blockers and should-fix items and re-run it; stop when only nits remain or after three rounds, and report anything still open.
- When you make a mistake, append one dated line to **Lab notes** below describing what not to try next time, written for a future instance of you.
- Whenever this file changes, `AGENTS.md` must match it (symlink, or re-sync). In a Claude Code plugin repo (`.claude-plugin/plugin.json` exists), keep it a plain copy, not a symlink: the plugin directory validator skips symlinks.
- Before calling a change done, run `claude plugin validate .` and `claude plugin test .`.
- When you add or change a setting in `plugin.json` `userConfig`, update the Settings table in `README.md` too.

## Capabilities

- `claude plugin validate .` / `claude plugin test .` — validate the manifest and run the tests.
- `claude --plugin-dir .` — load the mod from this clone without installing it.
- Default autonomy: for a well-scoped task, plan it, build it, validate it, and report back. Do not check in mid-task on implementation details that do not change the request's scope.

## Lab notes: what not to do

- 2026-10-25: (empty — first entry goes here)
