#!/usr/bin/env bash
# Render the usage-tracker LaunchAgent plist and (re)load it. Idempotent: safe
# to re-run after code changes.
#
# No secret lands in the plist. The Postgres URL (role `usage`, database `shared`)
# is built AT SPAWN by `usagePgUrl()` (src/pg/connect.ts), which reads the role's
# password through `secrets-run read` — so nothing is resolved at INSTALL time
# and the output is deterministic: re-running is a true no-op. `secrets-run`
# lives in ~/.local/bin, which the rendered PATH carries (launchd starts an agent
# with no shell profile). Set USAGE_PG_URL in the plist only to override.
#
# The plist content is owned by this script, deliberately with no separate
# template file: the no-secret-on-disk shape is a security invariant, not a
# layout preference.
#
# USAGE_TRACKER_PLIST overrides the output path, for rendering to a scratch
# file. It implies "do not touch launchd" — a dry render that boots the live
# agent out is the surprise the override exists to avoid.
set -euo pipefail

LABEL="com.jkrumm.usage-tracker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun || true)"
PLIST="${USAGE_TRACKER_PLIST:-$HOME/Library/LaunchAgents/${LABEL}.plist}"

if [[ -z "$BUN" ]]; then
  echo "error: bun not found on PATH" >&2
  exit 1
fi

JOBRUN="$HOME/.local/bin/jobrun"
if [[ ! -x "$JOBRUN" ]]; then
  echo "error: $JOBRUN missing — run 'make setup' in dotfiles" >&2
  exit 1
fi

# Absolute path, because launchd starts an agent with no shell profile and
# ~/.local/bin is not on its default PATH. The rendered plist pins PATH too.
SECRETS_RUN="$(command -v secrets-run || true)"
SECRETS_RUN="${SECRETS_RUN:-$HOME/.local/bin/secrets-run}"
PG_REF="op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD"

# Preflight only — the value is discarded, never stored and never rendered. A
# failure here is informational: the cache may be stale for a moment and the
# agent resolves the password again on every spawn. `</dev/null` so a backend
# that wants stdin can't wedge it.
if [[ -x "$SECRETS_RUN" ]]; then
  if "$SECRETS_RUN" read "$PG_REF" </dev/null >/dev/null 2>&1; then
    echo "postgres: $PG_REF resolves — the agent builds its URL at spawn"
  else
    echo "postgres: $PG_REF does not resolve — installing anyway; ingest fails until it does" >&2
  fi
else
  echo "postgres: no secrets-run at $SECRETS_RUN — installing anyway; ingest fails until it exists" >&2
fi

mkdir -p "$(dirname "$PLIST")"

# Write to a temp file first so a failed render can't truncate a live plist.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${JOBRUN}</string>
        <string>${LABEL}</string>
        <string>--owner</string>
        <string>usage-tracker</string>
        <string>--every</string>
        <string>900</string>
        <string>--timeout</string>
        <string>600</string>
        <string>--</string>
        <string>${BUN}</string>
        <string>run</string>
        <string>${REPO}/src/cli.ts</string>
        <string>ingest</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO}</string>

    <key>RunAtLoad</key>
    <true/>

    <!-- Incremental ingest every 15 minutes, under \`jobrun\` (dotfiles): each run
         is recorded in ~/.local/state/jobs and graded by \`jobs-grade\` (the
         heartbeat's \`jobs\` component), with a 10-minute
         deadline. That replaced the heartbeat's log-mtime check. -->
    <key>StartInterval</key>
    <integer>900</integer>

    <!-- ~/Library/Logs, not /tmp. macOS's periodic cleanup deletes files there
         untouched for 3+ days. An interval-driven agent re-creates its file
         each spawn so it never writes into an unlinked inode the way the
         KeepAlive agents do, but the history vanishes anyway. -->
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/usage-tracker.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/usage-tracker.err</string>

    <!-- PATH and HOME are load-bearing, not cosmetic: launchd starts an agent
         with no shell profile, \`secrets-run\` lives in ~/.local/bin (not on
         launchd's default PATH), and secrets-run resolves both the backend
         marker and the encrypted cache relative to \$HOME — without them the
         password read in usagePgUrl() fails and the run exits non-zero. -->
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
EOF

# Fail before touching $PLIST if the render is not a valid plist.
plutil -lint "$TMP" >/dev/null

# 0600 not because it holds a secret — it holds none — but because
# nothing other than launchd (running as this user) has any business reading it.
install -m 0600 "$TMP" "$PLIST"

if [[ -n "${USAGE_TRACKER_PLIST:-}" ]]; then
  echo "rendered ${PLIST} (USAGE_TRACKER_PLIST set — launchd untouched)"
  exit 0
fi

# Reload cleanly: bootout if already loaded, then bootstrap + kickstart.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "installed ${LABEL}"
echo "  plist:  ${PLIST}"
echo "  logs:   ${HOME}/Library/Logs/usage-tracker.log  ${HOME}/Library/Logs/usage-tracker.err"
echo "  every:  900s (incremental ingest into Postgres)"
