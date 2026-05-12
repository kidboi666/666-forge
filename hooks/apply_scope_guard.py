#!/usr/bin/env python3
"""Allowed-files guard for the APPLY phase and Harness artefact location enforcer.

1. Blocks Edit/Write/MultiEdit calls outside state.json allowed_files during APPLY phase.
2. Enforces that harness artefacts (ground.md, plan.md, etc.) are only created inside .claude/sessions/.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

WRITE_TOOLS = {"Edit", "Write", "MultiEdit"}
HARNESS_ARTEFACTS = {
    "state.json",
    "ground.md",
    "plan.md",
    "apply.md",
    "verify.md",
    "adapt.md",
    "failures.json",
    "codex-output.md",
    "codex-ground.md",
    "codex-convention-review.md"
}


def project_root(data: dict) -> Path:
    raw = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    return Path(raw).resolve()


ACTIVE_STATUSES = {"running", "waiting"}
APPROVED_STATUSES = {"approved", "auto_approved"}


def latest_state(root: Path) -> tuple[Path | None, dict | None, str | None]:
    sessions_root = root / ".agents" / "sessions"
    if not sessions_root.exists():
        return None, None, None

    candidates: list[tuple[Path, dict, float]] = []
    for path in sessions_root.iterdir():
        if not path.is_dir() or path.name == "manual":
            continue
        state_path = path / "state.json"
        if not state_path.exists():
            continue
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if data.get("status") in ACTIVE_STATUSES:
            candidates.append((state_path, data, path.stat().st_mtime))

    if not candidates:
        return None, None, None
    if len(candidates) > 1:
        active = ", ".join(str(candidate[0]) for candidate in candidates)
        return None, None, f"Multiple active harness sessions found; finish one or pass explicit session in workflow: {active}"

    candidates.sort(key=lambda item: item[2], reverse=True)
    state_path, data, _ = candidates[0]
    return state_path, data, None


def input_paths(tool: str, inp: dict) -> list[str]:
    paths = []
    if tool in {"Edit", "Write"}:
        paths.append(inp.get("file_path", ""))
    elif tool == "MultiEdit":
        if inp.get("file_path"):
            paths.append(inp.get("file_path", ""))
        for edit in inp.get("edits", []):
            if edit.get("file_path"):
                paths.append(edit.get("file_path", ""))
    return [p for p in paths if p]


def rel_path(root: Path, raw_path: str) -> str | None:
    path = Path(raw_path)
    try:
        if path.is_absolute():
            return str(path.resolve().relative_to(root))
        return str((root / path).resolve().relative_to(root))
    except ValueError:
        return None


data = json.load(sys.stdin)
tool = data.get("tool_name", "")
if tool not in WRITE_TOOLS:
    sys.exit(0)

root = project_root(data)
tool_input = data.get("tool_input", {})
targets = input_paths(tool, tool_input)

# 1. Harness Artefact Location Enforcement
for raw_path in targets:
    name = Path(raw_path).name
    if name in HARNESS_ARTEFACTS:
        relative = rel_path(root, raw_path)
        # Block if the file is being written to the root or anywhere except .claude/sessions/
        if relative and not relative.startswith(".agents/sessions/"):
            print(f"[harness_guard] 하네스 부산물은 .agents/sessions/ 내부에만 생성 가능합니다: {raw_path}", file=sys.stderr)
            sys.exit(2)
        if name == "state.json":
            print("[harness_guard] state.json은 set-harness-phase.mjs로만 갱신할 수 있습니다", file=sys.stderr)
            sys.exit(2)

# 2. APPLY Phase Scope Guard
state_path, state, state_error = latest_state(root)

for raw_path in targets:
    relative = rel_path(root, raw_path)
    # 하네스 세션 디렉토리 내부 쓰기는 multi-active 상황에서도 통과시킨다.
    # state.json 직접 수정은 위 harness_guard 단계에서 이미 차단됨.
    if not relative or relative.startswith(".agents/sessions/"):
        continue

    if state_error:
        print(f"[apply_scope_guard] {state_error}", file=sys.stderr)
        sys.exit(2)

    if not state:
        continue

    approved = (state.get("approval") or {}).get("status") in APPROVED_STATUSES
    can_edit_app_code = (
        state.get("phase") == "APPLY"
        and state.get("status") == "running"
        and approved
    )
    if not can_edit_app_code:
        print(f"[apply_scope_guard] 앱 코드는 승인된 APPLY running 단계에서만 수정 가능합니다: {raw_path}", file=sys.stderr)
        sys.exit(2)

    allowed = set(state.get("allowed_files") or [])
    if not allowed:
        print(f"[apply_scope_guard] APPLY phase has no allowed_files in {state_path}", file=sys.stderr)
        sys.exit(2)

    if relative not in allowed:
        print(f"[apply_scope_guard] allowed_files 밖 수정 차단: {raw_path}", file=sys.stderr)
        sys.exit(2)

sys.exit(0)
