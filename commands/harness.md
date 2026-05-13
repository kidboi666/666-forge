---
description: GROUND/APPLY/VERIFY/ADAPT 4단계 직렬 하네스.
argument-hint: <task>
---

You are the harness orchestrator. Detailed phase behavior lives in the
respective sub-agents (`grounder`, `planner`, `applier`, `verifier`,
`adapter`). This file describes orchestration only.

Project policy: read `AGENTS.md` (if present), relevant `.claude/rules/*.md`,
and `.forge.json` (if present) before each phase. Do not duplicate or override
them.

## Input

`$ARGUMENTS` is the task. If empty, ask the user and stop.

## Core Rules

- Run all work serially. Never run agents concurrently. Never run Claude Code
  and Codex in parallel.
- Claude Code owns workflow and final synthesis. Codex is a bounded helper for
  read-only second opinions, convention review, narrow convention fixes, and
  adapt review. Every Codex delegation: start → wait → receive → synthesize.
- Do not expose raw Codex output to the user.
- All `state.json` mutations go through
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/set-harness-phase.mjs"`. Do not Edit/Write `state.json`
  by hand. Record delegation state via the same helper.
- Pass `--session-id` to helper scripts when known. Helper auto-selection is
  only valid when exactly one active session exists.
- Always invoke harness helper scripts with the plugin path
  (`node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs" ...`). Never use absolute paths or
  `--project-dir`. Absolute paths break allow patterns.
- The session directory and `state.json`/`failures.json` are created by
  `init-harness-session.mjs`. Do not run `mkdir`, `ls`, or any existence check
  against the session directory — `scope_guard.py` rejects them silently
  outside APPLY. Read/Write the paths directly.

## Project Config: `.forge.json` (optional)

The harness reads `<project-root>/.forge.json` if it exists. All fields are
optional:

```json
{
  "protected_paths": ["../sibling-repo"],
  "verify": {
    "typecheck": "pnpm typecheck",
    "test": "pnpm test:related"
  },
  "convention_focus": ["module direction", "logging conventions"]
}
```

- `protected_paths`: extra paths blocked from writes (relative to the project
  root or absolute). Applies to Edit/Write/MultiEdit, write-like Bash
  redirections, and the deletion helper.
- `verify.typecheck` / `verify.test`: exact commands the verifier runs. If
  omitted, `init-harness-session.mjs` tries to detect them from
  `package.json` scripts + the project's package manager. If still null, the
  verifier records "not declared" and skips that check.
- `convention_focus`: free-form hints fed to the convention gate prompt.

## Session Setup

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-harness-session.mjs" --task "<task>"
```

If the initializer reports existing active sessions, finish or close them
first (`--status stopped` via the helper). Use `--finalize-existing` only when
you intentionally abandon them.

The initializer creates `state.json` and `failures.json` only. Phase artefacts
(`ground.md`, `plan.md`, `apply.md`, `verify.md`, `adapt.md`) are created by
each phase agent on first Write — do not pre-touch or pre-Read them.

## Phase 1: GROUND — `grounder` agent

Input: task, project policy files, current diff, related code, and external
contract files only when the task involves them.

Output: `ground.md` (observed facts, inference, affected files, open
questions). Optional `codex-ground.md` for read-only Codex second opinion.

Advance condition: `ground.md` exists with the four sections above.

## Phase 2: APPLY — `planner` then `applier`

Planner writes `plan.md` with `allowed_files`, then sets state to APPLY +
waiting + planning + approval pending via `set-harness-phase.mjs`.

Present the plan summary to the user and wait. Offer at minimum:

- `[A] 계획대로 진행`
- `[B] 범위/방향 수정 후 다시 계획`
- `[C] GROUND 추가 조사`
- `[D] 중단`

On `[A]`: the orchestrator (this command driver — not the planner, not the
applier) flips approval:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/set-harness-phase.mjs" \
  --session-id "<session-id>" \
  --approval-status approved \
  --selected-option A
```

If the user already opted out of approval prompts, the planner records
`--approval-status auto_approved` and the orchestrator skips the flip.

Call the `applier` only after `state.json.approval.status` is `approved` or
`auto_approved`. The applier itself must not flip approval. Apply only the
approved plan, restricted to `allowed_files`.

Deletion: only via `node "${CLAUDE_PLUGIN_ROOT}/scripts/delete-allowed-files.mjs"`. Never
`rm`.

Codex write delegations are allowed only for narrow convention fixes with an
explicit write scope; wait for completion and inspect the diff before
continuing.

Advance condition: all changes inside `allowed_files`, approval is approved
or auto_approved, applier has flipped state to VERIFY.

## Phase 3: VERIFY — `verifier` agent + Codex convention gate

Run the typecheck and related-test commands declared in
`state.json.verify_commands`. If a command is null, record "not declared" in
`verify.md` — do not invent one.

Delegate Codex convention review serially (mandatory for app-level diffs;
skip only when the entire diff is data-only and the rationale is recorded in
`verify.md`). Synthesize results into a single `verify.md`. Claude Code owns
type/test failure interpretation and logic review; Codex owns convention-risk
detection.

Output: `verify.md`, `codex-convention-review.md` (unless explicitly skipped
with rationale), updated `failures.json` when anything fails.

Advance condition: PASS → final report. FAIL → ADAPT.

## Phase 4: ADAPT — `adapter` agent

Classify failures (convention, type, test, logic, API contract, scope) and
record cause + repetition count. Route convention failures to Codex
convention-fix candidates; route logic/API/design failures back to GROUND.
Change approach after the same cause fails twice. Ask the user for judgment
after the same cause fails three times.

Output: `adapt.md`, updated `failures.json`, updated `state.json`.

Advance condition: re-enter GROUND/APPLY with a changed approach, or stop for
user judgment.

## Session Finalization

Before printing the final report, flip the session status. Choose `completed`
for PASS, `stopped` for user abort or unrecoverable FAIL. This is mandatory:
the harness is not done until status is no longer `running` or `waiting`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/set-harness-phase.mjs" \
  --session-id "<session-id>" \
  --status completed
```

## Final Report

```markdown
## 하네스 결과

세션: <session-id>
판정: PASS / FAIL / 사용자 판단 필요

변경 요약:
- ...

검증:
- typecheck (<command or "not declared">): ...
- related tests (<command or "not declared">): ...
- Codex convention gate: ...

남은 위험:
- ...

세션 파일: <session-dir>
```

Do not expose raw Codex output.
