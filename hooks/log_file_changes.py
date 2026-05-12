#!/usr/bin/env python3
"""파일 변경을 JSONL로 기록하는 Audit Hook (PostToolUse)"""
from __future__ import annotations

import json, sys, os
from datetime import datetime, timezone
from pathlib import Path

data = json.load(sys.stdin)
tool = data.get("tool_name", "")

if tool not in ("Edit", "Write", "MultiEdit"):
    sys.exit(0)

inp = data.get("tool_input", {})
resp = data.get("tool_response", {}) or {}
session_id = data.get("session_id", "")
cwd = data.get("cwd", os.getcwd())
project = os.path.basename(cwd)
phase = os.environ.get("HARNESS_PHASE", "")

ACTIVE_STATUSES = {"running", "waiting"}


def latest_harness_phase() -> str:
    if phase:
        return phase
    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or cwd)
    sessions_root = root / ".agents" / "sessions"
    if not sessions_root.exists():
        return ""

    candidates: list[tuple[Path, dict, float]] = []
    for path in sessions_root.iterdir():
        if not path.is_dir() or path.name == "manual":
            continue
        state_path = path / "state.json"
        if not state_path.exists():
            continue
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if state.get("status") in ACTIVE_STATUSES:
            candidates.append((path, state, path.stat().st_mtime))

    if not candidates:
        return ""

    candidates.sort(key=lambda item: item[2], reverse=True)
    return candidates[0][1].get("phase", "")

# tool_response에서 에러 여부 판단 (is_error 또는 error 키 존재 시 실패)
ok = not (resp.get("is_error") or resp.get("error"))

def make_entry(file_path: str) -> dict:
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "session": session_id,
        "tool": tool,
        "cwd": cwd,
        "file": file_path,
        "project": project,
        "harness_phase": latest_harness_phase(),
        "ok": ok,
    }

entries = []
if tool in ("Edit", "Write"):
    entries.append(make_entry(inp.get("file_path", "")))
elif tool == "MultiEdit":
    if inp.get("file_path"):
        entries.append(make_entry(inp.get("file_path", "")))
    else:
        for edit in inp.get("edits", []):
            entries.append(make_entry(edit.get("file_path", "")))

log_dir = Path(os.environ.get("CLAUDE_PROJECT_DIR") or cwd) / ".agents" / "logs"
log_dir.mkdir(parents=True, exist_ok=True)
with open(log_dir / "file-changes.jsonl", "a", encoding="utf-8") as f:
    for entry in entries:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

sys.exit(0)
