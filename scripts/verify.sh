#!/usr/bin/env bash
#
# The gate-all from spec §7. One script, three callers:
#
#   pnpm verify            — humans and agents, from anywhere in the repo
#   .githooks/pre-commit   — every commit (§7: "Agents cannot skip it")
#   .github/workflows/verify.yml — every push and PR
#
# All three run *the same steps in the same order*, which is the point: a green commit
# hook is evidence about CI, not a different check that happens to be nearby.
#
# Behaviour:
#   - Streams output live (so a slow test suite does not look hung) *and* tees it to a
#     log, so a failure can be summarised at the end. Under `git commit` the useful
#     lines otherwise scroll away above the editor.
#   - Stops at the first failing step. Later steps would only be noise.
#   - Exits non-zero on any failure. Nothing here ever "warns".
#
# Env:
#   VERIFY_TAIL=n   lines of the failing step to re-print at the end (default 40, 0 = off)
#   VERIFY_LOG=path where to write the full log (default a mktemp file, path printed)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAIL_LINES="${VERIFY_TAIL:-40}"
# Portable across macOS and GNU mktemp (bare `-t` behaves differently on each).
LOG="${VERIFY_LOG:-$(mktemp "${TMPDIR:-/tmp}/rematch-verify.XXXXXX")}"
: >"$LOG"

# The ordered gate list. Cheapest and most-likely-to-fail first: a type error or a
# forbidden `Date.now` should not wait ~45 s behind the test suite to be reported.
#
# `lint` is second rather than first because typecheck catches the broader class of
# mistake; both are seconds, so the order is about signal, not speed.
STEPS=(typecheck lint test)

if [ -t 1 ]; then B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; D=$'\033[2m'; Z=$'\033[0m'
else B=''; R=''; G=''; D=''; Z=''; fi

started=$(date +%s)

for step in "${STEPS[@]}"; do
  printf '%s\n' "${B}▸ pnpm run ${step}${Z}"
  printf '\n===== pnpm run %s =====\n' "$step" >>"$LOG"

  # `pipefail` is what makes this line honest: without it the exit status would be
  # tee's (always 0) and every failure would pass the gate silently.
  step_started=$(date +%s)
  if pnpm run "$step" 2>&1 | tee -a "$LOG"; then
    printf '%s\n\n' "${G}✓ ${step}${Z} ${D}($(( $(date +%s) - step_started ))s)${Z}"
  else
    status=${PIPESTATUS[0]}
    printf '\n%s\n' "${R}${B}✗ pnpm run ${step} failed (exit ${status})${Z}"
    if [ "$TAIL_LINES" -gt 0 ]; then
      printf '%s\n' "${D}── last ${TAIL_LINES} lines ──────────────────────────────────${Z}"
      tail -n "$TAIL_LINES" "$LOG"
      printf '%s\n' "${D}──────────────────────────────────────────────────────${Z}"
    fi
    printf '%s\n' "full log: ${LOG}"
    exit "$status"
  fi
done

printf '%s\n' "${G}${B}✓ verify passed${Z} ${D}($(( $(date +%s) - started ))s — ${STEPS[*]})${Z}"
