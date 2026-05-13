# 666-forge

Claude Code plugin: Harness workflow with GROUND / APPLY / VERIFY / ADAPT serial model and Codex delegation.

## Install

```bash
claude plugin marketplace add kidboi666/666-forge
claude plugin install forge@666-forge
```

## Commands

- `/forge:harness <task>` — full 4-phase harness
- `/forge:investigate <task>` — GROUND phase only (read-only investigation)
- `/forge:convention` — Codex convention review gate

## Project Config: `.forge.json` (optional)

Place `.forge.json` at the project root. All fields are optional.

```json
{
  "protected_paths": ["../sibling-repo"],
  "verify": {
    "typecheck": "pnpm typecheck",
    "test": "pnpm test:related"
  },
  "convention_focus": ["module dependency direction", "logging conventions"]
}
```

- `protected_paths`: extra paths blocked from writes (relative to project root or absolute). Applied by `scope_guard.py`, `delegate-codex.mjs` (convention-fix scope), and `delete-allowed-files.mjs`.
- `verify.typecheck` / `verify.test`: exact commands the verifier runs. Auto-detected from `package.json` scripts if omitted; recorded as null if neither config nor detection succeeds (verifier then reports "not declared").
- `convention_focus`: free-form hints fed to the convention review prompt. The reviewer also reads `AGENTS.md` and `.claude/rules/*.md`.

When `.forge.json` is absent, defaults are: no protected paths, auto-detected verify commands (best effort), and the convention reviewer relies solely on `AGENTS.md` / `.claude/rules/*.md`.

## Layout

```
.
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── commands/      # /forge:* slash commands
├── agents/        # grounder, planner, applier, verifier, adapter, convention-reviewer
├── hooks/         # PreToolUse / PostToolUse guards (hooks.json + python scripts)
└── scripts/       # node helpers (init-harness-session, set-harness-phase, delete-allowed-files, delegate-codex, load-forge-config)
```

## Session artefacts

The plugin writes session state to the **host project**'s `.agents/sessions/<session-id>/` directory. Plugin code itself is read-only at runtime.
