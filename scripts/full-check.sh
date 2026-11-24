#!/usr/bin/env bash
# The full check, with its real exit code (2026-11-24). Used in the same command as a commit, so a red run can't be
# followed by one:
#
#   scripts/full-check.sh /path/to/log && git commit -m "…"
#
# Every step must pass; the first that fails ends the run, and its code is the script's. The log has everything.
set -o pipefail
log="${1:?give a log file}"
{
  npm run build:demo &&
    npm run typecheck &&
    npm test &&
    npm run security:semgrep &&
    semgrep scan --config auto --error --timeout 0 packages
} >"$log" 2>&1
code=$?
echo "EXIT $code" >>"$log"
grep -E "Tests  |findings" "$log" | tail -3
echo "full check: exit $code"
exit "$code"
