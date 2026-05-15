#!/usr/bin/env bash
# Rollback helper for cc-remote-controller team-mode feature.
#
# Stops persistent Claude orchestrator processes spawned by the server and
# removes orphan ~/.claude/teams/* directories (always preserving "default").
# Safe to run while the server is stopped; not meant to run while the server
# is actively managing teams.
#
# Usage:
#   bash scripts/team-mode-rollback.sh           # interactive confirm
#   bash scripts/team-mode-rollback.sh --force   # no prompts
#
# This script does NOT touch:
#   - the database (db.sqlite) — restore manually if needed
#   - git state — use `git checkout main` separately
#   - ~/.claude/tasks/* — those may belong to non-team Claude sessions

set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

confirm() {
  if [[ $FORCE -eq 1 ]]; then return 0; fi
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

echo "== team-mode rollback =="

# 1. Find persistent claude processes (--input-format stream-json)
PIDS=$(pgrep -f 'claude .*--input-format stream-json' 2>/dev/null || true)
if [[ -n "$PIDS" ]]; then
  echo "Found persistent claude processes:"
  ps -fp $PIDS || true
  if confirm "Send SIGTERM to these processes?"; then
    kill $PIDS 2>/dev/null || true
    sleep 2
    # SIGKILL anything still alive
    REMAIN=$(pgrep -f 'claude .*--input-format stream-json' 2>/dev/null || true)
    if [[ -n "$REMAIN" ]]; then
      echo "Force killing: $REMAIN"
      kill -9 $REMAIN 2>/dev/null || true
    fi
  fi
else
  echo "No persistent claude processes found."
fi

# 2. Remove orphan team directories (preserve "default")
TEAMS_DIR="$HOME/.claude/teams"
if [[ -d "$TEAMS_DIR" ]]; then
  ORPHANS=$(find "$TEAMS_DIR" -mindepth 1 -maxdepth 1 -type d ! -name default -printf '%f\n' 2>/dev/null || true)
  if [[ -n "$ORPHANS" ]]; then
    echo "Orphan team directories under $TEAMS_DIR:"
    echo "$ORPHANS" | sed 's/^/  /'
    if confirm "Remove these orphan team directories?"; then
      while IFS= read -r name; do
        [[ -z "$name" ]] && continue
        rm -rf "$TEAMS_DIR/$name"
        echo "  removed: $name"
      done <<< "$ORPHANS"
    fi
  else
    echo "No orphan team directories."
  fi
fi

echo "Done. Server can now be restarted with the rolled-back code."
