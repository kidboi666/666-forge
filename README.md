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

## Layout

```
.
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── commands/      # /forge:* slash commands
├── agents/        # grounder, planner, applier, verifier, adapter, convention-reviewer
├── hooks/         # PreToolUse / PostToolUse guards (hooks.json + 5 python scripts)
└── scripts/       # node helpers (init-harness-session, set-harness-phase, delete-allowed-files, delegate-codex)
```

## Session artefacts

The plugin writes session state to the **host project**'s `.agents/sessions/<session-id>/` directory. Plugin code itself is read-only at runtime.
