#!/usr/bin/env python3
"""원격/공유 상태를 파괴하는 명령만 차단하는 Safety Hook

로컬 되돌리기 가능한 명령(rm, git branch -D 등)은 permissions.deny/allow 에 맡긴다.
"""
import json, re, sys

BLOCKED_PATTERNS = [
    (r"git\s+push\s+.*(--force\b|--force-with-lease\b|-f\b)",
     "git push --force 는 원격 히스토리를 덮어씁니다"),
    (r"git\s+reset\s+--hard\s+(origin|upstream)/",
     "원격 기준 git reset --hard 는 공유 히스토리를 파괴합니다"),
    (r"\bDROP\s+(DATABASE|TABLE|SCHEMA)\b",
     "DROP 은 데이터를 영구 삭제합니다"),
    (r"\bTRUNCATE\s+TABLE\b",
     "TRUNCATE 는 모든 데이터를 삭제합니다"),
    (r"\brm\s+-[rRfF]+\s+(/|~|\$HOME|\$\{HOME\}|/Users|/System)(\s|/|$)",
     "루트/홈 디렉토리 rm -rf 는 시스템을 파괴합니다"),
    (r"\bcurl\s+.+\|\s*(bash|sh)\b",
     "curl 파이프 실행은 원격 코드 실행 위험이 있습니다"),
    (r"\bwget\s+.+\|\s*(bash|sh)\b",
     "wget 파이프 실행은 원격 코드 실행 위험이 있습니다"),
]

data = json.load(sys.stdin)
if data.get("tool_name") != "Bash":
    sys.exit(0)

command = data.get("tool_input", {}).get("command", "")
for pattern, reason in BLOCKED_PATTERNS:
    if re.search(pattern, command, re.IGNORECASE):
        print(f"차단됨: {reason}", file=sys.stderr)
        sys.exit(2)

sys.exit(0)
