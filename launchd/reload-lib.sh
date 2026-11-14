# Sourced by the install-*.sh scripts: reload_agent <label> <plist>.
#
# `launchctl bootout` returns before the job is gone. A bootstrap in that window
# fails ("Bootstrap failed: 5"), and under `set -e` the installer exited with
# nothing loaded — seen under host load (load avg 25-50 on 12 cpus), where it
# left the agent unloaded until a manual bootstrap. So: bootout, wait until the
# label has vanished, then bootstrap with retries until the label is loaded.
# Same shape dotfiles/scripts/pg-cutover.sh stop_job/start_job waits out.

reload_agent() {
  local label="$1" plist="$2" domain i
  domain="gui/$(id -u)"

  launchctl bootout "${domain}/${label}" 2>/dev/null || true
  for ((i = 0; i < 30; i++)); do
    launchctl print "${domain}/${label}" >/dev/null 2>&1 || break
    sleep 1
  done

  # The bootstrap exit status is the success signal, not "the label is loaded":
  # a stale job that outlived the wait above would satisfy the latter while the
  # new plist was never applied.
  for ((i = 0; i < 10; i++)); do
    launchctl bootstrap "${domain}" "$plist" 2>/dev/null && return 0
    sleep 2
  done

  echo "error: ${label} did not bootstrap after 10 attempts; last error:" >&2
  launchctl bootstrap "${domain}" "$plist" >&2 && return 0
  return 1
}
