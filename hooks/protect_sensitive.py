#!/usr/bin/env python3
"""민감 파일·정보 접근을 차단하는 Guardrail Hook (PreToolUse)"""
import json, re, sys, os
from typing import Optional

ENV_FILE_PATTERN = r"(^|/)\.env(\.|$)"

SENSITIVE_FILE_PATTERNS = [
    r"(^|/)secrets?\b",        # secrets, secret.json
    r"(^|/)credentials?\b",    # credentials, credentials.json
    r"(^|/)private_key\b",     # private_key, private_key.pem
    r"\.pem$",
    r"\.p12$",
    r"\.pfx$",
]

SENSITIVE_BASH_PATTERNS = [
    (r"\bcat\s+[^\|]*\.env\b", "cat으로 .env 파일 내용을 출력하려 합니다"),
    (r"\bprintenv\b", "printenv로 환경변수 전체를 출력하려 합니다"),
    (r"\benv\b\s*$", "env 명령으로 환경변수 전체를 출력하려 합니다"),
    (r"curl\s+.+\|\s*(bash|sh)\b", "curl 파이프 실행은 원격 코드 실행 위험이 있습니다"),
    (r"wget\s+.+\|\s*(bash|sh)\b", "wget 파이프 실행은 원격 코드 실행 위험이 있습니다"),
    (r"\becho\s+\$[A-Z_]{4,}", "환경변수를 직접 echo로 출력하려 합니다"),
]

def is_sensitive_path(path: str) -> Optional[str]:
    name = os.path.basename(path)
    for pat in SENSITIVE_FILE_PATTERNS:
        if re.search(pat, path, re.IGNORECASE) or re.search(pat, name, re.IGNORECASE):
            return path
    return None


def is_env_file(path: str) -> bool:
    name = os.path.basename(path)
    return bool(
        re.search(ENV_FILE_PATTERN, path, re.IGNORECASE)
        or re.search(ENV_FILE_PATTERN, name, re.IGNORECASE)
    )

data = json.load(sys.stdin)
tool = data.get("tool_name", "")
inp = data.get("tool_input", {})

if tool == "Read":
    path = inp.get("file_path", "")
    if is_sensitive_path(path):
        print(f"[guardrail] 민감 파일 읽기 차단: {path}", file=sys.stderr)
        sys.exit(2)

if tool in ("Edit", "Write"):
    path = inp.get("file_path", "")
    if is_sensitive_path(path) or is_env_file(path):
        print(f"[guardrail] 민감 파일 수정 차단: {path}", file=sys.stderr)
        sys.exit(2)

if tool == "MultiEdit":
    for edit in inp.get("edits", []):
        path = edit.get("file_path", "")
        if is_sensitive_path(path) or is_env_file(path):
            print(f"[guardrail] 민감 파일 수정 차단: {path}", file=sys.stderr)
            sys.exit(2)

if tool == "Bash":
    cmd = inp.get("command", "")
    for pat, reason in SENSITIVE_BASH_PATTERNS:
        if re.search(pat, cmd, re.IGNORECASE):
            print(f"[guardrail] 차단됨: {reason}", file=sys.stderr)
            sys.exit(2)

sys.exit(0)
