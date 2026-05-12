---
description: Codex 컨벤션 게이트만 직렬 실행.
argument-hint: <session-id>
---

Run only the Codex convention gate for an existing harness session.

## Input

`$ARGUMENTS` is the session id. If empty, use the latest active harness session.
If no active session exists, ask the user and stop.

## Read

- `AGENTS.md`
- relevant `.claude/rules/*.md`
- `<session-dir>/plan.md`
- current git diff

## Work

Delegate the convention review serially:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-codex.mjs" \
  --mode convention-review \
  --session-id "<session-id>" \
  --prompt-file "<prompt-file>"
```

The script writes to `<session-dir>/codex-convention-review.md` by default and
records delegation state in `state.json`. All other `state.json` mutations go
through `node "${CLAUDE_PLUGIN_ROOT}/scripts/set-harness-phase.mjs"`. Do not Edit/Write
`state.json` by hand.

## Rules

- Serial only.
- Wait for the result before showing anything to the user.
- Synthesize the result; do not expose raw Codex output.
- Do not fix code in this command.

## Output

- `<session-dir>/codex-convention-review.md`
