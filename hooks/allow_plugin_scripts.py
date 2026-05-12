#!/usr/bin/env python3
"""PreToolUse hook: auto-allow Bash calls to this plugin's own scripts.

Claude Code's permission matcher compares allow-rule strings literally and
does not expand ${CLAUDE_PLUGIN_ROOT}. As a result, marketplace users hit a
permission prompt every time the harness runs one of the plugin's helper
scripts. This hook short-circuits that prompt by emitting an "allow"
permissionDecision for commands that invoke our own script files.
"""

from __future__ import annotations

import json
import os
import re
import sys

PLUGIN_SCRIPTS = (
    "set-harness-phase.mjs",
    "init-harness-session.mjs",
    "delegate-codex.mjs",
    "delete-allowed-files.mjs",
)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    if payload.get("tool_name") != "Bash":
        return 0

    command = (payload.get("tool_input") or {}).get("command")
    if not isinstance(command, str) or not command:
        return 0

    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if not plugin_root:
        return 0

    scripts_dir = os.path.join(plugin_root, "scripts")
    # Match `node "<scripts_dir>/<name>.mjs"` or `node <scripts_dir>/<name>.mjs`
    # at the start of the command (allowing leading whitespace).
    quoted = re.escape(scripts_dir)
    name_alt = "|".join(re.escape(name) for name in PLUGIN_SCRIPTS)
    pattern = rf'^\s*node\s+"?{quoted}/({name_alt})"?(\s|$)'

    if not re.match(pattern, command):
        return 0

    decision = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": "forge plugin script auto-allow",
        }
    }
    json.dump(decision, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
