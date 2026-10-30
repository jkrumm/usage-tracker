#!/usr/bin/env bash
# Render the daily prices-sync LaunchAgent plist and (re)load it. Idempotent. Separate from install-agent.sh: it
# never touches the 15-minute ingest agent (com.jkrumm.usage-tracker).
#
# No secret is written to the plist. `prices-sync` resolves the usage role's Postgres password itself, at spawn,
# through `secrets-run read` (src/pg/connect.ts), so the agent only needs ~/.local/bin on PATH and HOME set.
#
# USAGE_TRACKER_PRICES_PLIST overrides the output path and implies "do not touch launchd" (a dry render).
set -euo pipefail

LABEL="com.jkrumm.usage-tracker-prices"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun || true)"
PLIST="${USAGE_TRACKER_PRICES_PLIST:-$HOME/Library/LaunchAgents/${LABEL}.plist}"

if [[ -z "$BUN" ]]; then
  echo "error: bun not found on PATH" >&2
  exit 1
fi

JOBRUN="$HOME/.local/bin/jobrun"
if [[ ! -x "$JOBRUN" ]]; then
  echo "error: $JOBRUN missing — run 'make setup' in dotfiles" >&2
  exit 1
fi

SECRETS_RUN="$(command -v secrets-run || true)"
SECRETS_RUN="${SECRETS_RUN:-$HOME/.local/bin/secrets-run}"
PG_REF="op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD"

# Preflight only; the value is discarded. A failure is informational: the first scheduled run reports it.
if [[ -x "$SECRETS_RUN" ]] && "$SECRETS_RUN" read "$PG_REF" </dev/null >/dev/null 2>&1; then
  echo "prices-sync: $PG_REF resolves — the agent picks it up at spawn"
else
  echo "prices-sync: $PG_REF does not resolve yet — installing anyway; the run fails until the usage role is seeded" >&2
fi

mkdir -p "$(dirname "$PLIST")"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <!-- Daily under jobrun (state in ~/.local/state/jobs, graded by jobs-grade): --every 86400 is the cadence
         the grade expects, --timeout 300 the run deadline. -->
    <key>ProgramArguments</key>
    <array>
        <string>${JOBRUN}</string>
        <string>${LABEL}</string>
        <string>--owner</string>
        <string>usage-tracker</string>
        <string>--every</string>
        <string>86400</string>
        <string>--timeout</string>
        <string>300</string>
        <string>--</string>
        <string>${BUN}</string>
        <string>run</string>
        <string>${REPO}/src/cli.ts</string>
        <string>prices-sync</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO}</string>

    <!-- 04:20 local. Not RunAtLoad: installing must not fire a sync before the database is live. -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>4</integer>
        <key>Minute</key>
        <integer>20</integer>
    </dict>

    <!-- ~/Library/Logs, never /tmp (macOS sweeps it). -->
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/usage-tracker-prices.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/usage-tracker-prices.err</string>

    <!-- PATH and HOME are load-bearing: launchd starts an agent with no profile, secrets-run lives in
         ~/.local/bin and resolves its cache relative to HOME. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

plutil -lint "$TMP" >/dev/null
install -m 0600 "$TMP" "$PLIST"

if [[ -n "${USAGE_TRACKER_PRICES_PLIST:-}" ]]; then
  echo "rendered ${PLIST} (USAGE_TRACKER_PRICES_PLIST set — launchd untouched)"
  exit 0
fi

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed ${LABEL}"
echo "  plist:  ${PLIST}"
echo "  logs:   ${HOME}/Library/Logs/usage-tracker-prices.log  ${HOME}/Library/Logs/usage-tracker-prices.err"
echo "  daily:  04:20 local (prices-sync)"
