#!/usr/bin/env bash
# Render the weekly-report LaunchAgent plist and (re)load it. Idempotent. Separate from install-agent.sh and
# install-prices-agent.sh: it never touches the ingest or prices agents.
#
# No secret is written to the plist. `report` resolves the usage role's Postgres password itself, at spawn,
# through `secrets-run read` (src/pg/connect.ts), so the agent only needs ~/.local/bin on PATH and HOME set.
# The report holds no secret either (docs/usage-schema.md §Weekly report); Hermes delivers the written file.
#
# USAGE_TRACKER_REPORT_PLIST overrides the output path and implies "do not touch launchd" (a dry render).
set -euo pipefail

LABEL="com.jkrumm.usage-tracker-report"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun || true)"
REPORTS_DIR="${USAGE_TRACKER_REPORTS_DIR:-$HOME/.local/share/usage-tracker/reports}"
PLIST="${USAGE_TRACKER_REPORT_PLIST:-$HOME/Library/LaunchAgents/${LABEL}.plist}"

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
  echo "weekly report: $PG_REF resolves — the agent picks it up at spawn"
else
  echo "weekly report: $PG_REF does not resolve yet — installing anyway; the run fails until the usage role is seeded" >&2
fi

mkdir -p "$(dirname "$PLIST")" "$REPORTS_DIR"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <!-- Weekly under jobrun (state in ~/.local/state/jobs, graded by jobs-grade): --every 604800 is the cadence
         the grade expects, --timeout 300 the run deadline. -->
    <key>ProgramArguments</key>
    <array>
        <string>${JOBRUN}</string>
        <string>${LABEL}</string>
        <string>--owner</string>
        <string>usage-tracker</string>
        <string>--every</string>
        <string>604800</string>
        <string>--timeout</string>
        <string>300</string>
        <string>--</string>
        <string>${BUN}</string>
        <string>run</string>
        <string>${REPO}/src/cli.ts</string>
        <string>report</string>
        <string>weekly</string>
        <string>--out</string>
        <string>${REPORTS_DIR}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO}</string>

    <!-- Monday 07:00 local: the week that just ended. Not RunAtLoad: installing must not write a report before the
         database is live. A Mac asleep at 07:00 runs it on wake (launchd coalesces a missed calendar interval). -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>1</integer>
        <key>Hour</key>
        <integer>7</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>

    <!-- ~/Library/Logs, never /tmp (macOS sweeps it). -->
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/usage-tracker-report.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/usage-tracker-report.err</string>

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

if [[ -n "${USAGE_TRACKER_REPORT_PLIST:-}" ]]; then
  echo "rendered ${PLIST} (USAGE_TRACKER_REPORT_PLIST set — launchd untouched)"
  exit 0
fi

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "installed ${LABEL}"
echo "  plist:  ${PLIST}"
echo "  logs:   ${HOME}/Library/Logs/usage-tracker-report.log  ${HOME}/Library/Logs/usage-tracker-report.err"
echo "  weekly: Monday 07:00 local (report weekly --out ${REPORTS_DIR})"
