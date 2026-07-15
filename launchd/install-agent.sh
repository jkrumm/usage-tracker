#!/usr/bin/env bash
# Render the LaunchAgent plist from the template and (re)load it.
# Idempotent: safe to re-run after code changes.
set -euo pipefail

LABEL="com.jkrumm.usage-tracker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ -z "$BUN" ]]; then
  echo "error: bun not found on PATH" >&2
  exit 1
fi

ARGO_URL="https://argo.jkrumm.com/api"
ARGO_TOKEN=""

if command -v secrets-run >/dev/null 2>&1; then
  if ! ARGO_TOKEN=$(secrets-run read "op://common/api/SECRET" 2>/dev/null); then
    echo "warning: could not read ARGO_TOKEN via secrets-run — sync will be disabled" >&2
  fi
else
  echo "warning: secrets-run not found — ARGO_TOKEN not set; sync will be disabled" >&2
fi

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|__BUN__|${BUN}|g" \
    -e "s|__REPO__|${REPO}|g" \
    -e "s|__ARGO_URL__|${ARGO_URL}|g" \
    -e "s|__ARGO_TOKEN__|${ARGO_TOKEN}|g" \
    "${REPO}/launchd/${LABEL}.plist.template" > "$PLIST"

chmod 600 "$PLIST"

# Reload cleanly: bootout if already loaded, then bootstrap + kickstart.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "installed ${LABEL}"
echo "  plist:  ${PLIST}"
echo "  logs:   /tmp/usage-tracker.log  /tmp/usage-tracker.err"
echo "  every:  900s (incremental ingest)"
