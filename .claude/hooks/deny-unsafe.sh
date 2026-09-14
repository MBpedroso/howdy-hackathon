#!/usr/bin/env bash
# PreToolUse hook for Bash: refuse the three commands CLAUDE.md says an agent never runs.
# Permission rules match by prefix only, so anything that can appear mid-command lives
# here. Reads the tool call as JSON on stdin; exit 2 blocks the call and shows the
# message to the model. Node is the one runtime this repo guarantees, so no jq.
set -euo pipefail

cmd="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch{}})')"

deny() {
  echo "blocked by .claude/hooks/deny-unsafe.sh: $1 — see CLAUDE.md (Spend / Done means)" >&2
  exit 2
}

# The spend switch is the human's, wherever it appears in the command line.
[[ "$cmd" == *REMATCH_ALLOW_SPEND=* ]] && deny "REMATCH_ALLOW_SPEND is a human-only switch"

# Skipping the pre-commit verify: long flag, or the short -n on a commit.
[[ "$cmd" =~ git[[:space:]].*commit.*(--no-verify|[[:space:]]-n([[:space:]]|$)) ]] && deny "--no-verify is the human's hatch, not an agent's"

# Rewriting shared history.
[[ "$cmd" =~ git[[:space:]].*push.*(--force|[[:space:]]-f([[:space:]]|$)) ]] && deny "force-push needs Matheus"

exit 0
