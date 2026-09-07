#!/usr/bin/env bash
# Render the usage-tracker LaunchAgent plist and (re)load it. Idempotent: safe
# to re-run after code changes.
#
# The Argo bearer is NOT baked in — the rendered plist resolves it AT SPAWN from
# the secrets cache via `secrets-run read`.
#
# This script used to substitute the token straight into <EnvironmentVariables>
# (`s|__ARGO_TOKEN__|${ARGO_TOKEN}|g`), so re-running it silently regressed a
# completed hardening: a plaintext bearer token on disk, on the machine whose
# entire secrets design is "no plaintext secret on the mini". launchd has no
# `EnvironmentFile=` equivalent, so the injection has to happen in a wrapper
# shell — same shape as the collie LaunchAgent, with `secrets-run read` in place
# of a plaintext .env so nothing lands on disk at all.
#
# Two consequences worth naming:
#   - The installer no longer needs the token in its own environment. Nothing is
#     resolved at INSTALL time; the value is resolved at RUN time, every spawn.
#   - The output is therefore deterministic, so re-running is a true no-op
#     instead of re-baking whatever the token happened to be that day.
#
# The plist content is owned by this script, deliberately with no separate
# template file: the no-plaintext-token shape is a security invariant, not a
# layout preference, and a template with an `__ARGO_TOKEN__` slot is exactly
# how it regressed (the old one also still logged to /tmp).
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

ARGO_REF="op://common/api/SECRET"
ARGO_URL="https://argo.jkrumm.com/api"

# Absolute path, because launchd starts an agent with no shell profile and
# ~/.local/bin is not on its default PATH. The rendered plist pins PATH too —
# belt and braces, since a PATH miss degrades silently to "sync disabled"
# rather than erroring.
SECRETS_RUN="$(command -v secrets-run || true)"
SECRETS_RUN="${SECRETS_RUN:-$HOME/.local/bin/secrets-run}"

# Preflight only — the value is discarded, never stored and never rendered. A
# failure here is informational: the local SQLite ingest runs fine without argo
# sync (src/sync.ts logs "sync disabled (no ARGO_TOKEN)"), so the install must
# not fail over it. `</dev/null` so a backend that wants stdin can't wedge it.
if [[ -x "$SECRETS_RUN" ]]; then
  if "$SECRETS_RUN" read "$ARGO_REF" </dev/null >/dev/null 2>&1; then
    echo "argo sync: $ARGO_REF resolves — the agent picks it up at spawn"
  else
    echo "argo sync: $ARGO_REF does not resolve — installing anyway; ingest runs without sync" >&2
  fi
else
  echo "argo sync: no secrets-run at $SECRETS_RUN — installing anyway; ingest runs without sync" >&2
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

    <!-- The Argo bearer is resolved AT SPAWN from the secrets cache, never
         baked into this file. It used to sit here in cleartext under
         EnvironmentVariables — on the machine whose entire secrets design is
         "no plaintext secret on disk". launchd has no \`EnvironmentFile=\`, so
         the injection has to happen in a wrapper shell; same shape as the
         collie LaunchAgent, with \`secrets-run read\` in place of a plaintext
         .env so nothing lands on disk at all.

         Degrades rather than fails: an unresolvable token disables argo sync
         and the local SQLite ingest runs on (src/sync.ts logs "sync disabled
         (no ARGO_TOKEN)"). That matches what the installer did at render time,
         so a stale cache does not become a telemetry outage. -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>T=\$(${SECRETS_RUN} read ${ARGO_REF} 2&gt;/dev/null) &amp;&amp; [ -n "\$T" ] &amp;&amp; export ARGO_TOKEN="\$T" || echo "usage-tracker: ARGO_TOKEN unresolvable via secrets-run (${ARGO_REF}) — argo sync disabled" &gt;&amp;2; exec ${BUN} run ${REPO}/src/cli.ts ingest</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${REPO}</string>

    <key>RunAtLoad</key>
    <true/>

    <!-- Incremental ingest every 15 minutes. -->
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
         marker and the encrypted cache relative to \$HOME — without it the read
         fails silently and the token degrades to empty. Verified by running the
         wrapper under \`env -i\` both ways. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>ARGO_URL</key>
        <string>${ARGO_URL}</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF

# Fail before touching $PLIST if the render is not a valid plist.
plutil -lint "$TMP" >/dev/null

# 0600 not because it holds a secret any more — it holds none — but because
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
echo "  every:  900s (incremental ingest)"
