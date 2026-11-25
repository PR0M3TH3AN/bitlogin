#!/bin/sh
# One heavy run at a time on this machine: a gate, a browser trial, a full check, a big build, from any project
# (fleet rule 14, NSWP docs/fleet.md; NSWP's scripts/heavy.sh at 52e0629 is the reference text).
#
#   sh scripts/heavy.sh <command...>
#
# Several sessions share one laptop. Runs made at the same time slowed each other until browser tests timed out and
# everything was run again (2026-11-24). Each heavy run takes this one lock first and waits its turn. The lock is the
# machine's, not this repository's: BitPortal, BitLogin, BitBrowser and NSWP take the same file, so the contract is
# only the file's path and the variable below.
#
# A run started inside one that holds it goes straight on: the variable says the lock is held already, so nothing
# waits for itself. Waiting more than an hour, it gives up with 75, and says so.
if [ -n "$BITBLOCKS_HEAVY_HELD" ]; then exec "$@"; fi
LOCK="${BITBLOCKS_HEAVY_LOCK:-$HOME/.cache/bitblocks-heavy.lock}"
WAIT="${BITBLOCKS_HEAVY_WAIT:-3600}"
mkdir -p "$(dirname "$LOCK")"
export BITBLOCKS_HEAVY_HELD=1
if ! flock -n "$LOCK" true 2>/dev/null; then
  echo "heavy run: waiting for another heavy run on this machine to finish (lock $LOCK, at most ${WAIT}s)" >&2
fi
flock -w "$WAIT" -E 75 "$LOCK" "$@"
code=$?
if [ "$code" -eq 75 ]; then echo "heavy run: gave up after ${WAIT}s waiting for the lock: nothing was run" >&2; fi
exit "$code"
