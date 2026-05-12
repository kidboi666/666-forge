---
description: GROUND 단계만 실행해 코드 수정 없이 사실 기반 원인 조사를 수행.
argument-hint: <task>
---

GROUND-only investigation command. Creates a new harness session, runs the
`grounder` agent, and stops after GROUND. Does not edit app code.

## Input

`$ARGUMENTS` is the task or problem statement. If empty, ask the user for the
task and stop.

## Read

- `AGENTS.md`
- relevant `.claude/rules/*.md`
- current git diff
- related code
- `../rx-api-server` contract files only when the task involves API integration

## Session Setup

Create a session directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-harness-session.mjs" --task "<task>"
```

If the initializer reports existing active sessions, finish or close them first
(`--status stopped` via the helper) before retrying.

All `state.json` mutations go through
`node "${CLAUDE_PLUGIN_ROOT}/scripts/set-harness-phase.mjs"`. Do not Edit/Write `state.json` by
hand.

## Work

Use the `grounder` agent.

- Read first.
- Separate observed facts from inference.
- Identify affected files and uncertainty.
- If helpful, delegate a read-only Codex second opinion:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/delegate-codex.mjs" \
    --mode read-only \
    --session-id "<session-id>" \
    --prompt-file "<prompt-file>"
  ```

  Wait for completion, then synthesize the result into `ground.md`.

## Rules

- Do not edit app code.
- Do not modify `../rx-api-server`.
- Do not invent API endpoints, fields, enum values, or response shapes.
- Do not expose raw Codex output.
- Stop after GROUND. Do not advance to APPLY.

## Output

- `<session-dir>/state.json`
- `<session-dir>/ground.md`
- optional `<session-dir>/codex-ground.md`
