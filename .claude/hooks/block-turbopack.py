#!/usr/bin/env python3
"""Block Next.js runs that would use Turbopack.

Turbopack's Apple Silicon binaries leak non-reclaimable MAP_JIT memory
(vercel/next.js#92052) and caused three kernel panics on this Mac on 2026-07-24.
Exit 2 blocks the tool call and returns stderr to Claude.
"""
import json
import re
import sys

try:
    cmd = json.load(sys.stdin).get("tool_input", {}).get("command") or ""
except (json.JSONDecodeError, TypeError, AttributeError):
    sys.exit(0)  # malformed payload: never block on it

if not isinstance(cmd, str):
    sys.exit(0)

# ponytail: substring match on the raw command. Catches direct `next dev/build`,
# pinned forms like `npx next@latest dev`, and any --turbo flag. It cannot see
# inside `npm run dev`, which is why package.json scripts keep --webpack and
# CLAUDE.md says not to remove it.
banned = "--turbo" in cmd or (
    re.search(r"\bnext(@[\w.^~*-]+)?\s+(dev|build)\b", cmd) and "--webpack" not in cmd
)

if banned:
    print(
        "Blocked: Turbopack leaks MAP_JIT memory on this Mac and has caused "
        "kernel panics (next.js#92052). Re-run with --webpack, e.g. "
        "`next dev --webpack` or `next build --webpack`.",
        file=sys.stderr,
    )
    sys.exit(2)
