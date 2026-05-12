#!/usr/bin/env python3
"""Repo write scope guard for Claude hooks.

This hook blocks writes outside the mobile repository and writes into
../rx-api-server. It does not orchestrate harness phases or run checks.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

WRITE_TOOLS = {"Edit", "Write", "MultiEdit"}
ACTIVE_STATUSES = {"running", "waiting"}
APPROVED_STATUSES = {"approved", "auto_approved"}
SENSITIVE_WRITE_PATTERNS = [
    r"(^|/)\.env(\.|$)",
    r"(^|/)secrets?\b",
    r"(^|/)credentials?\b",
    r"(^|/)private_key\b",
    r"\.pem$",
    r"\.p12$",
    r"\.pfx$",
]


def project_root(data: dict) -> Path:
    raw = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    return Path(raw).resolve()


def input_paths(tool: str, inp: dict) -> list[str]:
    if tool in {"Edit", "Write"}:
        return [inp.get("file_path", "")]
    if tool == "MultiEdit":
        paths = []
        if inp.get("file_path"):
            paths.append(inp.get("file_path", ""))
        for edit in inp.get("edits", []):
            if edit.get("file_path"):
                paths.append(edit.get("file_path", ""))
        return paths
    return []


def is_sensitive(path: str) -> bool:
    name = os.path.basename(path)
    return any(
        re.search(pattern, path, re.IGNORECASE) or re.search(pattern, name, re.IGNORECASE)
        for pattern in SENSITIVE_WRITE_PATTERNS
    )


def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def latest_state(root: Path) -> tuple[dict | None, str | None]:
    sessions_root = root / ".agents" / "sessions"
    if not sessions_root.exists():
        return None, None

    candidates = []
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
        return None, None
    if len(candidates) > 1:
        active = ", ".join(str(candidate[0]) for candidate in candidates)
        return None, f"Multiple active harness sessions found; finish one before running write-like Bash: {active}"

    candidates.sort(key=lambda item: item[2], reverse=True)
    return candidates[0][1], None


def is_harness_helper(command: str) -> bool:
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT", "")
    if plugin_root:
        allowed_prefixes = tuple(
            f'node "{plugin_root}/scripts/{name}.mjs" '
            for name in [
                "init-harness-session",
                "set-harness-phase",
                "delegate-codex",
                "delete-allowed-files",
            ]
        )
        # 쌍따옴표 없는 형태도 허용 (호출 방식 혼용 대비)
        allowed_prefixes_noquote = tuple(
            f"node {plugin_root}/scripts/{name}.mjs "
            for name in [
                "init-harness-session",
                "set-harness-phase",
                "delegate-codex",
                "delete-allowed-files",
            ]
        )
        return command.startswith(allowed_prefixes) or command.startswith(allowed_prefixes_noquote)
    # CLAUDE_PLUGIN_ROOT 미설정 폴백 (개발 중 직접 실행 등)
    fallback_prefixes = (
        "node .claude/scripts/init-harness-session.mjs ",
        "node .claude/scripts/set-harness-phase.mjs ",
        "node .claude/scripts/delegate-codex.mjs ",
        "node .claude/scripts/delete-allowed-files.mjs ",
    )
    return command.startswith(fallback_prefixes)


WRITE_LIKE_BASH_PATTERNS = [
    (
        r"(^|\s)(>|>>)\s*[^&\s]",
        "shell redirection (>, >>)",
        "Write 또는 Edit 도구로 파일을 갱신하세요.",
    ),
    (
        r"\b(cp|mv|tee|touch|mkdir|rm|trash)\b",
        "파일 시스템 변경 명령 (cp/mv/tee/touch/mkdir/rm/trash)",
        "Write/Edit 도구나 set-harness-phase.mjs 같은 헬퍼 스크립트를 사용하세요.",
    ),
    (
        r"\b(git\s+rm|git\s+mv)\b",
        "git rm/mv",
        "Edit/Write로 파일을 갱신한 뒤 일반 git add를 사용하세요.",
    ),
    (
        r"\b(sed|perl)\s+[^;&|]*\s-i\b",
        "in-place sed/perl",
        "Edit 도구로 파일을 수정하세요.",
    ),
    (
        r"\bpython3?\s+-c\b",
        "python -c inline 실행",
        "스크립트를 파일로 만들어 Write/Edit로 관리하세요.",
    ),
    (
        r"\bnode\s+-e\b",
        "node -e inline 실행",
        "스크립트를 파일로 만들어 Write/Edit로 관리하세요.",
    ),
    (
        r"\bnode\s+-\b",
        "node stdin 실행",
        "스크립트를 파일로 만들어 Write/Edit로 관리하세요.",
    ),
    (
        r"\bprettier\b[^;&|]*\s--write\b",
        "prettier --write",
        "포맷 변경이 의도된 경우에만 pnpm format을 수동 실행하세요.",
    ),
    (
        r"\bpnpm\s+(format|.*\sformat)\b",
        "pnpm format",
        "포맷 변경이 의도된 경우에만 수동 실행하세요.",
    ),
]


def matched_write_like_bash(command: str) -> dict | None:
    for pattern, name, alternative in WRITE_LIKE_BASH_PATTERNS:
        if re.search(pattern, command):
            return {"name": name, "alternative": alternative}
    return None


data = json.load(sys.stdin)
tool = data.get("tool_name", "")
inp = data.get("tool_input", {})
root = project_root(data)
server_root = root.parent / "rx-api-server"

if tool in WRITE_TOOLS:
    for raw_path in input_paths(tool, inp):
        if not raw_path:
            continue
        path = Path(raw_path)
        resolved = (root / path).resolve() if not path.is_absolute() else path.resolve()

        if is_sensitive(str(resolved)):
            print(f"[scope_guard] 민감 경로 쓰기 차단: {resolved}", file=sys.stderr)
            sys.exit(2)
        if is_inside(resolved, server_root.resolve()):
            print(f"[scope_guard] 서버 레포 쓰기 차단: {resolved}", file=sys.stderr)
            sys.exit(2)
        forge_root = Path(os.environ.get("CLAUDE_PLUGIN_ROOT") or "/Users/leejinwook/prismx/forge").resolve()
        if not is_inside(resolved, root) and not is_inside(resolved, forge_root):
            print(f"[scope_guard] 모바일 레포 밖 쓰기 차단: {resolved}", file=sys.stderr)
            sys.exit(2)

if tool == "Bash":
    command = inp.get("command", "")
    if re.search(r"(^|\s)(>|>>)\s*(\.\./rx-api-server|/Users/.*/rx-api-server)", command):
        print("[scope_guard] 서버 레포로 redirection 쓰기 차단", file=sys.stderr)
        sys.exit(2)
    matched = matched_write_like_bash(command)
    if matched and not is_harness_helper(command):
        state, state_error = latest_state(root)
        if state_error:
            print(f"[scope_guard] {state_error}", file=sys.stderr)
            sys.exit(2)
        if state:
            approved = (state.get("approval") or {}).get("status") in APPROVED_STATUSES
            can_write = (
                state.get("phase") == "APPLY"
                and state.get("status") == "running"
                and approved
            )
            if not can_write:
                print(
                    f"[scope_guard] 차단됨: {matched['name']}\n"
                    f"  사유: 쓰기성 Bash는 승인된 APPLY running 단계 밖에서 사용할 수 없습니다.\n"
                    f"  대신: {matched['alternative']}",
                    file=sys.stderr,
                )
                sys.exit(2)
        print(
            f"[scope_guard] 차단됨: {matched['name']}\n"
            f"  사유: 쓰기성 Bash는 Edit/Write/MultiEdit의 audit trail 밖에서 파일을 수정합니다.\n"
            f"  대신: {matched['alternative']}",
            file=sys.stderr,
        )
        sys.exit(2)

sys.exit(0)
