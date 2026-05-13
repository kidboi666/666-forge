#!/usr/bin/env python3
"""Repo write scope guard for Claude hooks.

This hook blocks writes outside the project root and into any path listed in
``.forge.json`` -> ``protected_paths``. It does not orchestrate harness
phases or run checks.
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


def load_forge_config(root: Path) -> dict:
    config_path = root / ".forge.json"
    if not config_path.exists():
        return {}
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as error:
        print(f"[scope_guard] .forge.json 파싱 실패: {error}", file=sys.stderr)
        return {}


def protected_paths(root: Path, config: dict) -> list[Path]:
    raw = config.get("protected_paths") or []
    if not isinstance(raw, list):
        return []
    resolved: list[Path] = []
    for entry in raw:
        if not isinstance(entry, str) or not entry.strip():
            continue
        candidate = Path(entry)
        if not candidate.is_absolute():
            candidate = (root / candidate).resolve()
        else:
            candidate = candidate.resolve()
        resolved.append(candidate)
    return resolved


def detect_package_manager(root: Path) -> str | None:
    if (root / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (root / "yarn.lock").exists():
        return "yarn"
    if (root / "bun.lockb").exists() or (root / "bun.lock").exists():
        return "bun"
    if (root / "package-lock.json").exists():
        return "npm"
    return None


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
    helper_names = [
        "init-harness-session",
        "set-harness-phase",
        "delegate-codex",
        "delete-allowed-files",
    ]
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT", "")
    prefixes: list[str] = []
    if plugin_root:
        for name in helper_names:
            prefixes.append(f'node "{plugin_root}/scripts/{name}.mjs" ')
            prefixes.append(f"node {plugin_root}/scripts/{name}.mjs ")
    # 플러그인 캐시 외 경로에서 직접 실행하는 개발자 시나리오
    for name in helper_names:
        prefixes.append(f"node .claude/scripts/{name}.mjs ")
    return any(command.startswith(prefix) for prefix in prefixes)


def write_like_bash_patterns(package_manager: str | None) -> list[tuple[str, str, str]]:
    pm_label = package_manager or "your package manager"
    patterns: list[tuple[str, str, str]] = [
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
            f"포맷 변경이 의도된 경우에만 {pm_label} format을 수동 실행하세요.",
        ),
    ]
    if package_manager:
        patterns.append(
            (
                rf"\b{re.escape(package_manager)}\s+(format|.*\sformat)\b",
                f"{package_manager} format",
                "포맷 변경이 의도된 경우에만 수동 실행하세요.",
            )
        )
    return patterns


def matched_write_like_bash(command: str, patterns: list[tuple[str, str, str]]) -> dict | None:
    for pattern, name, alternative in patterns:
        if re.search(pattern, command):
            return {"name": name, "alternative": alternative}
    return None


data = json.load(sys.stdin)
tool = data.get("tool_name", "")
inp = data.get("tool_input", {})
root = project_root(data)
forge_config = load_forge_config(root)
protected_roots = protected_paths(root, forge_config)
package_manager = detect_package_manager(root)
plugin_root_env = os.environ.get("CLAUDE_PLUGIN_ROOT")
plugin_root = Path(plugin_root_env).resolve() if plugin_root_env else None

if tool in WRITE_TOOLS:
    for raw_path in input_paths(tool, inp):
        if not raw_path:
            continue
        path = Path(raw_path)
        resolved = (root / path).resolve() if not path.is_absolute() else path.resolve()

        if is_sensitive(str(resolved)):
            print(f"[scope_guard] 민감 경로 쓰기 차단: {resolved}", file=sys.stderr)
            sys.exit(2)
        blocked_by_protected = next(
            (protected for protected in protected_roots if is_inside(resolved, protected)),
            None,
        )
        if blocked_by_protected is not None:
            print(
                f"[scope_guard] 보호 경로 쓰기 차단 ({blocked_by_protected}): {resolved}",
                file=sys.stderr,
            )
            sys.exit(2)
        inside_project = is_inside(resolved, root)
        inside_plugin = plugin_root is not None and is_inside(resolved, plugin_root)
        if not inside_project and not inside_plugin:
            print(f"[scope_guard] 프로젝트 루트 밖 쓰기 차단: {resolved}", file=sys.stderr)
            sys.exit(2)

if tool == "Bash":
    command = inp.get("command", "")
    for protected in protected_roots:
        protected_str = str(protected)
        if re.search(
            rf"(^|\s)(>|>>)\s*({re.escape(protected_str)}|\.\./{re.escape(protected.name)})",
            command,
        ):
            print(
                f"[scope_guard] 보호 경로로 redirection 쓰기 차단: {protected}",
                file=sys.stderr,
            )
            sys.exit(2)
    patterns = write_like_bash_patterns(package_manager)
    matched = matched_write_like_bash(command, patterns)
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
